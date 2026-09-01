const {
  FEATURE_KEYS,
  ensureLockConfig,
  ensureFeaturePreferences,
  ensureAppearanceConfig,
  ensureEffectiveFeatureState,
  ensureLockStatus,
  ensureFocusSession,
  formatDateTime,
  formatDurationMinutes,
  getLockReasonsSummary
} = globalThis.BiliFocusShared;
const backgroundClient = globalThis.BiliFocusClient;

const toggleRedirect = document.getElementById('toggleRedirect');
const toggleSiteBlock = document.getElementById('toggleSiteBlock');
const togglePlayer = document.getElementById('togglePlayer');
const toggleAutoPlayOff = document.getElementById('toggleAutoPlayOff');
const toggleSearch = document.getElementById('toggleSearch');

const lockStatusCard = document.getElementById('lockStatusCard');
const lockStatusTitle = document.getElementById('lockStatusTitle');
const lockStatusReason = document.getElementById('lockStatusReason');
const lockStatusMeta = document.getElementById('lockStatusMeta');
const customFocusMinutes = document.getElementById('customFocusMinutes');
const focusSessionMeta = document.getElementById('focusSessionMeta');
const stopFocusSession = document.getElementById('stopFocusSession');
const openSettings = document.getElementById('openSettings');
const startCustomFocusButton = document.getElementById('startCustomFocus');
const focusPresetButtons = Array.from(document.querySelectorAll('[data-minutes]'));
const commandError = document.getElementById('commandError');

const toggleMap = {
  siteBlockEnabled: toggleSiteBlock,
  redirectEnabled: toggleRedirect,
  playerMaskEnabled: togglePlayer,
  autoPlayOffEnabled: toggleAutoPlayOff,
  searchMaskEnabled: toggleSearch
};

let latestLockStatus = ensureLockStatus();
let latestFocusSession = ensureFocusSession();
let countdownTimer = null;
let refreshGeneration = 0;

function showCommandError(error) {
  if (!commandError) return;
  commandError.textContent = error ? error.message || String(error) : '';
}

function applyTheme(appearanceConfig) {
  document.documentElement.dataset.theme = appearanceConfig.theme;
}

function renderFeatureState(featurePreferences, effectiveFeatureState, lockStatus, lockConfig) {
  const lockedFeatureKeys = new Set(ensureLockConfig(lockConfig).lockedFeatureKeys);
  FEATURE_KEYS.forEach((key) => {
    const input = toggleMap[key];
    input.checked = Boolean(effectiveFeatureState[key]);
    input.disabled = lockStatus.panelLocked && lockedFeatureKeys.has(key);
    input.dataset.preferenceValue = String(featurePreferences[key]);
  });
}

function renderLockStatus(lockStatus) {
  const state = lockStatus.panelLocked
    ? 'locked'
    : ((lockStatus.restrictionTriggered || lockStatus.active) ? 'armed' : 'free');
  lockStatusCard.dataset.state = state;

  if (!lockStatus.active) {
    lockStatusTitle.textContent = '当前未触发限制';
    lockStatusReason.textContent = '你可以自由切换功能开关。';
    lockStatusMeta.textContent = '';
    return;
  }

  if (!lockStatus.restrictionTriggered) {
    lockStatusTitle.textContent = '当前有规则生效，但未触发锁定';
    lockStatusReason.textContent = `已生效规则：${getLockReasonsSummary(lockStatus.reasons)}，这些规则目前不会自动开启已选功能。`;
    lockStatusMeta.textContent = lockStatus.nextUnlockAt
      ? `预计结束时间：${formatDateTime(lockStatus.nextUnlockAt)}`
      : '预计结束时间暂不可用';
    return;
  }

  const reasonText = `触发条件：${getLockReasonsSummary(lockStatus.restrictionReasons)}`;
  if (lockStatus.panelLocked) {
    lockStatusTitle.textContent = '当前已锁定功能';
    lockStatusReason.textContent = `${reasonText}，严格模式下无法在面板关闭已锁定功能。`;
  } else {
    lockStatusTitle.textContent = '规则已触发，可临时调整功能';
    lockStatusReason.textContent = `${reasonText}，所选功能会自动开启；面板中的更改仅在本次规则触发期间有效。`;
  }

  lockStatusMeta.textContent = lockStatus.nextUnlockAt
    ? `预计结束时间：${formatDateTime(lockStatus.nextUnlockAt)}`
    : '预计结束时间暂不可用';
}

function renderFocusSession(focusSession) {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }

  if (!focusSession.endsAt || focusSession.endsAt <= Date.now()) {
    focusSessionMeta.textContent = '当前没有进行中的专注倒计时。';
    stopFocusSession.style.display = 'none';
    stopFocusSession.disabled = false;
    customFocusMinutes.disabled = false;
    startCustomFocusButton.disabled = false;
    focusPresetButtons.forEach((button) => {
      button.disabled = false;
    });
    return;
  }

  stopFocusSession.style.display = 'block';
  const strictFocusLock = latestLockStatus.enforced &&
    latestLockStatus.strictModeEnabled &&
    Array.isArray(latestLockStatus.restrictionReasons) &&
    latestLockStatus.restrictionReasons.includes('focus');

  customFocusMinutes.disabled = true;
  startCustomFocusButton.disabled = true;
  focusPresetButtons.forEach((button) => {
    button.disabled = true;
  });
  stopFocusSession.disabled = strictFocusLock;

  const updateRemaining = () => {
    const remainingMs = Math.max(0, focusSession.endsAt - Date.now());
    if (!remainingMs) {
      focusSessionMeta.textContent = '专注倒计时已结束。';
      stopFocusSession.style.display = 'none';
      stopFocusSession.disabled = false;
      clearInterval(countdownTimer);
      countdownTimer = null;
      return;
    }

    focusSessionMeta.textContent = `本次专注剩余 ${formatDurationMinutes(Math.ceil(remainingMs / 60000))}`;
  };

  updateRemaining();
  countdownTimer = window.setInterval(updateRemaining, 1000);
}

function renderSnapshot(snapshot) {
  if (!snapshot) return;
  const featurePreferences = ensureFeaturePreferences(snapshot.featurePreferences);
  const effectiveFeatureState = ensureEffectiveFeatureState(snapshot.effectiveFeatureState);
  latestLockStatus = ensureLockStatus(snapshot.lockStatus);
  latestFocusSession = ensureFocusSession(snapshot.focusSession);

  applyTheme(ensureAppearanceConfig(snapshot.appearanceConfig));
  renderFeatureState(
    featurePreferences,
    effectiveFeatureState,
    latestLockStatus,
    snapshot.lockConfig
  );
  renderLockStatus(latestLockStatus);
  renderFocusSession(latestFocusSession);
}

async function refreshPopupState(forceRefresh = true) {
  const generation = ++refreshGeneration;
  try {
    const snapshot = await backgroundClient.getState({ refresh: forceRefresh });
    if (generation !== refreshGeneration) return;
    renderSnapshot(snapshot);
    showCommandError(null);
  } catch (error) {
    if (generation === refreshGeneration) {
      showCommandError(error);
    }
  }
}

async function updatePreference(key, checked) {
  showCommandError(null);
  try {
    const snapshot = key === 'siteBlockEnabled' && latestLockStatus.overrideAllowed
      ? await backgroundClient.setSiteBlockOverride(checked === false)
      : await backgroundClient.updatePreference(key, checked);
    renderSnapshot(snapshot);
  } catch (error) {
    await refreshPopupState(false);
    showCommandError(error);
  }
}

async function startFocusSession(minutes) {
  if (latestFocusSession.endsAt && latestFocusSession.endsAt > Date.now()) {
    refreshPopupState();
    return;
  }

  showCommandError(null);
  try {
    const snapshot = await backgroundClient.startFocusSession(minutes);
    renderSnapshot(snapshot);
  } catch (error) {
    await refreshPopupState(false);
    showCommandError(error);
  }
}

async function stopFocus() {
  showCommandError(null);
  try {
    const snapshot = await backgroundClient.stopFocusSession();
    renderSnapshot(snapshot);
  } catch (error) {
    await refreshPopupState(false);
    showCommandError(error);
  }
}

toggleSiteBlock.addEventListener('change', () => updatePreference('siteBlockEnabled', toggleSiteBlock.checked));
toggleRedirect.addEventListener('change', () => updatePreference('redirectEnabled', toggleRedirect.checked));
togglePlayer.addEventListener('change', () => updatePreference('playerMaskEnabled', togglePlayer.checked));
toggleAutoPlayOff.addEventListener('change', () => updatePreference('autoPlayOffEnabled', toggleAutoPlayOff.checked));
toggleSearch.addEventListener('change', () => updatePreference('searchMaskEnabled', toggleSearch.checked));

focusPresetButtons.forEach((button) => {
  button.addEventListener('click', () => startFocusSession(Number(button.dataset.minutes)));
});

startCustomFocusButton.addEventListener('click', () => {
  startFocusSession(Number(customFocusMinutes.value) || 45);
});

stopFocusSession.addEventListener('click', stopFocus);
openSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());

backgroundClient.subscribe((snapshot) => {
  refreshGeneration += 1;
  renderSnapshot(snapshot);
});

refreshPopupState();
