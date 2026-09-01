(function (global) {
  'use strict';

  const DAY_IN_MS = 24 * 60 * 60 * 1000;
  const DEFAULT_SCHEDULE_LOOKAHEAD_DAYS = 8;

  function getShared(sharedOverride) {
    const shared = sharedOverride || global.BiliFocusShared;
    const requiredFunctions = [
      'ensureFeaturePreferences',
      'ensureLockConfig',
      'ensureFocusSession',
      'ensureUsageState',
      'ensureLockStatus',
      'ensureEffectiveFeatureState',
      'getLogicalDayInfo',
      'getActiveWeeklyWindows',
      'computeEffectiveFeatureState'
    ];

    if (
      !shared ||
      requiredFunctions.some((name) => typeof shared[name] !== 'function')
    ) {
      throw new Error('BiliFocusRuntimeCore requires the BiliFocusShared contract.');
    }

    return shared;
  }

  function toDate(value) {
    const date = value instanceof Date
      ? new Date(value.getTime())
      : new Date(value === undefined ? Date.now() : value);

    if (!Number.isFinite(date.getTime())) {
      throw new TypeError('A valid evaluation time is required.');
    }

    return date;
  }

  function valuesEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function ensureFocusSessionStable(raw, shared) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const normalized = shared.ensureFocusSession(source);
    if (source.endsAt === null || source.endsAt === undefined) {
      normalized.endsAt = null;
    }
    if (source.startedAt === null || source.startedAt === undefined) {
      normalized.startedAt = null;
    }
    return normalized;
  }

  function ensureUsageStateStable(raw, shared) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const normalized = shared.ensureUsageState(source);
    if (
      source.limitExceededAt === null ||
      source.limitExceededAt === undefined
    ) {
      normalized.limitExceededAt = null;
    }
    return normalized;
  }

  function ensureLockStatusStable(raw, shared) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const normalized = shared.ensureLockStatus(source);
    if (source.nextUnlockAt === null || source.nextUnlockAt === undefined) {
      normalized.nextUnlockAt = null;
    }
    if (source.updatedAt === null || source.updatedAt === undefined) {
      normalized.updatedAt = null;
    }
    return normalized;
  }

  function getFocusSessionActive(now, focusSession) {
    const nowMs = toDate(now).getTime();
    return Boolean(focusSession && focusSession.endsAt && focusSession.endsAt > nowMs);
  }

  function getDailyExceeded(now, usageState, lockConfig, sharedOverride) {
    const shared = getShared(sharedOverride);
    const safeConfig = shared.ensureLockConfig(lockConfig);
    const safeUsageState = ensureUsageStateStable(usageState, shared);

    if (!safeConfig.dailyUsageLimit.enabled) return false;

    const info = shared.getLogicalDayInfo(
      toDate(now),
      safeConfig.dailyUsageLimit.resetMinutesAfterMidnight
    );
    if (safeUsageState.dayKey !== info.dayKey) return false;

    return safeUsageState.accumulatedMs >=
      safeConfig.dailyUsageLimit.limitMinutes * 60 * 1000;
  }

  function pruneUsageState(now, usageStateRaw, resetMinutesAfterMidnight, sharedOverride) {
    const shared = getShared(sharedOverride);
    const evaluationTime = toDate(now);
    const dailyInfo = shared.getLogicalDayInfo(
      evaluationTime,
      resetMinutesAfterMidnight
    );
    const usageState = ensureUsageStateStable(usageStateRaw, shared);

    if (usageState.dayKey !== dailyInfo.dayKey) {
      return {
        usageState: {
          dayKey: dailyInfo.dayKey,
          accumulatedMs: 0,
          exceeded: false,
          limitExceededAt: null,
          lastPingByTab: {}
        },
        dailyInfo
      };
    }

    Object.keys(usageState.lastPingByTab).forEach((tabId) => {
      const lastPing = Number(usageState.lastPingByTab[tabId]);
      if (
        !Number.isFinite(lastPing) ||
        evaluationTime.getTime() - lastPing > 60 * 1000
      ) {
        delete usageState.lastPingByTab[tabId];
      }
    });

    return { usageState, dailyInfo };
  }

  function restoreProtectedLockConfig(
    baselineRaw,
    proposedRaw,
    lockStatusRaw,
    sharedOverride
  ) {
    const shared = getShared(sharedOverride);
    const baseline = shared.ensureLockConfig(baselineRaw);
    const proposed = shared.ensureLockConfig(proposedRaw);
    const lockStatus = ensureLockStatusStable(lockStatusRaw, shared);
    const restored = shared.ensureLockConfig(proposed);

    if (!lockStatus.enforced || !lockStatus.strictModeEnabled) {
      return { config: restored, corrected: false };
    }

    restored.strictModeEnabled = baseline.strictModeEnabled;
    restored.blockConditions = { ...baseline.blockConditions };
    restored.lockedFeatureKeys = [...baseline.lockedFeatureKeys];

    if (lockStatus.lockedBySchedule && baseline.blockConditions.schedule) {
      restored.weeklyScheduleEnabled = baseline.weeklyScheduleEnabled;
      restored.weeklyWindows = baseline.weeklyWindows.map((windowConfig) => ({
        ...windowConfig
      }));
    }

    if (lockStatus.lockedByDailyLimit && baseline.blockConditions.dailyLimit) {
      restored.dailyUsageLimit = { ...baseline.dailyUsageLimit };
    }

    return {
      config: restored,
      corrected: !valuesEqual(restored, proposed)
    };
  }

  function restoreProtectedFeaturePreferences(
    baselineRaw,
    proposedRaw,
    lockedFeatureKeys,
    lockStatusRaw,
    sharedOverride
  ) {
    const shared = getShared(sharedOverride);
    const baseline = shared.ensureFeaturePreferences(baselineRaw);
    const proposed = shared.ensureFeaturePreferences(proposedRaw);
    const lockStatus = ensureLockStatusStable(lockStatusRaw, shared);
    const restored = { ...proposed };

    if (!lockStatus.enforced || !lockStatus.strictModeEnabled) {
      return { preferences: restored, corrected: false };
    }

    const protectedKeys = Array.isArray(lockedFeatureKeys) ? lockedFeatureKeys : [];
    protectedKeys.forEach((key) => {
      if (shared.FEATURE_KEYS.includes(key)) restored[key] = baseline[key];
    });

    return {
      preferences: restored,
      corrected: !valuesEqual(restored, proposed)
    };
  }

  function getCurrentStrictGuardStatus(
    now,
    baselineRaw,
    focusSessionRaw,
    usageStateRaw,
    sharedOverride
  ) {
    const shared = getShared(sharedOverride);
    const evaluationTime = toDate(now);
    const baseline = shared.ensureLockConfig(baselineRaw);
    const focusSession = ensureFocusSessionStable(focusSessionRaw, shared);
    const { usageState } = pruneUsageState(
      evaluationTime,
      usageStateRaw,
      baseline.dailyUsageLimit.resetMinutesAfterMidnight,
      shared
    );
    const lockedBySchedule = baseline.weeklyScheduleEnabled &&
      shared.getActiveWeeklyWindows(evaluationTime, baseline.weeklyWindows).length > 0;
    const lockedByFocusSession = getFocusSessionActive(evaluationTime, focusSession);
    const lockedByDailyLimit = getDailyExceeded(
      evaluationTime,
      usageState,
      baseline,
      shared
    );
    const restrictionTriggered = (
      (lockedBySchedule && baseline.blockConditions.schedule) ||
      (lockedByFocusSession && baseline.blockConditions.focus) ||
      (lockedByDailyLimit && baseline.blockConditions.dailyLimit)
    );
    const strictModeEnabled = baseline.strictModeEnabled !== false;

    return {
      enforced:
        restrictionTriggered &&
        strictModeEnabled &&
        baseline.lockedFeatureKeys.length > 0,
      strictModeEnabled,
      lockedBySchedule,
      lockedByFocusSession,
      lockedByDailyLimit
    };
  }

  function getSemanticLockStatus(lockStatus, sharedOverride) {
    const shared = getShared(sharedOverride);
    const { updatedAt, ...semanticStatus } = ensureLockStatusStable(
      lockStatus,
      shared
    );
    return semanticStatus;
  }

  function withStableLockStatusTimestamp(
    nextStatus,
    previousStatus,
    now,
    sharedOverride
  ) {
    const shared = getShared(sharedOverride);
    const evaluationTime = toDate(now);
    const previous = ensureLockStatusStable(previousStatus, shared);
    const semanticStatus = getSemanticLockStatus(nextStatus, shared);
    const unchanged = valuesEqual(
      semanticStatus,
      getSemanticLockStatus(previous, shared)
    );

    return {
      ...semanticStatus,
      updatedAt: unchanged ? previous.updatedAt : evaluationTime.getTime()
    };
  }

  function getChangedLocalValues(currentState, desiredState) {
    const current = currentState && typeof currentState === 'object'
      ? currentState
      : {};
    const desired = desiredState && typeof desiredState === 'object'
      ? desiredState
      : {};

    return Object.entries(desired).reduce((updates, [key, value]) => {
      if (!valuesEqual(current[key], value)) {
        updates[key] = value;
      }
      return updates;
    }, {});
  }

  function normalizeMinute(value, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(1439, Math.max(0, numeric));
  }

  function getUpcomingScheduleBoundaries(
    now,
    windows,
    daysAhead = DEFAULT_SCHEDULE_LOOKAHEAD_DAYS
  ) {
    const evaluationTime = toDate(now);
    const evaluationMs = evaluationTime.getTime();
    const safeDaysAhead = Math.max(1, Math.min(31, Number(daysAhead) || 0));
    const safeWindows = Array.isArray(windows) ? windows : [];
    const localMidnight = new Date(evaluationTime);
    localMidnight.setHours(0, 0, 0, 0);
    const boundaries = [];

    // Offset -1 includes the end of an overnight window that started yesterday.
    for (let offset = -1; offset <= safeDaysAhead; offset += 1) {
      const baseDate = new Date(localMidnight);
      baseDate.setDate(baseDate.getDate() + offset);
      const weekday = baseDate.getDay();

      safeWindows.forEach((windowConfig) => {
        if (!windowConfig || Number(windowConfig.weekday) !== weekday) return;

        const startMinutes = normalizeMinute(windowConfig.startMinutes, 540);
        const endMinutes = normalizeMinute(windowConfig.endMinutes, 1080);
        const start = new Date(baseDate);
        start.setMinutes(startMinutes);

        const end = new Date(baseDate);
        if (endMinutes > startMinutes) {
          end.setMinutes(endMinutes);
        } else {
          end.setDate(end.getDate() + 1);
          end.setMinutes(endMinutes);
        }

        if (start.getTime() > evaluationMs) boundaries.push(start.getTime());
        if (end.getTime() > evaluationMs) boundaries.push(end.getTime());
      });
    }

    return Array.from(new Set(boundaries)).sort((left, right) => left - right);
  }

  function computeNextRuntimeBoundaryAt(now, context) {
    const evaluationTime = toDate(now);
    const evaluationMs = evaluationTime.getTime();
    const safeContext = context || {};
    const lockConfig = safeContext.lockConfig || {};
    const candidates = [];

    if (
      safeContext.focusSession &&
      Number(safeContext.focusSession.endsAt) > evaluationMs
    ) {
      candidates.push(Number(safeContext.focusSession.endsAt));
    }

    if (
      safeContext.dailyInfo &&
      Number(safeContext.dailyInfo.nextResetAt) > evaluationMs
    ) {
      candidates.push(Number(safeContext.dailyInfo.nextResetAt));
    }

    if (
      lockConfig.weeklyScheduleEnabled &&
      Array.isArray(lockConfig.weeklyWindows)
    ) {
      candidates.push(
        ...getUpcomingScheduleBoundaries(
          evaluationTime,
          lockConfig.weeklyWindows,
          safeContext.scheduleLookaheadDays
        )
      );
    }

    return candidates.length
      ? candidates.sort((left, right) => left - right)[0]
      : null;
  }

  function computeNextUnlockAt(now, context, sharedOverride) {
    const shared = getShared(sharedOverride);
    const evaluationTime = toDate(now);
    const evaluationMs = evaluationTime.getTime();
    const safeContext = context || {};
    const lockConfig = shared.ensureLockConfig(safeContext.lockConfig);
    const focusSession = ensureFocusSessionStable(
      safeContext.focusSession,
      shared
    );
    const candidates = [];

    if (safeContext.focusActive && focusSession.endsAt > evaluationMs) {
      candidates.push(focusSession.endsAt);
    }

    if (
      safeContext.dailyExceeded &&
      safeContext.dailyInfo &&
      Number(safeContext.dailyInfo.nextResetAt) > evaluationMs
    ) {
      candidates.push(Number(safeContext.dailyInfo.nextResetAt));
    }

    if (lockConfig.weeklyScheduleEnabled) {
      candidates.push(
        ...getUpcomingScheduleBoundaries(
          evaluationTime,
          lockConfig.weeklyWindows,
          safeContext.scheduleLookaheadDays
        )
      );
    }

    const sorted = Array.from(new Set(candidates))
      .filter((value) => Number.isFinite(value) && value > evaluationMs)
      .sort((left, right) => left - right);

    for (let index = 0; index < sorted.length; index += 1) {
      const probe = new Date(sorted[index] + 1);
      const stillScheduled = lockConfig.weeklyScheduleEnabled &&
        shared.getActiveWeeklyWindows(probe, lockConfig.weeklyWindows).length > 0;
      const stillFocused = Boolean(
        focusSession.endsAt && focusSession.endsAt > probe.getTime()
      );
      const stillDailyExceeded = Boolean(
        safeContext.dailyExceeded &&
        safeContext.dailyInfo &&
        probe.getTime() < Number(safeContext.dailyInfo.nextResetAt)
      );

      if (!stillScheduled && !stillFocused && !stillDailyExceeded) {
        return sorted[index];
      }
    }

    // A continuously-covered weekly schedule has no finite unlock boundary.
    return null;
  }

  function evaluateRuntimeState(input, sharedOverride) {
    const shared = getShared(sharedOverride);
    const source = input || {};
    const syncState = source.syncState && typeof source.syncState === 'object'
      ? source.syncState
      : {};
    const localState = source.localState && typeof source.localState === 'object'
      ? source.localState
      : {};
    const now = toDate(source.now);
    const proposedFeaturePreferences = shared.ensureFeaturePreferences(syncState);
    const focusSession = ensureFocusSessionStable(localState.focusSession, shared);
    const previousEffective = shared.ensureEffectiveFeatureState(
      localState.effectiveFeatureState
    );
    const previousLockStatus = ensureLockStatusStable(
      localState.lockStatus,
      shared
    );
    const proposedLockConfig = shared.ensureLockConfig(syncState.lockConfig);
    const strictConfigSnapshot = localState.strictConfigSnapshot
      ? shared.ensureLockConfig(localState.strictConfigSnapshot)
      : null;
    const strictFeaturePreferencesSnapshot = localState.strictFeaturePreferencesSnapshot
      ? shared.ensureFeaturePreferences(localState.strictFeaturePreferencesSnapshot)
      : null;
    const strictGuardStatus = strictConfigSnapshot
      ? getCurrentStrictGuardStatus(
        now,
        strictConfigSnapshot,
        focusSession,
        localState.usageState,
        shared
      )
      : previousLockStatus;
    const guardedConfig = strictConfigSnapshot
      ? restoreProtectedLockConfig(
        strictConfigSnapshot,
        proposedLockConfig,
        strictGuardStatus,
        shared
      )
      : { config: proposedLockConfig, corrected: false };
    const lockConfig = guardedConfig.config;
    const guardedFeaturePreferences =
      strictConfigSnapshot && strictFeaturePreferencesSnapshot
        ? restoreProtectedFeaturePreferences(
          strictFeaturePreferencesSnapshot,
          proposedFeaturePreferences,
          strictConfigSnapshot.lockedFeatureKeys,
          strictGuardStatus,
          shared
        )
        : { preferences: proposedFeaturePreferences, corrected: false };
    const featurePreferences = guardedFeaturePreferences.preferences;
    const { usageState, dailyInfo } = pruneUsageState(
      now,
      localState.usageState,
      lockConfig.dailyUsageLimit.resetMinutesAfterMidnight,
      shared
    );
    const activeWeeklyWindows = lockConfig.weeklyScheduleEnabled
      ? shared.getActiveWeeklyWindows(now, lockConfig.weeklyWindows)
      : [];
    const scheduleActive = activeWeeklyWindows.length > 0;
    const focusActive = getFocusSessionActive(now, focusSession);
    const dailyExceeded = getDailyExceeded(now, usageState, lockConfig, shared);
    const reasons = [];

    if (scheduleActive) reasons.push('schedule');
    if (focusActive) reasons.push('focus');
    if (dailyExceeded) reasons.push('dailyLimit');

    const matchedRestrictionReasons = reasons.filter(
      (reason) => lockConfig.blockConditions[reason] !== false
    );
    const restrictionTriggered = matchedRestrictionReasons.length > 0;
    const strictModeEnabled = lockConfig.strictModeEnabled !== false;
    const featureOverrideDisabled = shared.ensureFeatureOverrideDisabled({
      ...(localState.featureOverrideDisabled || {}),
      siteBlockEnabled:
        localState.siteBlockOverrideDisabled === true ||
        localState.featureOverrideDisabled?.siteBlockEnabled === true
    });
    const activeLockedFeatureKeys = restrictionTriggered
      ? lockConfig.lockedFeatureKeys.filter(
        (key) => strictModeEnabled || !featureOverrideDisabled[key]
      )
      : [];
    const siteBlockSelected = lockConfig.lockedFeatureKeys.includes('siteBlockEnabled');
    const manualOverrideActive =
      restrictionTriggered &&
      !strictModeEnabled &&
      siteBlockSelected &&
      featureOverrideDisabled.siteBlockEnabled;
    const restrictionEnforced = restrictionTriggered && activeLockedFeatureKeys.length > 0;
    const lockStatus = withStableLockStatusTimestamp({
      active: reasons.length > 0,
      enforced: restrictionEnforced,
      reasons,
      restrictionTriggered,
      restrictionReasons: matchedRestrictionReasons,
      nextUnlockAt: computeNextUnlockAt(now, {
        focusActive,
        focusSession,
        dailyExceeded,
        dailyInfo,
        scheduleActive,
        lockConfig
      }, shared),
      lockedBySchedule: scheduleActive,
      lockedByFocusSession: focusActive,
      lockedByDailyLimit: dailyExceeded,
      strictModeEnabled,
      panelLocked:
        restrictionTriggered &&
        strictModeEnabled &&
        lockConfig.lockedFeatureKeys.length > 0,
      overrideAllowed: restrictionTriggered && !strictModeEnabled && siteBlockSelected,
      overrideActive: manualOverrideActive
    }, previousLockStatus, now, shared);
    const effectiveFeatureState = shared.computeEffectiveFeatureState(
      featurePreferences,
      activeLockedFeatureKeys
    );

    if (lockConfig.dailyUsageLimit.enabled && dailyExceeded) {
      if (!usageState.exceeded || !usageState.limitExceededAt) {
        usageState.limitExceededAt = now.getTime();
      }
      usageState.exceeded = true;
    } else {
      usageState.exceeded = false;
      usageState.limitExceededAt = null;
    }

    const nextFocusSession = focusActive
      ? focusSession
      : { ...shared.DEFAULT_FOCUS_SESSION };
    const retainedFeatureOverrides = shared.ensureFeatureOverrideDisabled(
      restrictionTriggered && !strictModeEnabled
        ? Object.fromEntries(
          lockConfig.lockedFeatureKeys.map((key) => [key, featureOverrideDisabled[key]])
        )
        : null
    );
    const strictProtectionActive =
      restrictionTriggered && strictModeEnabled && lockConfig.lockedFeatureKeys.length > 0;
    const desiredLocalState = {
      effectiveFeatureState,
      lockStatus,
      focusSession: nextFocusSession,
      usageState,
      siteBlockOverrideDisabled:
        retainedFeatureOverrides.siteBlockEnabled,
      featureOverrideDisabled: retainedFeatureOverrides,
      strictConfigSnapshot:
        strictProtectionActive ? lockConfig : null,
      strictFeaturePreferencesSnapshot: strictProtectionActive
        ? (strictFeaturePreferencesSnapshot || featurePreferences)
        : null
    };
    const localUpdates = getChangedLocalValues(localState, desiredLocalState);
    const syncUpdates = guardedConfig.corrected ? { lockConfig } : {};
    if (guardedFeaturePreferences.corrected) {
      shared.FEATURE_KEYS.forEach((key) => {
        if (featurePreferences[key] !== proposedFeaturePreferences[key]) {
          syncUpdates[key] = featurePreferences[key];
        }
      });
    }
    const nextRuntimeBoundaryAt = computeNextRuntimeBoundaryAt(now, {
      focusSession: nextFocusSession,
      dailyInfo: lockConfig.dailyUsageLimit.enabled ? dailyInfo : null,
      lockConfig
    });

    return {
      featurePreferences,
      lockConfig,
      correctedLockConfig: guardedConfig.corrected,
      correctedFeaturePreferences: guardedFeaturePreferences.corrected,
      effectiveFeatureState,
      lockStatus,
      focusSession: nextFocusSession,
      usageState,
      dailyInfo,
      desiredLocalState,
      syncUpdates,
      localUpdates,
      effects: {
        blockOpenBilibiliTabs: Boolean(
          effectiveFeatureState.siteBlockEnabled &&
          (source.forceBlockOpenTabs || previousEffective.siteBlockEnabled === false)
        ),
        nextRuntimeBoundaryAt
      }
    };
  }

  global.BiliFocusRuntimeCore = Object.freeze({
    DAY_IN_MS,
    DEFAULT_SCHEDULE_LOOKAHEAD_DAYS,
    valuesEqual,
    getFocusSessionActive,
    getDailyExceeded,
    pruneUsageState,
    restoreProtectedLockConfig,
    restoreProtectedFeaturePreferences,
    getCurrentStrictGuardStatus,
    getSemanticLockStatus,
    withStableLockStatusTimestamp,
    getChangedLocalValues,
    getUpcomingScheduleBoundaries,
    computeNextRuntimeBoundaryAt,
    computeNextUnlockAt,
    evaluateRuntimeState
  });
})(globalThis);
