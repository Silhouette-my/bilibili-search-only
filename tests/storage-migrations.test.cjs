const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SHARED_SOURCE = fs.readFileSync(path.join(ROOT, 'lockShared.js'), 'utf8');
const SCHEMA_SOURCE = fs.readFileSync(path.join(ROOT, 'storageSchema.js'), 'utf8');

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadStorageSchema() {
  const context = vm.createContext({
    URL,
    Date,
    Math,
    console
  });
  vm.runInContext(SHARED_SOURCE, context, { filename: 'lockShared.js' });
  vm.runInContext(SCHEMA_SOURCE, context, { filename: 'storageSchema.js' });
  return {
    shared: context.BiliFocusShared,
    schema: context.BiliFocusStorageSchema
  };
}

test('legacy scattered storage migrates idempotently without dropping user rules', () => {
  const { schema } = loadStorageSchema();
  const sync = {
    redirectEnabled: false,
    siteBlockEnabled: true,
    playerMaskEnabled: true,
    autoPlayOffEnabled: false,
    searchMaskEnabled: true,
    lockConfig: {
      weeklyScheduleEnabled: true,
      weeklyWindows: [
        {
          weekday: 2,
          startMinutes: 1380,
          endMinutes: 120,
          label: 'deep-work'
        },
        {
          id: 'kept-id',
          weekday: 5,
          startMinutes: 600,
          endMinutes: 660
        }
      ],
      dailyUsageLimit: {
        enabled: true,
        limitMinutes: 90,
        resetMinutesAfterMidnight: 180,
        futureDailyField: 'preserved'
      },
      blockConditions: {
        schedule: true,
        focus: false,
        dailyLimit: true
      },
      strictModeEnabled: true,
      futureRuleField: { enabled: true }
    },
    appearanceConfig: {
      theme: 'dark',
      futureAppearanceField: 'preserved'
    },
    playerShortcutConfig: {
      enabled: true,
      bindings: {
        toggleSubtitle: {
          code: 'KeyC',
          ctrl: false,
          alt: false,
          shift: false,
          meta: false
        }
      },
      futureShortcutField: 'preserved'
    },
    unknownSyncKey: { keep: true }
  };
  const local = {
    effectiveFeatureState: {
      siteBlockEnabled: true,
      redirectEnabled: false
    },
    lockStatus: {
      active: true,
      reasons: ['schedule'],
      futureStatusField: 'preserved'
    },
    focusSession: {
      startedAt: 1000,
      endsAt: 2000
    },
    usageState: {
      dayKey: '2026-07-30',
      accumulatedMs: 45000,
      exceeded: false,
      lastPingByTab: { 7: 1234 }
    },
    siteBlockOverrideDisabled: true,
    strictConfigSnapshot: sync.lockConfig,
    unknownLocalKey: ['keep']
  };
  const originalSync = plain(sync);
  const originalLocal = plain(local);

  const first = schema.migrateStorageState(sync, local);
  assert.equal(first.changed, true);
  assert.equal(first.sync.configSchemaVersion, schema.CONFIG_SCHEMA_VERSION);
  assert.equal(first.local.runtimeSchemaVersion, schema.RUNTIME_SCHEMA_VERSION);
  assert.equal(first.sync.redirectEnabled, false);
  assert.deepEqual(
    plain(first.sync.lockConfig.lockedFeatureKeys),
    ['siteBlockEnabled']
  );
  assert.equal(first.sync.lockConfig.weeklyWindows.length, 2);
  assert.match(
    first.sync.lockConfig.weeklyWindows[0].id,
    /^legacy-window-0-[0-9a-f]{8}$/
  );
  assert.equal(first.sync.lockConfig.weeklyWindows[0].label, 'deep-work');
  assert.equal(first.sync.lockConfig.weeklyWindows[1].id, 'kept-id');
  assert.deepEqual(
    plain(first.sync.lockConfig.futureRuleField),
    { enabled: true }
  );
  assert.equal(
    first.sync.lockConfig.dailyUsageLimit.futureDailyField,
    'preserved'
  );
  assert.deepEqual(plain(first.sync.unknownSyncKey), { keep: true });
  assert.equal(first.sync.playerShortcutConfig.bindings.toggleSubtitle.code, 'KeyC');
  assert.equal(first.sync.playerShortcutConfig.futureShortcutField, 'preserved');
  assert.deepEqual(plain(first.local.unknownLocalKey), ['keep']);
  assert.equal(first.local.lockStatus.futureStatusField, 'preserved');
  assert.deepEqual(plain(first.local.featureOverrideDisabled), {
    siteBlockEnabled: true,
    redirectEnabled: false,
    playerMaskEnabled: false,
    autoPlayOffEnabled: false,
    searchMaskEnabled: false
  });
  assert.match(
    first.local.strictConfigSnapshot.weeklyWindows[0].id,
    /^legacy-window-0-[0-9a-f]{8}$/
  );
  assert.deepEqual(sync, originalSync);
  assert.deepEqual(local, originalLocal);

  const second = schema.migrateStorageState(first.sync, first.local);
  assert.equal(second.changed, false);
  assert.deepEqual(plain(second.syncUpdates), {});
  assert.deepEqual(plain(second.localUpdates), {});
  assert.deepEqual(plain(second.sync), plain(first.sync));
  assert.deepEqual(plain(second.local), plain(first.local));
});

test('invalid fields fall back to conservative typed defaults', () => {
  const { shared, schema } = loadStorageSchema();
  const result = schema.migrateStorageState({
    siteBlockEnabled: 'yes',
    redirectEnabled: null,
    playerMaskEnabled: 1,
    autoPlayOffEnabled: {},
    searchMaskEnabled: [],
    lockConfig: {
      weeklyScheduleEnabled: 'false',
      weeklyWindows: 'not-an-array',
      dailyUsageLimit: {
        enabled: 'true',
        limitMinutes: 'not-a-number',
        resetMinutesAfterMidnight: -100
      },
      blockConditions: {
        schedule: 'false',
        focus: 0,
        dailyLimit: null
      },
      strictModeEnabled: 'false'
    },
    appearanceConfig: {
      theme: 'unknown'
    },
    playerShortcutConfig: {
      enabled: 'yes',
      bindings: {
        togglePlay: { code: 'Escape' },
        speedUp: { code: 'KeyS', ctrl: true },
        speedDown: { code: 'KeyS', ctrl: true },
        unknownAction: { code: 'KeyZ' }
      }
    }
  }, {
    effectiveFeatureState: 'invalid',
    lockStatus: 'invalid',
    focusSession: {
      endsAt: 'bad',
      startedAt: Infinity
    },
    usageState: {
      accumulatedMs: -1,
      lastPingByTab: 'invalid'
    },
    siteBlockOverrideDisabled: 'true',
    strictConfigSnapshot: null
  });

  assert.deepEqual(
    plain(shared.ensureFeaturePreferences(result.sync)),
    plain(shared.DEFAULT_FEATURE_PREFERENCES)
  );
  assert.equal(result.sync.lockConfig.weeklyScheduleEnabled, false);
  assert.deepEqual(plain(result.sync.lockConfig.weeklyWindows), []);
  assert.equal(result.sync.lockConfig.dailyUsageLimit.enabled, false);
  assert.equal(result.sync.lockConfig.dailyUsageLimit.limitMinutes, 120);
  assert.equal(result.sync.lockConfig.dailyUsageLimit.resetMinutesAfterMidnight, 0);
  assert.deepEqual(plain(result.sync.lockConfig.blockConditions), {
    schedule: true,
    focus: true,
    dailyLimit: true
  });
  assert.equal(result.sync.lockConfig.strictModeEnabled, true);
  assert.equal(result.sync.appearanceConfig.theme, 'light');
  assert.equal(result.sync.playerShortcutConfig.enabled, true);
  assert.equal(result.sync.playerShortcutConfig.bindings.togglePlay, null);
  assert.equal(result.sync.playerShortcutConfig.bindings.speedDown.code, 'KeyS');
  assert.equal(result.sync.playerShortcutConfig.bindings.speedUp, null);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      result.sync.playerShortcutConfig.bindings,
      'unknownAction'
    ),
    false
  );
  assert.equal(result.local.siteBlockOverrideDisabled, false);
  assert.equal(result.local.focusSession.endsAt, null);
  assert.equal(result.local.usageState.accumulatedMs, 0);
  assert.deepEqual(plain(result.local.usageState.lastPingByTab), {});
});

test('feature lock fields migrate with normalized keys, overrides, and snapshots', () => {
  const { schema } = loadStorageSchema();
  const result = schema.migrateStorageState({
    lockConfig: {
      lockedFeatureKeys: [
        'redirectEnabled',
        'unknownFeature',
        'redirectEnabled',
        'playerMaskEnabled'
      ]
    }
  }, {
    siteBlockOverrideDisabled: true,
    featureOverrideDisabled: {
      redirectEnabled: true,
      playerMaskEnabled: false,
      unknownFeature: true
    },
    strictFeaturePreferencesSnapshot: {
      siteBlockEnabled: true,
      redirectEnabled: false,
      playerMaskEnabled: 'invalid',
      autoPlayOffEnabled: false,
      searchMaskEnabled: true
    }
  });

  assert.deepEqual(plain(result.sync.lockConfig.lockedFeatureKeys), [
    'redirectEnabled',
    'playerMaskEnabled'
  ]);
  assert.deepEqual(plain(result.local.featureOverrideDisabled), {
    siteBlockEnabled: true,
    redirectEnabled: true,
    playerMaskEnabled: false,
    autoPlayOffEnabled: false,
    searchMaskEnabled: false
  });
  assert.deepEqual(plain(result.local.strictFeaturePreferencesSnapshot), {
    siteBlockEnabled: true,
    redirectEnabled: false,
    playerMaskEnabled: true,
    autoPlayOffEnabled: false,
    searchMaskEnabled: true
  });

  const second = schema.migrateStorageState(result.sync, result.local);
  assert.equal(second.changed, false);
  assert.deepEqual(plain(second.syncUpdates), {});
  assert.deepEqual(plain(second.localUpdates), {});
});

test('future schema versions are preserved instead of being downgraded', () => {
  const { schema } = loadStorageSchema();
  const sync = {
    configSchemaVersion: schema.CONFIG_SCHEMA_VERSION + 2,
    lockConfig: { futureShape: true },
    future: 'sync'
  };
  const local = {
    runtimeSchemaVersion: schema.RUNTIME_SCHEMA_VERSION + 3,
    runtimeSnapshot: { futureShape: true },
    future: 'local'
  };
  const result = schema.migrateStorageState(sync, local);

  assert.equal(result.changed, false);
  assert.deepEqual(plain(result.sync), sync);
  assert.deepEqual(plain(result.local), local);
  assert.deepEqual(plain(result.syncUpdates), {});
  assert.deepEqual(plain(result.localUpdates), {});
  assert.deepEqual(plain(result.unsupportedFutureVersion), {
    config: schema.CONFIG_SCHEMA_VERSION + 2,
    runtime: schema.RUNTIME_SCHEMA_VERSION + 3
  });
});
