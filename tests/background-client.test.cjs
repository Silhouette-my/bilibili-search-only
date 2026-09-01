const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const CONTRACTS_SOURCE = fs.readFileSync(
  path.join(ROOT, 'runtimeContracts.js'),
  'utf8'
);
const CLIENT_SOURCE = fs.readFileSync(
  path.join(ROOT, 'backgroundClient.js'),
  'utf8'
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createClientHarness() {
  const calls = [];
  const pending = [];
  const storageListeners = [];
  const context = vm.createContext({
    Promise,
    console,
    queueMicrotask
  });

  context.chrome = {
    runtime: {
      sendMessage(message) {
        const response = deferred();
        calls.push(plain(message));
        pending.push(response);
        return response.promise;
      }
    },
    storage: {
      onChanged: {
        addListener(listener) {
          storageListeners.push(listener);
        },
        removeListener(listener) {
          const index = storageListeners.indexOf(listener);
          if (index >= 0) storageListeners.splice(index, 1);
        }
      }
    }
  };

  vm.runInContext(CONTRACTS_SOURCE, context, {
    filename: 'runtimeContracts.js'
  });
  vm.runInContext(CLIENT_SOURCE, context, {
    filename: 'backgroundClient.js'
  });

  return {
    calls,
    client: context.BiliFocusClient,
    pending,
    storageListeners
  };
}

test('a fresh state request follows an in-flight cached request', async () => {
  const harness = createClientHarness();
  const cachedRequest = harness.client.getState({ refresh: false });
  const freshRequest = harness.client.getState({ refresh: true });

  assert.deepEqual(harness.calls, [{
    type: 'BF_GET_STATE',
    refresh: false
  }]);

  harness.pending[0].resolve({
    ok: true,
    snapshot: { revision: 1, marker: 'cached' }
  });
  assert.deepEqual(plain(await cachedRequest), {
    revision: 1,
    marker: 'cached'
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.calls[1], {
    type: 'BF_GET_STATE',
    refresh: true
  });

  harness.pending[1].resolve({
    ok: true,
    snapshot: { revision: 2, marker: 'fresh' }
  });
  assert.deepEqual(plain(await freshRequest), {
    revision: 2,
    marker: 'fresh'
  });
});

test('an older response cannot replace a newer command snapshot', async () => {
  const harness = createClientHarness();
  const observedRevisions = [];
  harness.client.subscribe((snapshot) => {
    observedRevisions.push(snapshot.revision);
  });

  const slowStateRequest = harness.client.getState({ refresh: true });
  const commandRequest = harness.client.updatePreference(
    'redirectEnabled',
    false
  );
  assert.equal(harness.calls.length, 2);

  harness.pending[1].resolve({
    ok: true,
    snapshot: { revision: 2, marker: 'command' }
  });
  assert.deepEqual(plain(await commandRequest), {
    revision: 2,
    marker: 'command'
  });

  harness.pending[0].resolve({
    ok: true,
    snapshot: { revision: 1, marker: 'stale' }
  });
  assert.deepEqual(plain(await slowStateRequest), {
    revision: 2,
    marker: 'command'
  });
  assert.deepEqual(observedRevisions, [2]);
  assert.deepEqual(plain(harness.client.getCachedState()), {
    revision: 2,
    marker: 'command'
  });
});

test('an explicit storage reset accepts the new revision epoch', async () => {
  const harness = createClientHarness();
  harness.client.subscribe(() => {});

  const initialRequest = harness.client.getState({ refresh: true });
  harness.pending[0].resolve({
    ok: true,
    snapshot: { revision: 9, marker: 'before-reset' }
  });
  await initialRequest;

  harness.storageListeners[0]({
    stateRevision: {
      oldValue: 9,
      newValue: undefined
    }
  }, 'local');
  assert.equal(harness.calls.length, 2);
  harness.pending[1].resolve({
    ok: true,
    snapshot: { revision: 1, marker: 'after-reset' }
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(plain(harness.client.getCachedState()), {
    revision: 1,
    marker: 'after-reset'
  });
});

test('runtime subscriptions release their storage listener when idle', () => {
  const harness = createClientHarness();
  const unsubscribe = harness.client.subscribe(() => {});
  assert.equal(harness.storageListeners.length, 1);

  unsubscribe();
  assert.equal(harness.storageListeners.length, 0);
});

test('ensureRuntime delegates navigation policy wake-up to the background', async () => {
  const harness = createClientHarness();
  const request = harness.client.ensureRuntime();
  assert.deepEqual(harness.calls, [{ type: 'BF_ENSURE_RUNTIME' }]);

  harness.pending[0].resolve({
    ok: true,
    snapshot: { revision: 4, marker: 'authoritative' }
  });
  assert.deepEqual(plain(await request), {
    revision: 4,
    marker: 'authoritative'
  });
});

test('same-revision duplicates and regressing usage snapshots are ignored', async () => {
  const harness = createClientHarness();
  const observedUsage = [];
  harness.client.subscribe((snapshot) => {
    observedUsage.push(snapshot.usageState.accumulatedMs);
  });
  const authoritative = {
    revision: 6,
    usageState: {
      dayKey: '2026-07-30',
      accumulatedMs: 120
    }
  };

  const initial = harness.client.getState({ refresh: true });
  harness.pending[0].resolve({ ok: true, snapshot: authoritative });
  await initial;

  const duplicate = harness.client.getState({ refresh: true });
  harness.pending[1].resolve({ ok: true, snapshot: authoritative });
  await duplicate;

  const staleUsage = harness.client.getState({ refresh: true });
  harness.pending[2].resolve({
    ok: true,
    snapshot: {
      ...authoritative,
      usageState: {
        ...authoritative.usageState,
        accumulatedMs: 80
      }
    }
  });
  assert.equal((await staleUsage).usageState.accumulatedMs, 120);
  assert.deepEqual(observedUsage, [120]);
});

test('preference commands retry when only unrelated runtime state advanced', async () => {
  const harness = createClientHarness();
  const initialSnapshot = {
    revision: 10,
    featurePreferences: { redirectEnabled: true },
    lockConfig: { strictModeEnabled: true },
    appearanceConfig: { theme: 'light' }
  };
  const initialRequest = harness.client.getState({ refresh: true });
  harness.pending[0].resolve({ ok: true, snapshot: initialSnapshot });
  await initialRequest;

  const command = harness.client.updatePreference('redirectEnabled', false);
  assert.deepEqual(harness.calls[1], {
    type: 'BF_UPDATE_PREFERENCE',
    baseRevision: 10,
    key: 'redirectEnabled',
    value: false,
    basePreferenceValue: true
  });

  harness.pending[1].resolve({
    ok: false,
    error: {
      code: 'state_conflict',
      message: '状态已更新，请刷新后重试。'
    },
    snapshot: {
      ...initialSnapshot,
      revision: 11,
      usageState: { accumulatedMs: 100 }
    }
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.calls[2], {
    type: 'BF_UPDATE_PREFERENCE',
    baseRevision: 11,
    key: 'redirectEnabled',
    value: false,
    basePreferenceValue: true
  });
  harness.pending[2].resolve({
    ok: true,
    snapshot: {
      ...initialSnapshot,
      revision: 12,
      featurePreferences: { redirectEnabled: false }
    }
  });

  assert.equal((await command).featurePreferences.redirectEnabled, false);
});

test('preference commands preserve conflicts on the same preference', async () => {
  const harness = createClientHarness();
  const initialRequest = harness.client.getState({ refresh: true });
  harness.pending[0].resolve({
    ok: true,
    snapshot: {
      revision: 20,
      featurePreferences: { redirectEnabled: true }
    }
  });
  await initialRequest;

  const command = harness.client.updatePreference('redirectEnabled', false);
  harness.pending[1].resolve({
    ok: false,
    error: {
      code: 'state_conflict',
      message: '状态已更新，请刷新后重试。'
    },
    snapshot: {
      revision: 21,
      featurePreferences: { redirectEnabled: false }
    }
  });

  await assert.rejects(command, (error) => error.code === 'state_conflict');
  assert.equal(harness.calls.length, 2);
});

test('settings save retries runtime-only conflicts without hiding real setting changes', async () => {
  const harness = createClientHarness();
  const originalLockConfig = { strictModeEnabled: true };
  const originalAppearanceConfig = { theme: 'light' };
  const originalShortcutConfig = {
    enabled: true,
    bindings: { togglePlay: null }
  };
  const initialSnapshot = {
    revision: 30,
    featurePreferences: { redirectEnabled: true },
    lockConfig: originalLockConfig,
    appearanceConfig: originalAppearanceConfig,
    playerShortcutConfig: originalShortcutConfig
  };
  const initialRequest = harness.client.getState({ refresh: true });
  harness.pending[0].resolve({ ok: true, snapshot: initialSnapshot });
  await initialRequest;

  const baselineSignature = JSON.stringify({
    lockConfig: originalLockConfig,
    appearanceConfig: originalAppearanceConfig,
    playerShortcutConfig: originalShortcutConfig
  });
  const nextLockConfig = { strictModeEnabled: false };
  const nextAppearanceConfig = { theme: 'dark' };
  const nextShortcutConfig = {
    enabled: true,
    bindings: {
      togglePlay: {
        code: 'KeyP',
        ctrl: false,
        alt: false,
        shift: false,
        meta: false
      }
    }
  };
  const save = harness.client.saveSettings(
    nextLockConfig,
    nextAppearanceConfig,
    30,
    baselineSignature,
    nextShortcutConfig
  );
  harness.pending[1].resolve({
    ok: false,
    error: {
      code: 'state_conflict',
      message: '状态已更新，请刷新后重试。'
    },
    snapshot: {
      ...initialSnapshot,
      revision: 31,
      usageState: { accumulatedMs: 200 }
    }
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.calls[2].baseRevision, 31);
  assert.deepEqual(harness.calls[2].lockConfig, nextLockConfig);
  assert.deepEqual(harness.calls[2].appearanceConfig, nextAppearanceConfig);
  assert.deepEqual(harness.calls[2].playerShortcutConfig, nextShortcutConfig);
  harness.pending[2].resolve({
    ok: true,
    snapshot: {
      ...initialSnapshot,
      revision: 32,
      lockConfig: nextLockConfig,
      appearanceConfig: nextAppearanceConfig,
      playerShortcutConfig: nextShortcutConfig
    }
  });
  assert.equal((await save).appearanceConfig.theme, 'dark');

  const conflictingSave = harness.client.saveSettings(
    originalLockConfig,
    originalAppearanceConfig,
    32,
    JSON.stringify({
      lockConfig: nextLockConfig,
      appearanceConfig: nextAppearanceConfig,
      playerShortcutConfig: nextShortcutConfig
    }),
    originalShortcutConfig
  );
  harness.pending[3].resolve({
    ok: false,
    error: {
      code: 'state_conflict',
      message: '状态已更新，请刷新后重试。'
    },
    snapshot: {
      ...initialSnapshot,
      revision: 33,
      lockConfig: { strictModeEnabled: true, externallyChanged: true },
      appearanceConfig: nextAppearanceConfig,
      playerShortcutConfig: nextShortcutConfig
    }
  });

  await assert.rejects(
    conflictingSave,
    (error) => error.code === 'state_conflict'
  );
  assert.equal(harness.calls.length, 4);
});
