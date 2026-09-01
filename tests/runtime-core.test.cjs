const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

process.env.TZ = 'America/New_York';

const ROOT = path.resolve(__dirname, '..');
const SHARED_SOURCE = fs.readFileSync(path.join(ROOT, 'lockShared.js'), 'utf8');
const CORE_SOURCE = fs.readFileSync(path.join(ROOT, 'runtimeCore.js'), 'utf8');

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadRuntimeCore() {
  const context = vm.createContext({
    URL,
    Date,
    Math,
    console
  });
  vm.runInContext(SHARED_SOURCE, context, { filename: 'lockShared.js' });
  vm.runInContext(CORE_SOURCE, context, { filename: 'runtimeCore.js' });
  return {
    shared: context.BiliFocusShared,
    core: context.BiliFocusRuntimeCore
  };
}

function createLockConfig(overrides = {}) {
  return {
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
    lockedFeatureKeys: ['siteBlockEnabled'],
    strictModeEnabled: true,
    ...overrides
  };
}

test('strict restoration protects active rules without mutating either input', () => {
  const { core } = loadRuntimeCore();
  const baseline = createLockConfig({
    weeklyScheduleEnabled: true,
    weeklyWindows: [{
      id: 'protected',
      weekday: 2,
      startMinutes: 540,
      endMinutes: 1080
    }]
  });
  const proposed = createLockConfig({
    weeklyScheduleEnabled: false,
    weeklyWindows: [],
    dailyUsageLimit: {
      enabled: true,
      limitMinutes: 300,
      resetMinutesAfterMidnight: 60
    },
    strictModeEnabled: false
  });
  const originalBaseline = plain(baseline);
  const originalProposed = plain(proposed);

  const result = core.restoreProtectedLockConfig(baseline, proposed, {
    enforced: true,
    strictModeEnabled: true,
    lockedBySchedule: true,
    lockedByDailyLimit: false
  });

  assert.equal(result.corrected, true);
  assert.equal(result.config.weeklyScheduleEnabled, true);
  assert.deepEqual(plain(result.config.weeklyWindows), baseline.weeklyWindows);
  assert.equal(result.config.strictModeEnabled, true);
  assert.equal(result.config.dailyUsageLimit.limitMinutes, 300);
  assert.deepEqual(baseline, originalBaseline);
  assert.deepEqual(proposed, originalProposed);
});

test('strict feature locks force selected features on and restore protected preferences', () => {
  const { shared, core } = loadRuntimeCore();
  const now = new Date(2026, 0, 7, 12, 0, 0, 0);
  const lockConfig = createLockConfig({
    lockedFeatureKeys: ['redirectEnabled', 'playerMaskEnabled']
  });
  const syncState = {
    ...plain(shared.DEFAULT_FEATURE_PREFERENCES),
    redirectEnabled: false,
    playerMaskEnabled: false,
    searchMaskEnabled: true,
    lockConfig
  };
  const localState = {
    effectiveFeatureState: plain(shared.DEFAULT_EFFECTIVE_FEATURE_STATE),
    lockStatus: plain(shared.DEFAULT_LOCK_STATUS),
    focusSession: {
      startedAt: now.getTime() - 1000,
      endsAt: now.getTime() + 60000
    },
    usageState: plain(shared.DEFAULT_USAGE_STATE),
    featureOverrideDisabled: plain(shared.DEFAULT_FEATURE_OVERRIDE_DISABLED),
    siteBlockOverrideDisabled: false,
    strictConfigSnapshot: null,
    strictFeaturePreferencesSnapshot: null
  };

  const first = core.evaluateRuntimeState({ now, syncState, localState });
  assert.equal(first.lockStatus.panelLocked, true);
  assert.equal(first.effectiveFeatureState.siteBlockEnabled, false);
  assert.equal(first.effectiveFeatureState.redirectEnabled, true);
  assert.equal(first.effectiveFeatureState.playerMaskEnabled, true);
  assert.equal(first.desiredLocalState.strictFeaturePreferencesSnapshot.redirectEnabled, false);

  const tamperedSync = {
    ...syncState,
    redirectEnabled: true,
    searchMaskEnabled: false
  };
  const repaired = core.evaluateRuntimeState({
    now,
    syncState: tamperedSync,
    localState: first.desiredLocalState
  });

  assert.equal(repaired.correctedFeaturePreferences, true);
  assert.equal(repaired.featurePreferences.redirectEnabled, false);
  assert.equal(repaired.featurePreferences.searchMaskEnabled, false);
  assert.deepEqual(plain(repaired.syncUpdates), { redirectEnabled: false });
  assert.equal(repaired.effectiveFeatureState.redirectEnabled, true);
});

test('strict rules do not lock the panel when no automatic feature is selected', () => {
  const { shared, core } = loadRuntimeCore();
  const now = new Date(2026, 0, 7, 12, 0, 0, 0);
  const syncState = {
    ...plain(shared.DEFAULT_FEATURE_PREFERENCES),
    lockConfig: createLockConfig({ lockedFeatureKeys: [] })
  };
  const localState = {
    effectiveFeatureState: plain(shared.DEFAULT_EFFECTIVE_FEATURE_STATE),
    lockStatus: plain(shared.DEFAULT_LOCK_STATUS),
    focusSession: {
      startedAt: now.getTime() - 1000,
      endsAt: now.getTime() + 60000
    },
    usageState: plain(shared.DEFAULT_USAGE_STATE),
    featureOverrideDisabled: plain(shared.DEFAULT_FEATURE_OVERRIDE_DISABLED),
    siteBlockOverrideDisabled: false,
    strictConfigSnapshot: null,
    strictFeaturePreferencesSnapshot: null
  };

  const result = core.evaluateRuntimeState({ now, syncState, localState });
  assert.equal(result.lockStatus.restrictionTriggered, true);
  assert.equal(result.lockStatus.enforced, false);
  assert.equal(result.lockStatus.panelLocked, false);
  assert.equal(result.desiredLocalState.strictConfigSnapshot, null);
  assert.equal(result.desiredLocalState.strictFeaturePreferencesSnapshot, null);
});

test('non-strict feature overrides temporarily release selected automatic features', () => {
  const { shared, core } = loadRuntimeCore();
  const now = new Date(2026, 0, 7, 12, 0, 0, 0);
  const syncState = {
    ...plain(shared.DEFAULT_FEATURE_PREFERENCES),
    redirectEnabled: false,
    lockConfig: createLockConfig({
      strictModeEnabled: false,
      lockedFeatureKeys: ['redirectEnabled']
    })
  };
  const localState = {
    effectiveFeatureState: plain(shared.DEFAULT_EFFECTIVE_FEATURE_STATE),
    lockStatus: plain(shared.DEFAULT_LOCK_STATUS),
    focusSession: {
      startedAt: now.getTime() - 1000,
      endsAt: now.getTime() + 60000
    },
    usageState: plain(shared.DEFAULT_USAGE_STATE),
    featureOverrideDisabled: plain(shared.DEFAULT_FEATURE_OVERRIDE_DISABLED),
    siteBlockOverrideDisabled: false,
    strictConfigSnapshot: null,
    strictFeaturePreferencesSnapshot: null
  };

  const forced = core.evaluateRuntimeState({ now, syncState, localState });
  assert.equal(forced.lockStatus.panelLocked, false);
  assert.equal(forced.effectiveFeatureState.redirectEnabled, true);

  const overridden = core.evaluateRuntimeState({
    now,
    syncState,
    localState: {
      ...forced.desiredLocalState,
      featureOverrideDisabled: {
        ...forced.desiredLocalState.featureOverrideDisabled,
        redirectEnabled: true
      }
    }
  });
  assert.equal(overridden.effectiveFeatureState.redirectEnabled, false);
  assert.equal(overridden.desiredLocalState.featureOverrideDisabled.redirectEnabled, true);

  const expired = core.evaluateRuntimeState({
    now: new Date(now.getTime() + 120000),
    syncState,
    localState: overridden.desiredLocalState
  });
  assert.equal(expired.effectiveFeatureState.redirectEnabled, false);
  assert.equal(expired.desiredLocalState.featureOverrideDisabled.redirectEnabled, false);
});

test('usage pruning resets logical days and removes only stale tab heartbeats', () => {
  const { shared, core } = loadRuntimeCore();
  const now = new Date(2026, 2, 8, 12, 0, 0, 0);
  const dayInfo = shared.getLogicalDayInfo(now, 240);
  const usage = {
    dayKey: dayInfo.dayKey,
    accumulatedMs: 45000,
    exceeded: false,
    limitExceededAt: null,
    lastPingByTab: {
      1: now.getTime() - 30000,
      2: now.getTime() - 61000,
      bad: 'not-a-time'
    }
  };
  const original = plain(usage);
  const currentDay = core.pruneUsageState(now, usage, 240);

  assert.deepEqual(plain(currentDay.usageState.lastPingByTab), {
    1: now.getTime() - 30000
  });
  assert.equal(currentDay.usageState.accumulatedMs, 45000);
  assert.deepEqual(usage, original);

  const nextDay = new Date(2026, 2, 9, 12, 0, 0, 0);
  const reset = core.pruneUsageState(nextDay, usage, 240);
  assert.equal(reset.usageState.accumulatedMs, 0);
  assert.deepEqual(plain(reset.usageState.lastPingByTab), {});
  assert.notEqual(reset.usageState.dayKey, usage.dayKey);
});

test('stable timestamps and changed-value patches ignore semantic no-ops', () => {
  const { shared, core } = loadRuntimeCore();
  const previous = {
    ...plain(shared.DEFAULT_LOCK_STATUS),
    updatedAt: 1000
  };
  const unchanged = core.withStableLockStatusTimestamp(
    previous,
    previous,
    new Date(5000)
  );
  assert.equal(unchanged.updatedAt, 1000);

  const changed = core.withStableLockStatusTimestamp(
    { ...previous, enforced: true },
    previous,
    new Date(5000)
  );
  assert.equal(changed.updatedAt, 5000);
  assert.deepEqual(
    plain(core.getChangedLocalValues(
      { stable: { enabled: true }, old: 1 },
      { stable: { enabled: true }, next: 2 }
    )),
    { next: 2 }
  );
});

test('overnight schedules expose today’s end boundary and unlock at that boundary', () => {
  const { core } = loadRuntimeCore();
  const scheduleStart = new Date(2026, 0, 6, 23, 0, 0, 0);
  const now = new Date(2026, 0, 7, 1, 0, 0, 0);
  const overnightWindow = {
    id: 'overnight',
    weekday: scheduleStart.getDay(),
    startMinutes: 23 * 60,
    endMinutes: 2 * 60
  };
  const lockConfig = createLockConfig({
    weeklyScheduleEnabled: true,
    weeklyWindows: [overnightWindow]
  });
  const boundaries = core.getUpcomingScheduleBoundaries(
    now,
    lockConfig.weeklyWindows
  );
  const firstBoundary = new Date(boundaries[0]);

  assert.equal(firstBoundary.getDate(), now.getDate());
  assert.equal(firstBoundary.getHours(), 2);
  assert.equal(firstBoundary.getMinutes(), 0);
  assert.equal(core.computeNextUnlockAt(now, {
    focusActive: false,
    focusSession: {},
    dailyExceeded: false,
    dailyInfo: null,
    scheduleActive: true,
    lockConfig
  }), boundaries[0]);
});

test('schedule boundaries remain monotonic across spring and fall DST transitions', () => {
  const { core } = loadRuntimeCore();
  const cases = [
    {
      label: 'spring-forward',
      now: new Date(2026, 2, 8, 1, 45, 0, 0),
      startMinutes: 90,
      endMinutes: 210,
      expectedHour: 3,
      expectedMinute: 30
    },
    {
      label: 'fall-back',
      now: new Date(2026, 10, 1, 1, 45, 0, 0),
      startMinutes: 90,
      endMinutes: 150,
      expectedHour: 2,
      expectedMinute: 30
    }
  ];

  cases.forEach((item) => {
    const boundaries = core.getUpcomingScheduleBoundaries(item.now, [{
      id: item.label,
      weekday: item.now.getDay(),
      startMinutes: item.startMinutes,
      endMinutes: item.endMinutes
    }]);
    const boundary = new Date(boundaries[0]);

    assert.ok(boundary.getTime() > item.now.getTime(), item.label);
    assert.equal(boundary.getHours(), item.expectedHour, item.label);
    assert.equal(boundary.getMinutes(), item.expectedMinute, item.label);
  });
});

test('evaluateRuntimeState produces deterministic patches and idempotent snapshots', () => {
  const { shared, core } = loadRuntimeCore();
  const scheduleStart = new Date(2026, 0, 6, 23, 0, 0, 0);
  const now = new Date(2026, 0, 7, 1, 0, 0, 0);
  const lockConfig = createLockConfig({
    weeklyScheduleEnabled: true,
    weeklyWindows: [{
      id: 'night',
      weekday: scheduleStart.getDay(),
      startMinutes: 23 * 60,
      endMinutes: 2 * 60
    }]
  });
  const syncState = {
    ...plain(shared.DEFAULT_FEATURE_PREFERENCES),
    siteBlockEnabled: false,
    lockConfig
  };
  const localState = {
    effectiveFeatureState: plain(shared.DEFAULT_EFFECTIVE_FEATURE_STATE),
    lockStatus: plain(shared.DEFAULT_LOCK_STATUS),
    focusSession: plain(shared.DEFAULT_FOCUS_SESSION),
    usageState: plain(shared.DEFAULT_USAGE_STATE),
    siteBlockOverrideDisabled: false,
    strictConfigSnapshot: null
  };
  const originalSync = plain(syncState);
  const originalLocal = plain(localState);

  const first = core.evaluateRuntimeState({ now, syncState, localState });
  assert.equal(first.lockStatus.enforced, true);
  assert.deepEqual(plain(first.lockStatus.restrictionReasons), ['schedule']);
  assert.equal(first.effectiveFeatureState.siteBlockEnabled, true);
  assert.equal(first.effects.blockOpenBilibiliTabs, true);
  assert.deepEqual(plain(first.syncUpdates), {});
  assert.ok(Object.keys(first.localUpdates).length > 0);

  const second = core.evaluateRuntimeState({
    now,
    syncState,
    localState: first.desiredLocalState
  });
  assert.deepEqual(plain(second.localUpdates), {});
  assert.equal(second.lockStatus.updatedAt, first.lockStatus.updatedAt);
  assert.equal(second.effects.blockOpenBilibiliTabs, false);
  assert.deepEqual(syncState, originalSync);
  assert.deepEqual(localState, originalLocal);
});

test('raising or disabling a daily limit clears stale exceeded state', () => {
  const { shared, core } = loadRuntimeCore();
  const now = new Date(2026, 0, 7, 12, 0, 0, 0);
  const dailyInfo = shared.getLogicalDayInfo(now, 240);
  const localState = {
    effectiveFeatureState: plain(shared.DEFAULT_EFFECTIVE_FEATURE_STATE),
    lockStatus: plain(shared.DEFAULT_LOCK_STATUS),
    focusSession: plain(shared.DEFAULT_FOCUS_SESSION),
    usageState: {
      dayKey: dailyInfo.dayKey,
      accumulatedMs: 30 * 60 * 1000,
      exceeded: true,
      limitExceededAt: now.getTime() - 1000,
      lastPingByTab: {}
    },
    siteBlockOverrideDisabled: false,
    strictConfigSnapshot: null
  };
  const syncState = {
    ...plain(shared.DEFAULT_FEATURE_PREFERENCES),
    lockConfig: createLockConfig({
      dailyUsageLimit: {
        enabled: true,
        limitMinutes: 60,
        resetMinutesAfterMidnight: 240
      }
    })
  };

  const raised = core.evaluateRuntimeState({ now, syncState, localState });
  assert.equal(raised.usageState.exceeded, false);
  assert.equal(raised.usageState.limitExceededAt, null);
  assert.equal(raised.lockStatus.lockedByDailyLimit, false);

  syncState.lockConfig.dailyUsageLimit.enabled = false;
  const disabled = core.evaluateRuntimeState({ now, syncState, localState });
  assert.equal(disabled.usageState.exceeded, false);
  assert.equal(disabled.usageState.limitExceededAt, null);
});
