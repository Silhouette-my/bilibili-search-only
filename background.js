importScripts(
  'lockShared.js',
  'runtimeCore.js',
  'storageSchema.js',
  'runtimeContracts.js'
);

const {
  FEATURE_KEYS,
  DEFAULT_LOCK_CONFIG,
  DEFAULT_FOCUS_SESSION,
  ensureFeaturePreferences,
  ensureFeatureOverrideDisabled,
  ensureLockConfig,
  ensureAppearanceConfig,
  ensurePlayerShortcutConfig,
  ensureFocusSession,
  ensureUsageState,
  ensureLockStatus,
  ensureEffectiveFeatureState,
  REDIRECT_TARGET_URL,
  isBilibiliUrl,
  isRedirectCandidateUrl
} = globalThis.BiliFocusShared;
const {
  restoreProtectedLockConfig,
  getCurrentStrictGuardStatus,
  pruneUsageState,
  evaluateRuntimeState
} = globalThis.BiliFocusRuntimeCore;
const {
  CONFIG_SCHEMA_VERSION,
  CONFIG_SCHEMA_VERSION_KEY,
  RUNTIME_SCHEMA_VERSION,
  RUNTIME_SCHEMA_VERSION_KEY,
  migrateStorageState
} = globalThis.BiliFocusStorageSchema;
const {
  MESSAGE_TYPES,
  ERROR_CODES,
  isRecord,
  createSuccessResponse,
  createErrorResponse
} = globalThis.BiliFocusContracts;

const LOCAL_KEYS = [
  'effectiveFeatureState',
  'lockStatus',
  'focusSession',
  'usageState',
  'siteBlockOverrideDisabled',
  'featureOverrideDisabled',
  'strictConfigSnapshot',
  'strictFeaturePreferencesSnapshot',
  'stateRevision',
  RUNTIME_SCHEMA_VERSION_KEY
];
const SYNC_KEYS = [
  ...FEATURE_KEYS,
  'lockConfig',
  'appearanceConfig',
  'playerShortcutConfig',
  CONFIG_SCHEMA_VERSION_KEY
];
const EVALUATE_ALARM = 'bili-focus-evaluate';
const STATE_BOUNDARY_ALARM = 'bili-focus-state-boundary';
const BLOCKED_PAGE_URL = chrome.runtime.getURL('blocked.html');
const BLOCKED_RETURN_KEY_PREFIX = 'blockedReturnUrl:';
const EXTENSION_URL = new URL(chrome.runtime.getURL('/'));

let runtimeInitializationPromise = null;
let runtimeStateOperationTail = Promise.resolve();
let runtimeRefreshBatch = null;
let latestRuntimeSnapshot = null;
const navigationCheckStateByTab = new Map();

function requireSupportedStorageMigration(migration) {
  const unsupportedConfig = migration.unsupportedFutureVersion.config;
  const unsupportedRuntime = migration.unsupportedFutureVersion.runtime;

  if (unsupportedConfig === null && unsupportedRuntime === null) return;

  throw createCommandError(
    ERROR_CODES.UNSUPPORTED_SCHEMA,
    '检测到由更新版本创建的设置数据；为避免降级覆盖，当前版本已停止写入。'
  );
}

async function ensureDefaults() {
  const [syncState, localState] = await Promise.all([
    chrome.storage.sync.get(SYNC_KEYS),
    chrome.storage.local.get(LOCAL_KEYS)
  ]);
  const migration = migrateStorageState(syncState, localState);
  requireSupportedStorageMigration(migration);

  await Promise.all([
    Object.keys(migration.syncUpdates).length
      ? chrome.storage.sync.set(migration.syncUpdates)
      : Promise.resolve(),
    Object.keys(migration.localUpdates).length
      ? chrome.storage.local.set(migration.localUpdates)
      : Promise.resolve()
  ]);
}

async function ensureAlarm() {
  const alarm = await chrome.alarms.get(EVALUATE_ALARM);
  if (!alarm) {
    await chrome.alarms.create(EVALUATE_ALARM, { periodInMinutes: 1 });
  }
}

async function scheduleNextStateBoundary(nextBoundaryAt) {
  if (!nextBoundaryAt) {
    if (typeof chrome.alarms.clear === 'function') {
      await chrome.alarms.clear(STATE_BOUNDARY_ALARM);
    }
    return null;
  }

  const existing = await chrome.alarms.get(STATE_BOUNDARY_ALARM);
  if (
    existing &&
    Number.isFinite(existing.scheduledTime) &&
    Math.abs(existing.scheduledTime - nextBoundaryAt) < 500
  ) {
    return nextBoundaryAt;
  }

  await chrome.alarms.create(STATE_BOUNDARY_ALARM, {
    when: Math.max(Date.now() + 1000, nextBoundaryAt)
  });
  return nextBoundaryAt;
}

function ensureRuntimeInitialized() {
  if (!runtimeInitializationPromise) {
    runtimeInitializationPromise = Promise.all([ensureDefaults(), ensureAlarm()])
      .catch((error) => {
        runtimeInitializationPromise = null;
        throw error;
      });
  }

  return runtimeInitializationPromise;
}

function enqueueRuntimeStateOperation(operation) {
  const result = runtimeStateOperationTail.then(operation);
  runtimeStateOperationTail = result.catch(() => null);
  return result;
}

async function enforceStrictConfigIntegrity(changes) {
  if (!changes.lockConfig) return false;

  const [syncMetadata, localState] = await Promise.all([
    chrome.storage.sync.get([CONFIG_SCHEMA_VERSION_KEY]),
    chrome.storage.local.get([
      'focusSession',
      'usageState',
      'strictConfigSnapshot',
      RUNTIME_SCHEMA_VERSION_KEY
    ])
  ]);
  if (
    Number(syncMetadata[CONFIG_SCHEMA_VERSION_KEY]) > CONFIG_SCHEMA_VERSION ||
    Number(localState[RUNTIME_SCHEMA_VERSION_KEY]) > RUNTIME_SCHEMA_VERSION
  ) {
    throw createCommandError(
      ERROR_CODES.UNSUPPORTED_SCHEMA,
      '检测到由更新版本创建的设置数据；当前版本不会修复或覆盖这些数据。'
    );
  }

  const baseline = localState.strictConfigSnapshot ||
    changes.lockConfig.oldValue ||
    DEFAULT_LOCK_CONFIG;
  const proposed = changes.lockConfig.newValue || DEFAULT_LOCK_CONFIG;
  const guardStatus = getCurrentStrictGuardStatus(
    new Date(),
    baseline,
    localState.focusSession,
    localState.usageState
  );
  const { config, corrected } = restoreProtectedLockConfig(
    baseline,
    proposed,
    guardStatus
  );

  if (!corrected) return false;

  await chrome.storage.sync.set({ lockConfig: config });
  return true;
}

function normalizeStateRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

function createRuntimeSnapshot({
  revision,
  featurePreferences,
  appearanceConfig,
  playerShortcutConfig,
  lockConfig,
  effectiveFeatureState,
  lockStatus,
  focusSession,
  usageState,
  siteBlockOverrideDisabled,
  featureOverrideDisabled
}) {
  return {
    revision: normalizeStateRevision(revision),
    featurePreferences: ensureFeaturePreferences(featurePreferences),
    appearanceConfig: ensureAppearanceConfig(appearanceConfig),
    playerShortcutConfig: ensurePlayerShortcutConfig(playerShortcutConfig),
    lockConfig: ensureLockConfig(lockConfig),
    effectiveFeatureState: ensureEffectiveFeatureState(effectiveFeatureState),
    lockStatus: ensureLockStatus(lockStatus),
    focusSession: ensureFocusSession(focusSession),
    usageState: ensureUsageState(usageState),
    siteBlockOverrideDisabled: Boolean(siteBlockOverrideDisabled),
    featureOverrideDisabled: ensureFeatureOverrideDisabled(featureOverrideDisabled)
  };
}

function getBlockedReturnKey(tabId) {
  return `${BLOCKED_RETURN_KEY_PREFIX}${tabId}`;
}

function getSessionStorage() {
  return chrome.storage.session;
}

async function rememberBlockedReturnUrl(tabId, rawUrl) {
  if (!Number.isInteger(tabId) || !isBilibiliUrl(rawUrl)) return;
  await getSessionStorage().set({ [getBlockedReturnKey(tabId)]: rawUrl });
}

async function getBlockedReturnUrl(tabId) {
  const key = getBlockedReturnKey(tabId);
  const result = await getSessionStorage().get([key]);
  return isBilibiliUrl(result[key]) ? result[key] : null;
}

async function clearBlockedReturnUrl(tabId) {
  await getSessionStorage().remove(getBlockedReturnKey(tabId));
}

function isBlockedPageUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === EXTENSION_URL.protocol &&
      url.hostname === EXTENSION_URL.hostname &&
      url.pathname === '/blocked.html'
    );
  } catch (error) {
    return false;
  }
}

function isTrustedExtensionPageSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id || typeof sender.url !== 'string') {
    return false;
  }

  try {
    const url = new URL(sender.url);
    return (
      url.protocol === EXTENSION_URL.protocol &&
      url.hostname === EXTENSION_URL.hostname
    );
  } catch (error) {
    return false;
  }
}

function getCurrentTabUrl(tab, fallbackUrl) {
  return tab && (tab.pendingUrl || tab.url) || fallbackUrl || '';
}

async function navigateTabToBlockedPage(tabId, returnUrl, isCurrentRequest = () => true) {
  if (!Number.isInteger(tabId) || !isBilibiliUrl(returnUrl) || !isCurrentRequest()) return false;
  await rememberBlockedReturnUrl(tabId, returnUrl);
  if (!isCurrentRequest()) return false;
  await chrome.tabs.update(tabId, { url: BLOCKED_PAGE_URL });
  return true;
}

async function enforceNavigationPolicyForTab(
  tabId,
  fallbackUrl,
  isCurrentRequest = () => true
) {
  if (!Number.isInteger(tabId) || !isCurrentRequest()) return false;

  const effectiveFeatureState = latestRuntimeSnapshot
    ? latestRuntimeSnapshot.effectiveFeatureState
    : ensureEffectiveFeatureState(
      (await chrome.storage.local.get(['effectiveFeatureState'])).effectiveFeatureState
    );
  if (!isCurrentRequest()) return false;

  const tab = await chrome.tabs.get(tabId);
  if (!isCurrentRequest()) return false;

  const currentUrl = getCurrentTabUrl(tab, fallbackUrl);
  if (!isBilibiliUrl(currentUrl)) return false;

  if (effectiveFeatureState.siteBlockEnabled) {
    return navigateTabToBlockedPage(tabId, currentUrl, isCurrentRequest);
  }

  if (
    effectiveFeatureState.redirectEnabled !== false &&
    isRedirectCandidateUrl(currentUrl) &&
    isCurrentRequest()
  ) {
    await chrome.tabs.update(tabId, { url: REDIRECT_TARGET_URL });
    return true;
  }

  return false;
}

function scheduleNavigationPolicyCheck(tabId, fallbackUrl) {
  if (!Number.isInteger(tabId)) return Promise.resolve(false);

  let state = navigationCheckStateByTab.get(tabId);
  if (state) {
    state.latestUrl = fallbackUrl || state.latestUrl;
    state.version += 1;
    return state.promise;
  }

  state = {
    latestUrl: fallbackUrl || '',
    version: 1,
    promise: null
  };

  state.promise = (async () => {
    let handled = false;
    let processedVersion = 0;

    while (processedVersion !== state.version) {
      const version = state.version;
      const fallback = state.latestUrl;
      handled = await enforceNavigationPolicyForTab(
        tabId,
        fallback,
        () => state.version === version
      ) || handled;
      processedVersion = version;
    }

    return handled;
  })().finally(() => {
    if (navigationCheckStateByTab.get(tabId) === state) {
      navigationCheckStateByTab.delete(tabId);
    }
  });

  navigationCheckStateByTab.set(tabId, state);
  return state.promise;
}

async function blockOpenBilibiliTabs() {
  const tabs = await chrome.tabs.query({ url: ['*://*.bilibili.com/*'] });
  await Promise.all(
    tabs
      .filter((tab) => Number.isInteger(tab.id) && isBilibiliUrl(tab.url))
      .map((tab) => scheduleNavigationPolicyCheck(tab.id, tab.url).catch(() => false))
  );
}

async function resumeBlockedTab(sender) {
  if (
    !isTrustedExtensionPageSender(sender) ||
    !sender.tab ||
    !Number.isInteger(sender.tab.id) ||
    !isBlockedPageUrl(sender.url)
  ) {
    throw new Error('Blocked tab resume request is not authorized.');
  }

  const tabId = sender.tab.id;
  const [localState, tab, returnUrl] = await Promise.all([
    chrome.storage.local.get(['effectiveFeatureState']),
    chrome.tabs.get(tabId),
    getBlockedReturnUrl(tabId)
  ]);
  const effectiveFeatureState = ensureEffectiveFeatureState(localState.effectiveFeatureState);
  const currentUrl = getCurrentTabUrl(tab, sender.url);

  if (effectiveFeatureState.siteBlockEnabled) {
    throw new Error('Site blocking is still active.');
  }
  if (!isBlockedPageUrl(currentUrl)) {
    throw new Error('The sender tab is no longer on the blocked page.');
  }

  const safeReturnUrl = returnUrl || REDIRECT_TARGET_URL;
  const destination = (
    effectiveFeatureState.redirectEnabled !== false &&
    isRedirectCandidateUrl(safeReturnUrl)
  )
    ? REDIRECT_TARGET_URL
    : safeReturnUrl;

  if (!isBilibiliUrl(destination)) {
    throw new Error('Blocked tab return URL is not allowed.');
  }

  await chrome.tabs.update(tabId, { url: destination });
  await clearBlockedReturnUrl(tabId);
  return { resumed: true, destination };
}

async function refreshRuntimeStateNow(options = {}) {
  await ensureRuntimeInitialized();

  const [syncState, localState] = await Promise.all([
    chrome.storage.sync.get(SYNC_KEYS),
    chrome.storage.local.get(LOCAL_KEYS)
  ]);
  const migration = migrateStorageState(syncState, localState);
  requireSupportedStorageMigration(migration);

  const evaluation = evaluateRuntimeState({
    now: new Date(),
    syncState: migration.sync,
    localState: migration.local,
    forceBlockOpenTabs: Boolean(options.forceBlockOpenTabs)
  });
  const syncUpdates = {
    ...migration.syncUpdates,
    ...evaluation.syncUpdates
  };
  const localUpdates = {
    ...migration.localUpdates,
    ...evaluation.localUpdates
  };
  let stateRevision = normalizeStateRevision(migration.local.stateRevision);
  const stateChanged = (
    Boolean(options.forceRevision) ||
    Object.keys(syncUpdates).length > 0 ||
    Object.keys(localUpdates).length > 0
  );

  if (stateChanged) {
    stateRevision += 1;
    localUpdates.stateRevision = stateRevision;
  }

  await Promise.all([
    Object.keys(syncUpdates).length
      ? chrome.storage.sync.set(syncUpdates)
      : Promise.resolve(),
    Object.keys(localUpdates).length
      ? chrome.storage.local.set(localUpdates)
      : Promise.resolve()
  ]);

  latestRuntimeSnapshot = createRuntimeSnapshot({
    revision: stateRevision,
    featurePreferences: evaluation.featurePreferences,
    appearanceConfig: migration.sync.appearanceConfig,
    playerShortcutConfig: migration.sync.playerShortcutConfig,
    lockConfig: evaluation.lockConfig,
    effectiveFeatureState: evaluation.effectiveFeatureState,
    lockStatus: evaluation.lockStatus,
    focusSession: evaluation.focusSession,
    usageState: evaluation.usageState,
    siteBlockOverrideDisabled:
      evaluation.desiredLocalState.siteBlockOverrideDisabled,
    featureOverrideDisabled:
      evaluation.desiredLocalState.featureOverrideDisabled
  });

  if (evaluation.effects.blockOpenBilibiliTabs) {
    await blockOpenBilibiliTabs();
  }

  await scheduleNextStateBoundary(evaluation.effects.nextRuntimeBoundaryAt);

  return latestRuntimeSnapshot;
}

function refreshRuntimeState(options = {}) {
  if (runtimeRefreshBatch) {
    if (!runtimeRefreshBatch.options) {
      runtimeRefreshBatch.options = {
        forceBlockOpenTabs: Boolean(options.forceBlockOpenTabs)
      };
    } else {
      runtimeRefreshBatch.options.forceBlockOpenTabs =
        runtimeRefreshBatch.options.forceBlockOpenTabs || Boolean(options.forceBlockOpenTabs);
    }
    return runtimeRefreshBatch.promise;
  }

  const batch = {
    options: {
      forceBlockOpenTabs: Boolean(options.forceBlockOpenTabs)
    },
    promise: null
  };

  batch.promise = enqueueRuntimeStateOperation(async () => {
    let snapshot = null;

    while (batch.options) {
      const nextOptions = batch.options;
      batch.options = null;
      snapshot = await refreshRuntimeStateNow(nextOptions);
    }

    return snapshot;
  }).finally(() => {
    if (runtimeRefreshBatch === batch) {
      runtimeRefreshBatch = null;
    }
  });

  runtimeRefreshBatch = batch;
  return batch.promise;
}

function createCommandError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireTrustedExtensionSender(sender) {
  if (!isTrustedExtensionPageSender(sender)) {
    throw createCommandError(
      ERROR_CODES.NOT_AUTHORIZED,
      '此操作仅允许由扩展页面发起。'
    );
  }
}

function requireCurrentRevision(message, snapshot, canAcceptStale = null) {
  if (!isRecord(message) || message.baseRevision === undefined || message.baseRevision === null) {
    return;
  }

  const expected = Number(message.baseRevision);
  const acceptsStale = (
    Number.isSafeInteger(expected) &&
    expected >= 0 &&
    expected !== snapshot.revision &&
    typeof canAcceptStale === 'function' &&
    canAcceptStale()
  );
  if (
    !Number.isSafeInteger(expected) ||
    expected < 0 ||
    (expected !== snapshot.revision && !acceptsStale)
  ) {
    throw createCommandError(
      ERROR_CODES.CONFLICT,
      '状态已更新，请刷新后重试。'
    );
  }
}

async function getRuntimeSnapshotNow(forceRefresh = false) {
  if (!forceRefresh && latestRuntimeSnapshot) {
    return latestRuntimeSnapshot;
  }
  return refreshRuntimeStateNow({ forceBlockOpenTabs: false });
}

function updateFeaturePreference(message, sender) {
  return enqueueRuntimeStateOperation(async () => {
    requireTrustedExtensionSender(sender);
    if (!FEATURE_KEYS.includes(message.key) || typeof message.value !== 'boolean') {
      throw createCommandError(
        ERROR_CODES.INVALID_REQUEST,
        '功能开关参数无效。'
      );
    }

    const snapshot = await getRuntimeSnapshotNow(true);
    requireCurrentRevision(message, snapshot, () => (
      typeof message.basePreferenceValue === 'boolean' &&
      snapshot.featurePreferences[message.key] === message.basePreferenceValue
    ));

    const featureSelectedForLock =
      snapshot.lockConfig.lockedFeatureKeys.includes(message.key);
    const featureLockTriggered =
      snapshot.lockStatus.restrictionTriggered && featureSelectedForLock;

    if (featureLockTriggered && snapshot.lockStatus.panelLocked) {
      throw createCommandError(
        ERROR_CODES.POLICY_REJECTED,
        '严格模式生效时不能修改已锁定的功能。'
      );
    }

    if (featureLockTriggered && !snapshot.lockStatus.strictModeEnabled) {
      const featureOverrideDisabled = ensureFeatureOverrideDisabled({
        ...snapshot.featureOverrideDisabled,
        [message.key]: message.value === false
      });
      latestRuntimeSnapshot = null;
      await chrome.storage.local.set({
        featureOverrideDisabled,
        siteBlockOverrideDisabled: featureOverrideDisabled.siteBlockEnabled
      });
      return refreshRuntimeStateNow({
        forceRevision: true,
        forceBlockOpenTabs: message.key === 'siteBlockEnabled' && message.value
      });
    }

    latestRuntimeSnapshot = null;
    await chrome.storage.sync.set({ [message.key]: message.value });
    return refreshRuntimeStateNow({
      forceRevision: true,
      forceBlockOpenTabs: message.key === 'siteBlockEnabled' && message.value
    });
  });
}

function saveSettings(message, sender) {
  return enqueueRuntimeStateOperation(async () => {
    requireTrustedExtensionSender(sender);
    if (
      !isRecord(message.lockConfig) ||
      !isRecord(message.appearanceConfig) ||
      !isRecord(message.playerShortcutConfig)
    ) {
      throw createCommandError(
        ERROR_CODES.INVALID_REQUEST,
        '设置内容格式无效。'
      );
    }

    const snapshot = await getRuntimeSnapshotNow(true);
    requireCurrentRevision(message, snapshot, () => (
      typeof message.baseSettingsSignature === 'string' &&
      message.baseSettingsSignature === JSON.stringify({
        lockConfig: snapshot.lockConfig,
        appearanceConfig: snapshot.appearanceConfig,
        playerShortcutConfig: snapshot.playerShortcutConfig
      })
    ));

    const nextLockConfig = ensureLockConfig(message.lockConfig);
    const nextAppearanceConfig = ensureAppearanceConfig(message.appearanceConfig);
    const nextPlayerShortcutConfig = ensurePlayerShortcutConfig(
      message.playerShortcutConfig
    );
    const guarded = restoreProtectedLockConfig(
      snapshot.lockConfig,
      nextLockConfig,
      snapshot.lockStatus
    );

    if (guarded.corrected) {
      throw createCommandError(
        ERROR_CODES.POLICY_REJECTED,
        '当前严格限制保护了部分规则，请在限制结束后再修改。'
      );
    }

    latestRuntimeSnapshot = null;
    await chrome.storage.sync.set({
      lockConfig: guarded.config,
      appearanceConfig: nextAppearanceConfig,
      playerShortcutConfig: nextPlayerShortcutConfig
    });
    return refreshRuntimeStateNow({
      forceBlockOpenTabs: true,
      forceRevision: true
    });
  });
}

function setSiteBlockOverride(message, sender) {
  return enqueueRuntimeStateOperation(async () => {
    requireTrustedExtensionSender(sender);
    const snapshot = await getRuntimeSnapshotNow(true);
    requireCurrentRevision(message, snapshot);

    if (typeof message.disabled !== 'boolean') {
      throw createCommandError(
        ERROR_CODES.INVALID_REQUEST,
        '站点封锁临时开关参数无效。'
      );
    }
    if (message.disabled && !snapshot.lockStatus.overrideAllowed) {
      throw createCommandError(
        ERROR_CODES.POLICY_REJECTED,
        '当前策略不允许临时关闭站点封锁。'
      );
    }

    const featureOverrideDisabled = ensureFeatureOverrideDisabled({
      ...snapshot.featureOverrideDisabled,
      siteBlockEnabled: message.disabled
    });
    latestRuntimeSnapshot = null;
    await chrome.storage.local.set({
      siteBlockOverrideDisabled: message.disabled,
      featureOverrideDisabled
    });
    return refreshRuntimeStateNow({
      forceBlockOpenTabs: !message.disabled,
      forceRevision: true
    });
  });
}

function startFocusSession(minutes, baseRevision = null) {
  return enqueueRuntimeStateOperation(async () => {
    const snapshot = await getRuntimeSnapshotNow(true);
    requireCurrentRevision({ baseRevision }, snapshot);
    const safeMinutes = Math.min(24 * 60, Math.max(1, Number(minutes) || 0));
    const now = Date.now();
    const { focusSession: rawFocusSession } = await chrome.storage.local.get(['focusSession']);
    const focusSession = ensureFocusSession(rawFocusSession);

    if (focusSession.endsAt && focusSession.endsAt > now) {
      return refreshRuntimeStateNow();
    }

    latestRuntimeSnapshot = null;
    await chrome.storage.local.set({
      focusSession: {
        startedAt: now,
        endsAt: now + safeMinutes * 60 * 1000
      }
    });

    return refreshRuntimeStateNow({ forceRevision: true });
  });
}

function stopFocusSession(baseRevision = null) {
  return enqueueRuntimeStateOperation(async () => {
    const snapshot = await getRuntimeSnapshotNow(true);
    requireCurrentRevision({ baseRevision }, snapshot);
    const [syncState, localState] = await Promise.all([
      chrome.storage.sync.get(['lockConfig']),
      chrome.storage.local.get(['focusSession', 'lockStatus', 'strictConfigSnapshot'])
    ]);
    const focusSession = ensureFocusSession(localState.focusSession);
    const lockStatus = ensureLockStatus(localState.lockStatus);
    const proposedLockConfig = ensureLockConfig(syncState.lockConfig);
    const lockConfig = localState.strictConfigSnapshot
      ? restoreProtectedLockConfig(
        localState.strictConfigSnapshot,
        proposedLockConfig,
        lockStatus
      ).config
      : proposedLockConfig;
    const focusActive = Boolean(focusSession.endsAt && focusSession.endsAt > Date.now());

    if (
      focusActive &&
      lockConfig.strictModeEnabled &&
      lockConfig.blockConditions.focus
    ) {
      throw new Error('Strict mode does not allow stopping the active focus session.');
    }

    latestRuntimeSnapshot = null;
    await chrome.storage.local.set({ focusSession: { ...DEFAULT_FOCUS_SESSION } });
    return refreshRuntimeStateNow({ forceRevision: true });
  });
}

function recordActivityPing(sender, options = {}) {
  return enqueueRuntimeStateOperation(async () => {
    const tabId = sender.tab && sender.tab.id;
    const senderUrl = sender.url || sender.tab && sender.tab.url;
    if (!Number.isInteger(tabId) || !isBilibiliUrl(senderUrl)) {
      return getRuntimeSnapshotNow(false);
    }

    const snapshot = await getRuntimeSnapshotNow(false);
    const localState = await chrome.storage.local.get([
      'focusSession',
      'lockStatus',
      RUNTIME_SCHEMA_VERSION_KEY,
      'strictConfigSnapshot',
      'usageState'
    ]);
    if (Number(localState[RUNTIME_SCHEMA_VERSION_KEY]) > RUNTIME_SCHEMA_VERSION) {
      throw createCommandError(
        ERROR_CODES.UNSUPPORTED_SCHEMA,
        '检测到由更新版本创建的运行状态；当前版本不会覆盖这些数据。'
      );
    }
    const previousUsageState = ensureUsageState(localState.usageState);
    const now = new Date();
    const proposedLockConfig = ensureLockConfig(snapshot.lockConfig);
    const guardStatus = localState.strictConfigSnapshot
      ? getCurrentStrictGuardStatus(
        now,
        localState.strictConfigSnapshot,
        localState.focusSession,
        previousUsageState
      )
      : null;
    const lockConfig = guardStatus
      ? restoreProtectedLockConfig(
        localState.strictConfigSnapshot,
        proposedLockConfig,
        guardStatus
      ).config
      : proposedLockConfig;
    const { usageState, dailyInfo } = pruneUsageState(
      now,
      previousUsageState,
      lockConfig.dailyUsageLimit.resetMinutesAfterMidnight
    );
    const logicalDayChanged = previousUsageState.dayKey !== dailyInfo.dayKey;
    const dailyLimitMs = lockConfig.dailyUsageLimit.limitMinutes * 60 * 1000;
    const wasDailyLimitExceeded = Boolean(
      lockConfig.dailyUsageLimit.enabled &&
      !logicalDayChanged &&
      previousUsageState.accumulatedMs >= dailyLimitMs
    );

    const lastPing = Number(usageState.lastPingByTab[tabId]);
    let deltaMs = 0;
    if (Number.isFinite(lastPing)) {
      deltaMs = Math.min(Math.max(0, now.getTime() - lastPing), 30 * 1000);
    }

    usageState.dayKey = dailyInfo.dayKey;
    usageState.lastPingByTab[tabId] = now.getTime();
    usageState.accumulatedMs += deltaMs;

    const dailyLimitExceeded = Boolean(
      lockConfig.dailyUsageLimit.enabled &&
      usageState.accumulatedMs >= dailyLimitMs
    );
    if (dailyLimitExceeded) {
      usageState.exceeded = true;
      if (!usageState.limitExceededAt) {
        usageState.limitExceededAt = now.getTime();
      }
    } else {
      usageState.exceeded = false;
      usageState.limitExceededAt = null;
    }

    await chrome.storage.local.set({ usageState });
    const crossedDailyLimit = !wasDailyLimitExceeded && dailyLimitExceeded;

    if (logicalDayChanged || crossedDailyLimit) {
      return refreshRuntimeStateNow({ forceBlockOpenTabs: crossedDailyLimit });
    }

    latestRuntimeSnapshot = {
      ...snapshot,
      usageState: ensureUsageState(usageState)
    };

    if (options.final === true) {
      return latestRuntimeSnapshot;
    }

    return latestRuntimeSnapshot;
  });
}

chrome.runtime.onInstalled.addListener(() => {
  refreshRuntimeState({ forceBlockOpenTabs: true }).catch(() => null);
});

chrome.runtime.onStartup.addListener(() => {
  refreshRuntimeState({ forceBlockOpenTabs: true }).catch(() => null);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === EVALUATE_ALARM || alarm.name === STATE_BOUNDARY_ALARM) {
    refreshRuntimeState({
      forceBlockOpenTabs: alarm.name === STATE_BOUNDARY_ALARM
    }).catch(() => null);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync') {
    if (SYNC_KEYS.some((key) => Object.prototype.hasOwnProperty.call(changes, key))) {
      latestRuntimeSnapshot = null;
      enqueueRuntimeStateOperation(async () => {
        const repaired = await enforceStrictConfigIntegrity(changes);
        if (!repaired) {
          await refreshRuntimeStateNow({ forceBlockOpenTabs: true });
        }
      }).catch(() => null);
    }
    return;
  }

  if (
    areaName === 'local' &&
    Object.prototype.hasOwnProperty.call(changes, RUNTIME_SCHEMA_VERSION_KEY)
  ) {
    latestRuntimeSnapshot = null;
    enqueueRuntimeStateOperation(() => (
      refreshRuntimeStateNow({ forceBlockOpenTabs: false })
    )).catch(() => null);
  }
});

function handleNavigationEvent(details) {
  if (!details || details.frameId !== 0 || !Number.isInteger(details.tabId)) return;

  if (!isBilibiliUrl(details.url)) {
    const pendingState = navigationCheckStateByTab.get(details.tabId);
    if (pendingState) {
      pendingState.latestUrl = details.url || pendingState.latestUrl;
      pendingState.version += 1;
    }
    return;
  }

  const runtimeReady = latestRuntimeSnapshot
    ? Promise.resolve(latestRuntimeSnapshot)
    : refreshRuntimeState({ forceBlockOpenTabs: false });

  return runtimeReady
    .then(() => scheduleNavigationPolicyCheck(details.tabId, details.url))
    .catch(() => false);
}

chrome.webNavigation.onBeforeNavigate.addListener(handleNavigationEvent);
chrome.webNavigation.onHistoryStateUpdated.addListener(handleNavigationEvent);

chrome.tabs.onRemoved.addListener((tabId) => {
  navigationCheckStateByTab.delete(tabId);
  clearBlockedReturnUrl(tabId).catch(() => null);
});

function respondWithSnapshot(promise, sendResponse) {
  Promise.resolve(promise)
    .then((snapshot) => {
      sendResponse(createSuccessResponse(snapshot || latestRuntimeSnapshot));
    })
    .catch((error) => {
      sendResponse(createErrorResponse(
        error.code || ERROR_CODES.INTERNAL_ERROR,
        error.message,
        latestRuntimeSnapshot
      ));
    });
  return true;
}

function respondWithResult(promise, sendResponse) {
  Promise.resolve(promise)
    .then((result) => {
      sendResponse(createSuccessResponse(latestRuntimeSnapshot, result));
    })
    .catch((error) => {
      sendResponse(createErrorResponse(
        error.code || ERROR_CODES.INTERNAL_ERROR,
        error.message,
        latestRuntimeSnapshot
      ));
    });
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isRecord(message) || typeof message.type !== 'string') return undefined;

  if (message.type === MESSAGE_TYPES.GET_STATE) {
    const snapshotPromise = message.refresh === false && latestRuntimeSnapshot
      ? Promise.resolve(latestRuntimeSnapshot)
      : refreshRuntimeState({ forceBlockOpenTabs: false });
    return respondWithSnapshot(snapshotPromise, sendResponse);
  }

  if (message.type === MESSAGE_TYPES.ENSURE_RUNTIME) {
    const snapshotPromise = refreshRuntimeState({ forceBlockOpenTabs: false })
      .then(async (snapshot) => {
        if (sender.tab && Number.isInteger(sender.tab.id)) {
          await scheduleNavigationPolicyCheck(sender.tab.id, sender.url).catch(() => null);
        }
        return snapshot;
      });
    return respondWithSnapshot(snapshotPromise, sendResponse);
  }

  if (message.type === MESSAGE_TYPES.UPDATE_PREFERENCE) {
    return respondWithSnapshot(
      updateFeaturePreference(message, sender),
      sendResponse
    );
  }

  if (message.type === MESSAGE_TYPES.SAVE_SETTINGS) {
    return respondWithSnapshot(saveSettings(message, sender), sendResponse);
  }

  if (message.type === MESSAGE_TYPES.SET_SITE_BLOCK_OVERRIDE) {
    return respondWithSnapshot(
      setSiteBlockOverride(message, sender),
      sendResponse
    );
  }

  if (message.type === MESSAGE_TYPES.START_FOCUS_SESSION) {
    const command = Promise.resolve().then(() => {
      requireTrustedExtensionSender(sender);
      return startFocusSession(message.minutes, message.baseRevision);
    });
    return respondWithSnapshot(command, sendResponse);
  }

  if (message.type === MESSAGE_TYPES.STOP_FOCUS_SESSION) {
    const command = Promise.resolve().then(() => {
      requireTrustedExtensionSender(sender);
      return stopFocusSession(message.baseRevision);
    });
    return respondWithSnapshot(command, sendResponse);
  }

  if (message.type === MESSAGE_TYPES.ACTIVITY_PING) {
    return respondWithSnapshot(
      recordActivityPing(sender, { final: message.final === true }),
      sendResponse
    );
  }

  if (message.type === MESSAGE_TYPES.RESUME_BLOCKED_TAB) {
    return respondWithResult(
      enqueueRuntimeStateOperation(() => resumeBlockedTab(sender)),
      sendResponse
    );
  }

  return undefined;
});

refreshRuntimeState({ forceBlockOpenTabs: true }).catch(() => null);
