const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const LOCK_SHARED_SOURCE = fs.readFileSync(path.join(ROOT, 'lockShared.js'), 'utf8');
const RUNTIME_CORE_SOURCE = fs.readFileSync(path.join(ROOT, 'runtimeCore.js'), 'utf8');
const STORAGE_SCHEMA_SOURCE = fs.readFileSync(path.join(ROOT, 'storageSchema.js'), 'utf8');
const RUNTIME_CONTRACTS_SOURCE = fs.readFileSync(
  path.join(ROOT, 'runtimeContracts.js'),
  'utf8'
);
const BACKGROUND_SOURCE = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const EXTENSION_ID = 'test-extension';
const EXTENSION_BASE = `chrome-extension://${EXTENSION_ID}/`;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...args) {
      return listeners.map((listener) => listener(...args));
    }
  };
}

function selectStorageValues(state, keys) {
  if (keys === undefined || keys === null) return clone(state);
  if (typeof keys === 'string') return { [keys]: clone(state[keys]) };
  if (Array.isArray(keys)) {
    return keys.reduce((result, key) => {
      if (Object.prototype.hasOwnProperty.call(state, key)) {
        result[key] = clone(state[key]);
      }
      return result;
    }, {});
  }
  return Object.entries(keys).reduce((result, [key, fallback]) => {
    result[key] = Object.prototype.hasOwnProperty.call(state, key)
      ? clone(state[key])
      : clone(fallback);
    return result;
  }, {});
}

function createStorageArea(initialState = {}) {
  const state = clone(initialState);
  const getCalls = [];
  const setCalls = [];
  const removeCalls = [];

  const area = {
    state,
    getCalls,
    setCalls,
    removeCalls,
    beforeGet: null,
    async get(keys) {
      getCalls.push(clone(keys));
      if (typeof area.beforeGet === 'function') {
        await area.beforeGet(clone(keys));
      }
      return selectStorageValues(state, keys);
    },
    async set(values) {
      setCalls.push(clone(values));
      Object.assign(state, clone(values));
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      removeCalls.push(...list);
      list.forEach((key) => delete state[key]);
    }
  };

  return area;
}

async function createBackgroundHarness(options = {}) {
  const context = vm.createContext({
    URL,
    Date,
    Promise,
    console,
    queueMicrotask,
    structuredClone
  });
  vm.runInContext(LOCK_SHARED_SOURCE, context, { filename: 'lockShared.js' });
  vm.runInContext(RUNTIME_CORE_SOURCE, context, { filename: 'runtimeCore.js' });
  vm.runInContext(STORAGE_SCHEMA_SOURCE, context, { filename: 'storageSchema.js' });
  vm.runInContext(RUNTIME_CONTRACTS_SOURCE, context, {
    filename: 'runtimeContracts.js'
  });

  const shared = context.BiliFocusShared;
  const schema = context.BiliFocusStorageSchema;
  const contracts = context.BiliFocusContracts;
  const sync = createStorageArea({
    ...clone(shared.DEFAULT_FEATURE_PREFERENCES),
    lockConfig: clone(shared.DEFAULT_LOCK_CONFIG),
    appearanceConfig: clone(shared.DEFAULT_APPEARANCE_CONFIG),
    playerShortcutConfig: clone(shared.DEFAULT_PLAYER_SHORTCUT_CONFIG),
    [schema.CONFIG_SCHEMA_VERSION_KEY]: schema.CONFIG_SCHEMA_VERSION,
    ...clone(options.sync)
  });
  const local = createStorageArea({
    effectiveFeatureState: clone(shared.DEFAULT_EFFECTIVE_FEATURE_STATE),
    lockStatus: clone(shared.DEFAULT_LOCK_STATUS),
    focusSession: clone(shared.DEFAULT_FOCUS_SESSION),
    usageState: clone(shared.DEFAULT_USAGE_STATE),
    siteBlockOverrideDisabled: false,
    strictConfigSnapshot: null,
    stateRevision: 0,
    [schema.RUNTIME_SCHEMA_VERSION_KEY]: schema.RUNTIME_SCHEMA_VERSION,
    ...clone(options.local)
  });
  const session = createStorageArea(options.session);

  const tabState = new Map(
    (options.tabs || []).map((tab) => [tab.id, clone(tab)])
  );
  const tabUpdates = [];
  const alarmState = new Map([
    [
      'bili-focus-evaluate',
      {
        name: 'bili-focus-evaluate',
        periodInMinutes: 1
      }
    ],
    ...Object.entries(options.alarms || {}).map(([name, alarm]) => [
      name,
      { name, ...clone(alarm) }
    ])
  ]);
  const alarmCalls = {
    get: [],
    create: [],
    clear: []
  };
  const events = {
    onInstalled: createEvent(),
    onStartup: createEvent(),
    onMessage: createEvent(),
    onAlarm: createEvent(),
    onStorageChanged: createEvent(),
    onBeforeNavigate: createEvent(),
    onHistoryStateUpdated: createEvent(),
    onTabRemoved: createEvent()
  };

  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      getURL(resource = '') {
        return `${EXTENSION_BASE}${String(resource).replace(/^\//, '')}`;
      },
      onInstalled: events.onInstalled,
      onStartup: events.onStartup,
      onMessage: events.onMessage
    },
    alarms: {
      async get(name) {
        alarmCalls.get.push(name);
        return alarmState.has(name) ? clone(alarmState.get(name)) : null;
      },
      async create(name, details) {
        alarmCalls.create.push({ name, details: clone(details) });
        alarmState.set(name, {
          name,
          ...clone(details),
          ...(Number.isFinite(details && details.when)
            ? { scheduledTime: details.when }
            : {})
        });
      },
      async clear(name) {
        alarmCalls.clear.push(name);
        return alarmState.delete(name);
      },
      onAlarm: events.onAlarm
    },
    storage: {
      sync,
      local,
      session,
      onChanged: events.onStorageChanged
    },
    tabs: {
      async query() {
        return Array.from(tabState.values())
          .filter((tab) => shared.isBilibiliUrl(tab.url))
          .map(clone);
      },
      async get(tabId) {
        if (!tabState.has(tabId)) throw new Error(`Unknown tab ${tabId}`);
        return clone(tabState.get(tabId));
      },
      async update(tabId, update) {
        if (!tabState.has(tabId)) throw new Error(`Unknown tab ${tabId}`);
        tabUpdates.push({ tabId, update: clone(update) });
        const tab = tabState.get(tabId);
        tab.url = update.url;
        delete tab.pendingUrl;
        return clone(tab);
      },
      onRemoved: events.onTabRemoved
    },
    webNavigation: {
      onBeforeNavigate: events.onBeforeNavigate,
      onHistoryStateUpdated: events.onHistoryStateUpdated
    }
  };

  context.chrome = chrome;
  context.importScripts = () => {};
  vm.runInContext(BACKGROUND_SOURCE, context, { filename: 'background.js' });
  await vm.runInContext('runtimeStateOperationTail', context);

  return {
    context,
    shared,
    schema,
    contracts,
    chrome,
    sync,
    local,
    session,
    tabState,
    tabUpdates,
    alarms: {
      state: alarmState,
      getCalls: alarmCalls.get,
      createCalls: alarmCalls.create,
      clearCalls: alarmCalls.clear
    },
    events,
    async run(expression) {
      return vm.runInContext(expression, context);
    },
    async idle() {
      await vm.runInContext('runtimeStateOperationTail', context);
    },
    async sendMessage(message, sender = {
      id: EXTENSION_ID,
      url: `${EXTENSION_BASE}controlPanel.html`
    }) {
      const listener = events.onMessage.listeners[0];
      if (!listener) throw new Error('Background message listener is not installed.');

      return new Promise((resolve) => {
        let responded = false;
        const keepAlive = listener(
          clone(message),
          clone(sender),
          (response) => {
            responded = true;
            resolve(clone(response));
          }
        );

        if (keepAlive !== true && !responded) {
          resolve(undefined);
        }
      });
    }
  };
}

test('shared URL policy uses a strict Bilibili hostname boundary', () => {
  const context = vm.createContext({ URL, Date, Math });
  vm.runInContext(LOCK_SHARED_SOURCE, context, { filename: 'lockShared.js' });
  const shared = context.BiliFocusShared;

  assert.equal(shared.isBilibiliHostname('bilibili.com'), true);
  assert.equal(shared.isBilibiliHostname('www.bilibili.com'), true);
  assert.equal(shared.isBilibiliHostname('evilbilibili.com'), false);
  assert.equal(shared.isBilibiliHostname('bilibili.com.evil.test'), false);
  assert.equal(shared.isBilibiliUrl('https://www.bilibili.com/'), true);
  assert.equal(shared.isBilibiliUrl('ftp://www.bilibili.com/'), false);
  assert.equal(shared.isRedirectCandidateUrl('https://www.bilibili.com/'), true);
  assert.equal(shared.isRedirectCandidateUrl('https://evilbilibili.com/'), false);

  for (const allowedUrl of [
    'https://www.bilibili.com/video/BV1',
    'https://www.bilibili.com/bangumi/play/ep1',
    'https://www.bilibili.com/bangumi/media/md1',
    'https://www.bilibili.com/list/watchlater',
    'https://www.bilibili.com/medialist/play/ml1',
    shared.REDIRECT_TARGET_URL,
    ...shared.REDIRECT_WHITELIST_HOSTS.map((host) => `https://${host}/allowed`)
  ]) {
    assert.equal(
      shared.isRedirectCandidateUrl(allowedUrl),
      false,
      `${allowedUrl} should remain allowed`
    );
  }
});

test('state-changing commands reject non-extension-page senders before writing', async () => {
  const harness = await createBackgroundHarness();
  const { MESSAGE_TYPES, ERROR_CODES } = harness.contracts;
  const untrustedSender = {
    id: EXTENSION_ID,
    url: 'https://www.bilibili.com/video/BV-untrusted',
    tab: {
      id: 91,
      url: 'https://www.bilibili.com/video/BV-untrusted'
    }
  };
  const messages = [
    {
      type: MESSAGE_TYPES.UPDATE_PREFERENCE,
      key: 'redirectEnabled',
      value: false
    },
    {
      type: MESSAGE_TYPES.SAVE_SETTINGS,
      lockConfig: clone(harness.shared.DEFAULT_LOCK_CONFIG),
      appearanceConfig: clone(harness.shared.DEFAULT_APPEARANCE_CONFIG),
      playerShortcutConfig: clone(harness.shared.DEFAULT_PLAYER_SHORTCUT_CONFIG)
    },
    {
      type: MESSAGE_TYPES.SET_SITE_BLOCK_OVERRIDE,
      disabled: true
    },
    {
      type: MESSAGE_TYPES.START_FOCUS_SESSION,
      minutes: 30
    },
    {
      type: MESSAGE_TYPES.STOP_FOCUS_SESSION
    }
  ];
  const syncBefore = clone(harness.sync.state);
  const localBefore = clone(harness.local.state);
  harness.sync.setCalls.length = 0;
  harness.local.setCalls.length = 0;

  for (const message of messages) {
    const response = await harness.sendMessage(message, untrustedSender);
    assert.equal(response.ok, false, message.type);
    assert.equal(response.error.code, ERROR_CODES.NOT_AUTHORIZED, message.type);
  }

  assert.deepEqual(harness.sync.state, syncBefore);
  assert.deepEqual(harness.local.state, localBefore);
  assert.equal(harness.sync.setCalls.length, 0);
  assert.equal(harness.local.setCalls.length, 0);
});

test('state-changing commands reject stale revisions with a fresh snapshot', async () => {
  const harness = await createBackgroundHarness();
  const { MESSAGE_TYPES, ERROR_CODES } = harness.contracts;
  const currentRevision = harness.local.state.stateRevision;
  harness.sync.setCalls.length = 0;
  harness.local.setCalls.length = 0;

  const response = await harness.sendMessage({
    type: MESSAGE_TYPES.UPDATE_PREFERENCE,
    key: 'redirectEnabled',
    value: false,
    baseRevision: currentRevision + 1
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.CONFLICT);
  assert.equal(response.snapshot.revision, currentRevision);
  assert.equal(harness.sync.state.redirectEnabled, true);
  assert.equal(harness.sync.setCalls.length, 0);
  assert.equal(harness.local.setCalls.length, 0);
});

test('preference commands ignore unrelated runtime revision drift', async () => {
  const harness = await createBackgroundHarness();
  const { MESSAGE_TYPES } = harness.contracts;
  const currentRevision = harness.local.state.stateRevision;

  const response = await harness.sendMessage({
    type: MESSAGE_TYPES.UPDATE_PREFERENCE,
    key: 'redirectEnabled',
    value: false,
    baseRevision: currentRevision + 1,
    basePreferenceValue: true
  });

  assert.equal(response.ok, true);
  assert.equal(harness.sync.state.redirectEnabled, false);
  assert.equal(response.snapshot.featurePreferences.redirectEnabled, false);
});

test('authorized preference commands persist through the background authority', async () => {
  const harness = await createBackgroundHarness();
  const { MESSAGE_TYPES } = harness.contracts;
  const baseRevision = harness.local.state.stateRevision;
  harness.sync.setCalls.length = 0;
  harness.local.setCalls.length = 0;

  const response = await harness.sendMessage({
    type: MESSAGE_TYPES.UPDATE_PREFERENCE,
    key: 'redirectEnabled',
    value: false,
    baseRevision
  });

  assert.equal(response.ok, true);
  assert.equal(harness.sync.state.redirectEnabled, false);
  assert.equal(response.snapshot.featurePreferences.redirectEnabled, false);
  assert.equal(response.snapshot.effectiveFeatureState.redirectEnabled, false);
  assert.ok(response.snapshot.revision > baseRevision);
  assert.ok(
    harness.sync.setCalls.some((entry) => entry.redirectEnabled === false)
  );
  assert.equal(
    harness.local.state.stateRevision,
    response.snapshot.revision
  );
});

test('strict feature locks reject panel changes and repair direct preference writes', async () => {
  const lockConfig = {
    weeklyScheduleEnabled: true,
    weeklyWindows: [{
      id: 'always-feature-lock',
      weekday: new Date().getDay(),
      startMinutes: 0,
      endMinutes: 0
    }],
    dailyUsageLimit: {
      enabled: false,
      limitMinutes: 120,
      resetMinutesAfterMidnight: 240
    },
    blockConditions: {
      schedule: true,
      focus: true,
      dailyLimit: true
    },
    lockedFeatureKeys: ['redirectEnabled'],
    strictModeEnabled: true
  };
  const harness = await createBackgroundHarness({
    sync: {
      redirectEnabled: false,
      lockConfig
    }
  });
  const { MESSAGE_TYPES, ERROR_CODES } = harness.contracts;

  assert.equal(harness.local.state.lockStatus.panelLocked, true);
  assert.equal(harness.local.state.effectiveFeatureState.siteBlockEnabled, false);
  assert.equal(harness.local.state.effectiveFeatureState.redirectEnabled, true);

  const response = await harness.sendMessage({
    type: MESSAGE_TYPES.UPDATE_PREFERENCE,
    key: 'redirectEnabled',
    value: true,
    baseRevision: harness.local.state.stateRevision
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.POLICY_REJECTED);
  assert.equal(harness.sync.state.redirectEnabled, false);

  harness.sync.state.redirectEnabled = true;
  await harness.run('refreshRuntimeState({ forceBlockOpenTabs: false })');
  assert.equal(harness.sync.state.redirectEnabled, false);
  assert.equal(harness.local.state.effectiveFeatureState.redirectEnabled, true);
});

test('non-strict feature locks allow temporary panel overrides without changing preferences', async () => {
  const lockConfig = {
    weeklyScheduleEnabled: true,
    weeklyWindows: [{
      id: 'always-feature-override',
      weekday: new Date().getDay(),
      startMinutes: 0,
      endMinutes: 0
    }],
    dailyUsageLimit: {
      enabled: false,
      limitMinutes: 120,
      resetMinutesAfterMidnight: 240
    },
    blockConditions: {
      schedule: true,
      focus: true,
      dailyLimit: true
    },
    lockedFeatureKeys: ['redirectEnabled'],
    strictModeEnabled: false
  };
  const harness = await createBackgroundHarness({
    sync: {
      redirectEnabled: false,
      lockConfig
    }
  });
  const { MESSAGE_TYPES } = harness.contracts;

  assert.equal(harness.local.state.effectiveFeatureState.redirectEnabled, true);
  const response = await harness.sendMessage({
    type: MESSAGE_TYPES.UPDATE_PREFERENCE,
    key: 'redirectEnabled',
    value: false,
    baseRevision: harness.local.state.stateRevision
  });

  assert.equal(response.ok, true);
  assert.equal(harness.sync.state.redirectEnabled, false);
  assert.equal(harness.local.state.featureOverrideDisabled.redirectEnabled, true);
  assert.equal(response.snapshot.effectiveFeatureState.redirectEnabled, false);
});

test('concurrent refresh requests merge forceful side effects into one batch', async () => {
  const harness = await createBackgroundHarness();
  harness.sync.state.siteBlockEnabled = true;
  harness.local.state.effectiveFeatureState.siteBlockEnabled = true;
  harness.tabState.set(77, {
    id: 77,
    url: 'https://www.bilibili.com/video/BV-refresh-merge'
  });
  harness.tabUpdates.length = 0;
  harness.sync.getCalls.length = 0;

  let releaseFirstRead;
  let markFirstReadStarted;
  const firstReadStarted = new Promise((resolve) => {
    markFirstReadStarted = resolve;
  });
  const firstReadGate = new Promise((resolve) => {
    releaseFirstRead = resolve;
  });
  let shouldBlock = true;
  harness.sync.beforeGet = async () => {
    if (!shouldBlock) return;
    shouldBlock = false;
    markFirstReadStarted();
    await firstReadGate;
  };

  const firstRefresh = harness.run(
    'refreshRuntimeState({ forceBlockOpenTabs: false })'
  );
  await firstReadStarted;
  const forcefulRefresh = harness.run(
    'refreshRuntimeState({ forceBlockOpenTabs: true })'
  );
  releaseFirstRead();

  const [firstSnapshot, forcefulSnapshot] = await Promise.all([
    firstRefresh,
    forcefulRefresh
  ]);
  harness.sync.beforeGet = null;

  assert.equal(firstSnapshot.revision, forcefulSnapshot.revision);
  assert.equal(harness.sync.getCalls.length, 2);
  assert.deepEqual(harness.tabUpdates, [{
    tabId: 77,
    update: { url: `${EXTENSION_BASE}blocked.html` }
  }]);
});

test('same-document navigation is decided from the current tab URL, not a stale event', async () => {
  const harness = await createBackgroundHarness({
    tabs: [{ id: 1, url: 'https://www.bilibili.com/video/BV1' }]
  });

  harness.tabState.get(1).pendingUrl = 'https://www.bilibili.com/';
  await Promise.all(harness.events.onHistoryStateUpdated.emit({
    frameId: 0,
    tabId: 1,
    url: 'https://www.bilibili.com/'
  }));
  assert.deepEqual(harness.tabUpdates, [{
    tabId: 1,
    update: { url: harness.shared.REDIRECT_TARGET_URL }
  }]);

  harness.tabUpdates.length = 0;
  harness.tabState.get(1).url = 'https://www.bilibili.com/';
  harness.tabState.get(1).pendingUrl = 'https://www.bilibili.com/video/BV2';
  await Promise.all(harness.events.onHistoryStateUpdated.emit({
    frameId: 0,
    tabId: 1,
    url: 'https://www.bilibili.com/'
  }));
  assert.deepEqual(harness.tabUpdates, []);
});

test('navigation policy preserves disabled redirects, fixed targets, and subframes', async () => {
  const harness = await createBackgroundHarness({
    tabs: [{ id: 1, url: 'https://www.bilibili.com/video/BV1' }]
  });
  harness.local.state.effectiveFeatureState.redirectEnabled = false;
  await harness.run(
    'latestRuntimeSnapshot.effectiveFeatureState.redirectEnabled = false'
  );
  harness.tabState.get(1).pendingUrl = 'https://www.bilibili.com/';

  await Promise.all(harness.events.onHistoryStateUpdated.emit({
    frameId: 0,
    tabId: 1,
    url: 'https://www.bilibili.com/'
  }));
  assert.deepEqual(harness.tabUpdates, []);

  harness.local.state.effectiveFeatureState.redirectEnabled = true;
  await harness.run(
    'latestRuntimeSnapshot.effectiveFeatureState.redirectEnabled = true'
  );
  harness.tabState.get(1).url = harness.shared.REDIRECT_TARGET_URL;
  delete harness.tabState.get(1).pendingUrl;
  await Promise.all(harness.events.onHistoryStateUpdated.emit({
    frameId: 0,
    tabId: 1,
    url: harness.shared.REDIRECT_TARGET_URL
  }));
  assert.deepEqual(harness.tabUpdates, []);

  harness.tabState.get(1).url = 'https://www.bilibili.com/video/BV1';
  harness.tabState.get(1).pendingUrl = 'https://www.bilibili.com/';
  await Promise.all(harness.events.onHistoryStateUpdated.emit({
    frameId: 2,
    tabId: 1,
    url: 'https://www.bilibili.com/'
  }));
  assert.deepEqual(harness.tabUpdates, []);
});

test('unrelated top-level navigations do not start a new policy check', async () => {
  const harness = await createBackgroundHarness();

  await harness.run(`
    handleNavigationEvent({
      frameId: 0,
      tabId: 99,
      url: 'https://example.com/dashboard'
    })
  `);

  assert.equal(await harness.run('navigationCheckStateByTab.size'), 0);

  await harness.run(`
    navigationCheckStateByTab.set(99, {
      latestUrl: 'https://www.bilibili.com/',
      version: 3,
      promise: Promise.resolve(false)
    });
    handleNavigationEvent({
      frameId: 0,
      tabId: 99,
      url: 'https://example.com/dashboard'
    });
  `);
  assert.equal(
    await harness.run("navigationCheckStateByTab.get(99).latestUrl"),
    'https://example.com/dashboard'
  );
  assert.equal(await harness.run('navigationCheckStateByTab.get(99).version'), 4);
  await harness.run('navigationCheckStateByTab.delete(99)');
});

test('site blocking moves every open Bilibili surface to an extension-owned page', async () => {
  const harness = await createBackgroundHarness();
  harness.local.state.effectiveFeatureState.siteBlockEnabled = true;
  await harness.run(
    'latestRuntimeSnapshot.effectiveFeatureState.siteBlockEnabled = true'
  );
  harness.tabState.set(1, {
    id: 1,
    url: 'https://search.bilibili.com/all?q=allowed'
  });
  harness.tabState.set(2, {
    id: 2,
    url: 'https://www.bilibili.com/video/BV1'
  });
  harness.tabState.set(3, {
    id: 3,
    url: 'https://passport.bilibili.com/login'
  });

  harness.tabUpdates.length = 0;
  await harness.run('blockOpenBilibiliTabs()');

  assert.equal(harness.tabUpdates.length, 3);
  assert.deepEqual(
    new Set(harness.tabUpdates.map((entry) => entry.update.url)),
    new Set([`${EXTENSION_BASE}blocked.html`])
  );
  assert.equal(
    harness.session.state['blockedReturnUrl:1'],
    'https://search.bilibili.com/all?q=allowed'
  );
  assert.equal(
    harness.session.state['blockedReturnUrl:2'],
    'https://www.bilibili.com/video/BV1'
  );
});

test('alarm-driven lock activation blocks already-open allowed surfaces', async () => {
  const harness = await createBackgroundHarness();
  harness.sync.state.lockConfig = {
    weeklyScheduleEnabled: true,
    weeklyWindows: [{
      id: 'active-today',
      weekday: new Date().getDay(),
      startMinutes: 0,
      endMinutes: 0
    }],
    dailyUsageLimit: {
      enabled: false,
      limitMinutes: 120,
      resetMinutesAfterMidnight: 240
    },
    blockConditions: {
      schedule: true,
      focus: true,
      dailyLimit: true
    },
    strictModeEnabled: true
  };
  harness.tabState.set(1, {
    id: 1,
    url: 'https://search.bilibili.com/all?q=allowed'
  });
  harness.tabState.set(2, {
    id: 2,
    url: 'https://www.bilibili.com/video/BV1'
  });

  harness.events.onAlarm.emit({ name: 'bili-focus-evaluate' });
  await harness.idle();

  assert.equal(harness.local.state.effectiveFeatureState.siteBlockEnabled, true);
  assert.deepEqual(
    harness.tabUpdates.map((entry) => ({
      tabId: entry.tabId,
      url: entry.update.url
    })),
    [
      { tabId: 1, url: `${EXTENSION_BASE}blocked.html` },
      { tabId: 2, url: `${EXTENSION_BASE}blocked.html` }
    ]
  );
});

test('blocked tab resume validates authoritative state and reapplies redirect policy', async () => {
  const harness = await createBackgroundHarness({
    tabs: [{ id: 7, url: `${EXTENSION_BASE}blocked.html` }],
    session: {
      'blockedReturnUrl:7': 'https://www.bilibili.com/'
    }
  });
  const sender = {
    id: EXTENSION_ID,
    url: `${EXTENSION_BASE}blocked.html`,
    tab: { id: 7, url: `${EXTENSION_BASE}blocked.html` }
  };
  harness.context.__sender = sender;

  const result = await harness.run('resumeBlockedTab(__sender)');
  assert.equal(result.destination, harness.shared.REDIRECT_TARGET_URL);
  assert.equal(harness.tabUpdates.at(-1).update.url, harness.shared.REDIRECT_TARGET_URL);
  assert.equal(harness.session.state['blockedReturnUrl:7'], undefined);

  harness.tabState.set(7, { id: 7, url: `${EXTENSION_BASE}blocked.html` });
  harness.local.state.effectiveFeatureState.siteBlockEnabled = true;
  await assert.rejects(
    harness.run('resumeBlockedTab(__sender)'),
    /still active/
  );

  harness.local.state.effectiveFeatureState.siteBlockEnabled = false;
  harness.context.__sender = {
    id: EXTENSION_ID,
    url: 'https://attacker.test/blocked.html',
    tab: { id: 7 }
  };
  await assert.rejects(
    harness.run('resumeBlockedTab(__sender)'),
    /not authorized/
  );

  for (const unsafeReturnUrl of [
    'javascript:alert(1)',
    'https://evilbilibili.com/',
    'https://bilibili.com.evil.test/'
  ]) {
    harness.tabState.set(7, { id: 7, url: `${EXTENSION_BASE}blocked.html` });
    harness.session.state['blockedReturnUrl:7'] = unsafeReturnUrl;
    harness.context.__sender = sender;
    const safeFallback = await harness.run('resumeBlockedTab(__sender)');
    assert.equal(safeFallback.destination, harness.shared.REDIRECT_TARGET_URL);
    assert.equal(
      harness.tabUpdates.at(-1).update.url,
      harness.shared.REDIRECT_TARGET_URL
    );
  }

  harness.tabState.set(7, { id: 7, url: `${EXTENSION_BASE}blocked.html` });
  harness.session.state['blockedReturnUrl:7'] =
    'https://www.bilibili.com/video/BV-safe-return';
  harness.context.__sender = sender;
  const legitimateReturn = await harness.run('resumeBlockedTab(__sender)');
  assert.equal(
    legitimateReturn.destination,
    'https://www.bilibili.com/video/BV-safe-return'
  );
  assert.equal(
    harness.tabUpdates.at(-1).update.url,
    'https://www.bilibili.com/video/BV-safe-return'
  );
});

test('strict configuration repair protects active rules without repair echo oscillation', async () => {
  const baseline = {
    weeklyScheduleEnabled: true,
    weeklyWindows: [{
      id: 'always',
      weekday: new Date().getDay(),
      startMinutes: 0,
      endMinutes: 0
    }],
    dailyUsageLimit: {
      enabled: false,
      limitMinutes: 120,
      resetMinutesAfterMidnight: 240
    },
    blockConditions: {
      schedule: true,
      focus: true,
      dailyLimit: true
    },
    strictModeEnabled: true
  };
  const harness = await createBackgroundHarness({
    sync: { lockConfig: baseline },
    local: {
      strictConfigSnapshot: baseline,
      lockStatus: {
        active: true,
        enforced: true,
        reasons: ['schedule'],
        restrictionTriggered: true,
        restrictionReasons: ['schedule'],
        nextUnlockAt: Date.now() + 60000,
        lockedBySchedule: true,
        lockedByFocusSession: false,
        lockedByDailyLimit: false,
        strictModeEnabled: true,
        panelLocked: true,
        overrideAllowed: false,
        overrideActive: false,
        updatedAt: Date.now()
      }
    }
  });
  harness.sync.setCalls.length = 0;

  const proposed = clone(baseline);
  proposed.weeklyScheduleEnabled = false;
  proposed.weeklyWindows = [];
  proposed.dailyUsageLimit.limitMinutes = 300;
  harness.context.__change = {
    lockConfig: {
      oldValue: baseline,
      newValue: proposed
    }
  };

  assert.equal(await harness.run('enforceStrictConfigIntegrity(__change)'), true);
  const repaired = harness.sync.state.lockConfig;
  assert.equal(repaired.weeklyScheduleEnabled, true);
  assert.deepEqual(repaired.weeklyWindows, baseline.weeklyWindows);
  assert.equal(repaired.dailyUsageLimit.limitMinutes, 300);
  assert.equal(harness.sync.setCalls.length, 1);

  harness.context.__change = {
    lockConfig: {
      oldValue: proposed,
      newValue: repaired
    }
  };
  assert.equal(await harness.run('enforceStrictConfigIntegrity(__change)'), false);
  assert.equal(harness.sync.setCalls.length, 1);
});

test('expired strict snapshots do not overwrite a legitimate synchronized config', async () => {
  const fixedNow = new Date(2026, 6, 30, 12, 0, 0, 0).getTime();
  class FixedDate extends Date {
    constructor(...args) {
      super(args.length ? args[0] : fixedNow);
    }

    static now() {
      return fixedNow;
    }
  }

  const harness = await createBackgroundHarness();
  harness.context.Date = FixedDate;
  const yesterday = (new FixedDate().getDay() + 6) % 7;
  const baseline = {
    weeklyScheduleEnabled: true,
    weeklyWindows: [{
      id: 'expired-window',
      weekday: yesterday,
      startMinutes: 0,
      endMinutes: 0
    }],
    dailyUsageLimit: {
      enabled: false,
      limitMinutes: 120,
      resetMinutesAfterMidnight: 240
    },
    blockConditions: {
      schedule: true,
      focus: true,
      dailyLimit: true
    },
    strictModeEnabled: true
  };
  const proposed = clone(baseline);
  proposed.weeklyScheduleEnabled = false;
  proposed.weeklyWindows = [];
  proposed.strictModeEnabled = false;

  harness.sync.state.lockConfig = proposed;
  harness.local.state.strictConfigSnapshot = baseline;
  harness.local.state.lockStatus = {
    active: true,
    enforced: true,
    reasons: ['schedule'],
    restrictionTriggered: true,
    restrictionReasons: ['schedule'],
    nextUnlockAt: fixedNow - 60000,
    lockedBySchedule: true,
    lockedByFocusSession: false,
    lockedByDailyLimit: false,
    strictModeEnabled: true,
    panelLocked: true,
    overrideAllowed: false,
    overrideActive: false,
    updatedAt: fixedNow - 60000
  };
  harness.local.state.usageState = {
    dayKey: harness.shared.getLogicalDayInfo(new FixedDate(), 240).dayKey,
    accumulatedMs: 0,
    exceeded: false,
    limitExceededAt: null,
    lastPingByTab: {}
  };
  harness.context.__change = {
    lockConfig: {
      oldValue: baseline,
      newValue: proposed
    }
  };
  harness.sync.setCalls.length = 0;

  assert.equal(await harness.run('enforceStrictConfigIntegrity(__change)'), false);
  assert.equal(harness.sync.setCalls.length, 0);
  await harness.run('refreshRuntimeState({ reloadRedirectTabs: false })');
  assert.deepEqual(
    harness.sync.state.lockConfig,
    clone(harness.shared.ensureLockConfig(proposed))
  );
  assert.equal(harness.local.state.strictConfigSnapshot, null);
  assert.equal(harness.local.state.lockStatus.enforced, false);
});

test('background refuses strict focus stop but preserves legitimate stop behavior', async () => {
  const now = Date.now();
  const strictConfig = {
    weeklyScheduleEnabled: false,
    weeklyWindows: [],
    dailyUsageLimit: {
      enabled: false,
      limitMinutes: 120,
      resetMinutesAfterMidnight: 240
    },
    blockConditions: {
      schedule: true,
      focus: true,
      dailyLimit: true
    },
    strictModeEnabled: true
  };
  const activeSession = { startedAt: now, endsAt: now + 60000 };
  const harness = await createBackgroundHarness({
    sync: { lockConfig: strictConfig },
    local: {
      focusSession: activeSession,
      strictConfigSnapshot: strictConfig,
      lockStatus: {
        active: true,
        enforced: true,
        reasons: ['focus'],
        restrictionTriggered: true,
        restrictionReasons: ['focus'],
        nextUnlockAt: now + 60000,
        lockedBySchedule: false,
        lockedByFocusSession: true,
        lockedByDailyLimit: false,
        strictModeEnabled: true,
        panelLocked: true,
        overrideAllowed: false,
        overrideActive: false,
        updatedAt: now
      }
    }
  });

  await assert.rejects(
    harness.run('stopFocusSession()'),
    /Strict mode/
  );
  assert.deepEqual(harness.local.state.focusSession, activeSession);

  harness.sync.state.lockConfig.strictModeEnabled = false;
  harness.local.state.strictConfigSnapshot = null;
  harness.local.state.lockStatus.strictModeEnabled = false;
  harness.local.state.lockStatus.enforced = false;
  await harness.run('stopFocusSession()');
  assert.deepEqual(harness.local.state.focusSession, {
    endsAt: null,
    startedAt: null
  });
});

test('ordinary activity pings update usage without a full runtime refresh', async () => {
  const harness = await createBackgroundHarness({
    tabs: [{ id: 41, url: 'https://www.bilibili.com/video/BV-activity' }]
  });
  const { MESSAGE_TYPES } = harness.contracts;
  const now = Date.now();
  const revisionBefore = harness.local.state.stateRevision;
  harness.local.state.usageState = {
    dayKey: harness.shared.getLogicalDayInfo(new Date(now), 240).dayKey,
    accumulatedMs: 1000,
    exceeded: false,
    limitExceededAt: null,
    lastPingByTab: {
      41: now - 10000
    }
  };
  harness.sync.getCalls.length = 0;
  harness.local.getCalls.length = 0;
  harness.local.setCalls.length = 0;
  harness.alarms.getCalls.length = 0;
  harness.alarms.createCalls.length = 0;
  harness.alarms.clearCalls.length = 0;

  const response = await harness.sendMessage({
    type: MESSAGE_TYPES.ACTIVITY_PING
  }, {
    id: EXTENSION_ID,
    url: 'https://www.bilibili.com/video/BV-activity',
    tab: {
      id: 41,
      url: 'https://www.bilibili.com/video/BV-activity'
    }
  });

  assert.equal(response.ok, true);
  assert.equal(harness.sync.getCalls.length, 0);
  assert.deepEqual(harness.local.getCalls, [[
    'focusSession',
    'lockStatus',
    'runtimeSchemaVersion',
    'strictConfigSnapshot',
    'usageState'
  ]]);
  assert.equal(harness.local.setCalls.length, 1);
  assert.deepEqual(
    Object.keys(harness.local.setCalls[0]),
    ['usageState']
  );
  assert.equal(harness.local.state.stateRevision, revisionBefore);
  assert.equal(harness.alarms.getCalls.length, 0);
  assert.equal(harness.alarms.createCalls.length, 0);
  assert.equal(harness.alarms.clearCalls.length, 0);
  assert.ok(harness.local.state.usageState.accumulatedMs >= 10000);
});

test('runtime refresh schedules and reuses the exact next state-boundary alarm', async () => {
  const harness = await createBackgroundHarness();
  const focusEndsAt = Date.now() + 5 * 60 * 1000;
  harness.local.state.focusSession = {
    startedAt: Date.now(),
    endsAt: focusEndsAt
  };
  harness.alarms.getCalls.length = 0;
  harness.alarms.createCalls.length = 0;
  harness.alarms.clearCalls.length = 0;

  await harness.run('refreshRuntimeState({ forceBlockOpenTabs: false })');
  assert.deepEqual(harness.alarms.createCalls, [{
    name: 'bili-focus-state-boundary',
    details: { when: focusEndsAt }
  }]);
  assert.equal(
    harness.alarms.state.get('bili-focus-state-boundary').scheduledTime,
    focusEndsAt
  );

  harness.alarms.createCalls.length = 0;
  await harness.run('refreshRuntimeState({ forceBlockOpenTabs: false })');
  assert.equal(harness.alarms.createCalls.length, 0);

  harness.local.state.focusSession = clone(
    harness.shared.DEFAULT_FOCUS_SESSION
  );
  await harness.run('refreshRuntimeState({ forceBlockOpenTabs: false })');
  assert.ok(
    harness.alarms.clearCalls.includes('bili-focus-state-boundary')
  );
});

test('serialized activity mutations do not lose increments and stable refreshes do not churn', async () => {
  const now = Date.now();
  const harness = await createBackgroundHarness({
    tabs: [
      { id: 1, url: 'https://www.bilibili.com/video/BV1' },
      { id: 2, url: 'https://www.bilibili.com/video/BV2' }
    ]
  });
  harness.local.state.usageState = {
    dayKey: harness.shared.getLogicalDayInfo(new Date(), 240).dayKey,
    accumulatedMs: 0,
    exceeded: false,
    limitExceededAt: null,
    lastPingByTab: {
      1: now - 10000,
      2: now - 10000
    }
  };

  harness.context.__sender1 = {
    id: EXTENSION_ID,
    url: 'https://www.bilibili.com/video/BV1',
    tab: { id: 1, url: 'https://www.bilibili.com/video/BV1' }
  };
  harness.context.__sender2 = {
    id: EXTENSION_ID,
    url: 'https://www.bilibili.com/video/BV2',
    tab: { id: 2, url: 'https://www.bilibili.com/video/BV2' }
  };

  await Promise.all([
    harness.run('recordActivityPing(__sender1)'),
    harness.run('recordActivityPing(__sender2)')
  ]);
  assert.ok(harness.local.state.usageState.accumulatedMs >= 19000);

  await harness.run('refreshRuntimeState({ reloadRedirectTabs: false })');
  harness.local.setCalls.length = 0;
  const updatedAt = harness.local.state.lockStatus.updatedAt;
  await harness.run('refreshRuntimeState({ reloadRedirectTabs: false })');
  assert.equal(harness.local.state.lockStatus.updatedAt, updatedAt);
  assert.equal(harness.local.setCalls.length, 0);
});

test('stale activity pings are persisted once without refresh write churn', async () => {
  const harness = await createBackgroundHarness();
  harness.local.state.usageState = {
    dayKey: harness.shared.getLogicalDayInfo(new Date(), 240).dayKey,
    accumulatedMs: 0,
    exceeded: false,
    limitExceededAt: null,
    lastPingByTab: {
      99: Date.now() - 120000
    }
  };
  harness.local.setCalls.length = 0;

  await harness.run('refreshRuntimeState({ reloadRedirectTabs: false })');
  assert.deepEqual(harness.local.state.usageState.lastPingByTab, {});
  assert.equal(harness.local.setCalls.length, 1);
  assert.deepEqual(
    Object.keys(harness.local.setCalls[0]),
    ['usageState', 'stateRevision']
  );

  harness.local.setCalls.length = 0;
  await harness.run('refreshRuntimeState({ reloadRedirectTabs: false })');
  assert.equal(harness.local.setCalls.length, 0);
});

test('activity accounting uses the strict snapshot before config repair runs', async () => {
  const fixedNow = new Date(2026, 6, 30, 12, 0, 0, 0).getTime();
  class FixedDate extends Date {
    constructor(...args) {
      super(args.length ? args[0] : fixedNow);
    }

    static now() {
      return fixedNow;
    }
  }

  const harness = await createBackgroundHarness({
    tabs: [{ id: 1, url: 'https://www.bilibili.com/video/BV1' }]
  });
  harness.context.Date = FixedDate;

  const baseline = {
    weeklyScheduleEnabled: false,
    weeklyWindows: [],
    dailyUsageLimit: {
      enabled: true,
      limitMinutes: 1,
      resetMinutesAfterMidnight: 0
    },
    blockConditions: {
      schedule: true,
      focus: true,
      dailyLimit: true
    },
    strictModeEnabled: true
  };
  const weakened = clone(baseline);
  weakened.dailyUsageLimit = {
    enabled: false,
    limitMinutes: 1440,
    resetMinutesAfterMidnight: 1439
  };
  weakened.strictModeEnabled = false;

  harness.sync.state.lockConfig = weakened;
  harness.local.state.usageState = {
    dayKey: harness.shared.getLogicalDayInfo(new FixedDate(), 0).dayKey,
    accumulatedMs: 60000,
    exceeded: true,
    limitExceededAt: fixedNow - 10000,
    lastPingByTab: {
      1: fixedNow - 10000
    }
  };
  harness.local.state.lockStatus = {
    active: true,
    enforced: true,
    reasons: ['dailyLimit'],
    restrictionTriggered: true,
    restrictionReasons: ['dailyLimit'],
    nextUnlockAt: fixedNow + 12 * 60 * 60 * 1000,
    lockedBySchedule: false,
    lockedByFocusSession: false,
    lockedByDailyLimit: true,
    strictModeEnabled: true,
    panelLocked: true,
    overrideAllowed: false,
    overrideActive: false,
    updatedAt: fixedNow
  };
  harness.local.state.strictConfigSnapshot = baseline;
  harness.context.__sender = {
    id: EXTENSION_ID,
    url: 'https://www.bilibili.com/video/BV1',
    tab: { id: 1, url: 'https://www.bilibili.com/video/BV1' }
  };

  await harness.run('recordActivityPing(__sender)');

  assert.equal(harness.local.state.usageState.dayKey, '2026-07-30');
  assert.equal(harness.local.state.usageState.accumulatedMs, 70000);
  assert.equal(harness.local.state.lockStatus.enforced, true);
  assert.equal(harness.local.state.strictConfigSnapshot.dailyUsageLimit.enabled, true);
  assert.equal(
    harness.sync.state.lockConfig.dailyUsageLimit.resetMinutesAfterMidnight,
    1439
  );
  assert.equal(harness.sync.state.lockConfig.strictModeEnabled, false);
});

test('future storage schemas block initialization without downgrade writes', async () => {
  const probe = await createBackgroundHarness();
  const futureConfigVersion = probe.schema.CONFIG_SCHEMA_VERSION + 1;
  const futureRuntimeVersion = probe.schema.RUNTIME_SCHEMA_VERSION + 1;
  const harness = await createBackgroundHarness({
    sync: {
      [probe.schema.CONFIG_SCHEMA_VERSION_KEY]: futureConfigVersion
    },
    local: {
      [probe.schema.RUNTIME_SCHEMA_VERSION_KEY]: futureRuntimeVersion
    }
  });

  assert.equal(harness.sync.setCalls.length, 0);
  assert.equal(harness.local.setCalls.length, 0);
  assert.equal(
    harness.sync.state[probe.schema.CONFIG_SCHEMA_VERSION_KEY],
    futureConfigVersion
  );
  assert.equal(
    harness.local.state[probe.schema.RUNTIME_SCHEMA_VERSION_KEY],
    futureRuntimeVersion
  );
  await assert.rejects(
    harness.run('ensureRuntimeInitialized()'),
    /更新版本创建的设置数据/
  );
  assert.equal(harness.sync.setCalls.length, 0);
  assert.equal(harness.local.setCalls.length, 0);
});

test('a future schema arriving at runtime invalidates caches before any repair or heartbeat write', async () => {
  const harness = await createBackgroundHarness();
  const futureConfigVersion = harness.schema.CONFIG_SCHEMA_VERSION + 1;
  const futureRuntimeVersion = harness.schema.RUNTIME_SCHEMA_VERSION + 1;
  const weakenedConfig = {
    ...clone(harness.shared.DEFAULT_LOCK_CONFIG),
    strictModeEnabled: false
  };

  harness.sync.setCalls.length = 0;
  harness.local.setCalls.length = 0;
  harness.sync.state[harness.schema.CONFIG_SCHEMA_VERSION_KEY] =
    futureConfigVersion;
  harness.sync.state.lockConfig = weakenedConfig;
  harness.events.onStorageChanged.emit({
    [harness.schema.CONFIG_SCHEMA_VERSION_KEY]: {
      oldValue: harness.schema.CONFIG_SCHEMA_VERSION,
      newValue: futureConfigVersion
    },
    lockConfig: {
      oldValue: clone(harness.shared.DEFAULT_LOCK_CONFIG),
      newValue: weakenedConfig
    }
  }, 'sync');
  await harness.idle();
  assert.equal(harness.sync.setCalls.length, 0);
  assert.equal(harness.local.setCalls.length, 0);

  harness.local.state[harness.schema.RUNTIME_SCHEMA_VERSION_KEY] =
    futureRuntimeVersion;
  harness.events.onStorageChanged.emit({
    [harness.schema.RUNTIME_SCHEMA_VERSION_KEY]: {
      oldValue: harness.schema.RUNTIME_SCHEMA_VERSION,
      newValue: futureRuntimeVersion
    }
  }, 'local');
  await harness.idle();

  const activityResponse = await harness.sendMessage({
    type: harness.contracts.MESSAGE_TYPES.ACTIVITY_PING
  }, {
    id: EXTENSION_ID,
    url: 'https://www.bilibili.com/video/BV-future-schema',
    tab: {
      id: 72,
      url: 'https://www.bilibili.com/video/BV-future-schema'
    }
  });
  assert.equal(activityResponse.ok, false);
  assert.equal(
    activityResponse.error.code,
    harness.contracts.ERROR_CODES.UNSUPPORTED_SCHEMA
  );
  assert.equal(harness.sync.setCalls.length, 0);
  assert.equal(harness.local.setCalls.length, 0);
});

test('manifest exposes only required runtime permissions and packaged scripts', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.deepEqual(
    manifest.permissions,
    ['storage', 'tabs', 'alarms', 'webNavigation']
  );
  assert.deepEqual(
    manifest.content_scripts[0].js,
    [
      'lockShared.js',
      'runtimeContracts.js',
      'backgroundClient.js',
      'redirect.js',
      'playerShortcuts.js'
    ]
  );
  for (const file of [
    'blocked.html',
    'blocked.css',
    'blocked.js',
    'lockShared.js',
    'runtimeCore.js',
    'storageSchema.js',
    'runtimeContracts.js',
    'backgroundClient.js',
    'playerShortcuts.js'
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, file)), true, `${file} should exist`);
  }
});
