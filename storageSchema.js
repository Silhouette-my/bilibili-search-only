(function (global) {
  'use strict';

  const CONFIG_SCHEMA_VERSION = 3;
  const RUNTIME_SCHEMA_VERSION = 2;
  const CONFIG_SCHEMA_VERSION_KEY = 'configSchemaVersion';
  const RUNTIME_SCHEMA_VERSION_KEY = 'runtimeSchemaVersion';

  function getShared(sharedOverride) {
    const shared = sharedOverride || global.BiliFocusShared;
    const requiredFunctions = [
      'ensureFeaturePreferences',
      'ensureFeatureOverrideDisabled',
      'ensureLockConfig',
      'ensureAppearanceConfig',
      'ensurePlayerShortcutConfig',
      'ensureFocusSession',
      'ensureUsageState',
      'ensureLockStatus',
      'ensureEffectiveFeatureState'
    ];

    if (
      !shared ||
      !Array.isArray(shared.FEATURE_KEYS) ||
      requiredFunctions.some((name) => typeof shared[name] !== 'function')
    ) {
      throw new Error('BiliFocusStorageSchema requires the BiliFocusShared contract.');
    }

    return shared;
  }

  function cloneStorageValue(value) {
    if (Array.isArray(value)) {
      return value.map(cloneStorageValue);
    }

    if (value && typeof value === 'object') {
      return Object.entries(value).reduce((copy, [key, item]) => {
        copy[key] = cloneStorageValue(item);
        return copy;
      }, {});
    }

    return value;
  }

  function valuesEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function readSchemaVersion(value) {
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric >= 0 ? numeric : 0;
  }

  function stableHash(value) {
    const text = JSON.stringify(value);
    let hash = 2166136261;

    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function withDeterministicWindowIds(rawWindows) {
    if (!Array.isArray(rawWindows)) return [];

    return rawWindows.map((rawWindow, index) => {
      const source = rawWindow && typeof rawWindow === 'object'
        ? cloneStorageValue(rawWindow)
        : {};

      if (typeof source.id !== 'string' || !source.id) {
        source.id = `legacy-window-${index}-${stableHash({
          weekday: source.weekday,
          startMinutes: source.startMinutes,
          endMinutes: source.endMinutes
        })}`;
      }

      return source;
    });
  }

  function readBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
  }

  function normalizeLockConfig(raw, shared) {
    const defaults = shared.ensureLockConfig(shared.DEFAULT_LOCK_CONFIG);
    const source = raw && typeof raw === 'object'
      ? cloneStorageValue(raw)
      : {};
    const dailySource = source.dailyUsageLimit &&
      typeof source.dailyUsageLimit === 'object'
      ? source.dailyUsageLimit
      : {};
    const blockSource = source.blockConditions &&
      typeof source.blockConditions === 'object'
      ? source.blockConditions
      : {};
    const prepared = {
      ...source,
      weeklyScheduleEnabled: readBoolean(
        source.weeklyScheduleEnabled,
        defaults.weeklyScheduleEnabled
      ),
      weeklyWindows: withDeterministicWindowIds(source.weeklyWindows),
      dailyUsageLimit: {
        ...dailySource,
        enabled: readBoolean(
          dailySource.enabled,
          defaults.dailyUsageLimit.enabled
        )
      },
      blockConditions: {
        ...blockSource,
        schedule: readBoolean(
          blockSource.schedule,
          defaults.blockConditions.schedule
        ),
        focus: readBoolean(
          blockSource.focus,
          defaults.blockConditions.focus
        ),
        dailyLimit: readBoolean(
          blockSource.dailyLimit,
          defaults.blockConditions.dailyLimit
        )
      },
      lockedFeatureKeys: Array.isArray(source.lockedFeatureKeys)
        ? source.lockedFeatureKeys
        : defaults.lockedFeatureKeys,
      strictModeEnabled: readBoolean(
        source.strictModeEnabled,
        defaults.strictModeEnabled
      )
    };
    const normalized = shared.ensureLockConfig(prepared);

    return {
      ...source,
      ...normalized,
      weeklyWindows: normalized.weeklyWindows.map((windowConfig, index) => ({
        ...(prepared.weeklyWindows[index] || {}),
        ...windowConfig
      })),
      dailyUsageLimit: {
        ...dailySource,
        ...normalized.dailyUsageLimit
      },
      blockConditions: {
        ...blockSource,
        ...normalized.blockConditions
      }
    };
  }

  function mergeNormalized(raw, normalized) {
    const source = raw && typeof raw === 'object'
      ? cloneStorageValue(raw)
      : {};
    return { ...source, ...normalized };
  }

  function normalizeFocusSession(raw, shared) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const normalized = shared.ensureFocusSession(source);
    if (source.endsAt === null || source.endsAt === undefined) {
      normalized.endsAt = null;
    }
    if (source.startedAt === null || source.startedAt === undefined) {
      normalized.startedAt = null;
    }
    return mergeNormalized(source, normalized);
  }

  function normalizeUsageState(raw, shared) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const normalized = shared.ensureUsageState(source);
    if (
      source.limitExceededAt === null ||
      source.limitExceededAt === undefined
    ) {
      normalized.limitExceededAt = null;
    }
    return mergeNormalized(source, normalized);
  }

  function normalizeLockStatus(raw, shared) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const normalized = shared.ensureLockStatus(source);
    if (source.nextUnlockAt === null || source.nextUnlockAt === undefined) {
      normalized.nextUnlockAt = null;
    }
    if (source.updatedAt === null || source.updatedAt === undefined) {
      normalized.updatedAt = null;
    }
    return mergeNormalized(source, normalized);
  }

  function collectUpdates(original, migrated, keys) {
    return keys.reduce((updates, key) => {
      if (!valuesEqual(original[key], migrated[key])) {
        updates[key] = cloneStorageValue(migrated[key]);
      }
      return updates;
    }, {});
  }

  function migrateConfigState(syncStateRaw, shared) {
    const original = syncStateRaw && typeof syncStateRaw === 'object'
      ? cloneStorageValue(syncStateRaw)
      : {};
    const currentVersion = readSchemaVersion(original[CONFIG_SCHEMA_VERSION_KEY]);

    if (currentVersion > CONFIG_SCHEMA_VERSION) {
      return {
        state: original,
        updates: {},
        unsupportedFutureVersion: currentVersion
      };
    }

    const migrated = cloneStorageValue(original);
    const featurePreferences = shared.ensureFeaturePreferences(original);

    shared.FEATURE_KEYS.forEach((key) => {
      migrated[key] = featurePreferences[key];
    });
    migrated.lockConfig = normalizeLockConfig(original.lockConfig, shared);
    migrated.appearanceConfig = mergeNormalized(
      original.appearanceConfig,
      shared.ensureAppearanceConfig(original.appearanceConfig)
    );
    migrated.playerShortcutConfig = mergeNormalized(
      original.playerShortcutConfig,
      shared.ensurePlayerShortcutConfig(original.playerShortcutConfig)
    );
    migrated[CONFIG_SCHEMA_VERSION_KEY] = CONFIG_SCHEMA_VERSION;

    const managedKeys = [
      ...shared.FEATURE_KEYS,
      'lockConfig',
      'appearanceConfig',
      'playerShortcutConfig',
      CONFIG_SCHEMA_VERSION_KEY
    ];

    return {
      state: migrated,
      updates: collectUpdates(original, migrated, managedKeys),
      unsupportedFutureVersion: null
    };
  }

  function migrateRuntimeState(localStateRaw, shared) {
    const original = localStateRaw && typeof localStateRaw === 'object'
      ? cloneStorageValue(localStateRaw)
      : {};
    const currentVersion = readSchemaVersion(original[RUNTIME_SCHEMA_VERSION_KEY]);

    if (currentVersion > RUNTIME_SCHEMA_VERSION) {
      return {
        state: original,
        updates: {},
        unsupportedFutureVersion: currentVersion
      };
    }

    const migrated = cloneStorageValue(original);
    migrated.effectiveFeatureState = mergeNormalized(
      original.effectiveFeatureState,
      shared.ensureEffectiveFeatureState(original.effectiveFeatureState)
    );
    migrated.lockStatus = normalizeLockStatus(original.lockStatus, shared);
    migrated.focusSession = normalizeFocusSession(original.focusSession, shared);
    migrated.usageState = normalizeUsageState(original.usageState, shared);
    migrated.siteBlockOverrideDisabled =
      original.siteBlockOverrideDisabled === true;
    migrated.featureOverrideDisabled = shared.ensureFeatureOverrideDisabled({
      ...(original.featureOverrideDisabled || {}),
      siteBlockEnabled:
        original.siteBlockOverrideDisabled === true ||
        original.featureOverrideDisabled?.siteBlockEnabled === true
    });
    migrated.strictConfigSnapshot = original.strictConfigSnapshot
      ? normalizeLockConfig(original.strictConfigSnapshot, shared)
      : null;
    migrated.strictFeaturePreferencesSnapshot = original.strictFeaturePreferencesSnapshot
      ? shared.ensureFeaturePreferences(original.strictFeaturePreferencesSnapshot)
      : null;
    migrated.stateRevision = Number.isSafeInteger(Number(original.stateRevision)) &&
      Number(original.stateRevision) >= 0
      ? Number(original.stateRevision)
      : 0;
    migrated[RUNTIME_SCHEMA_VERSION_KEY] = RUNTIME_SCHEMA_VERSION;

    const managedKeys = [
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

    return {
      state: migrated,
      updates: collectUpdates(original, migrated, managedKeys),
      unsupportedFutureVersion: null
    };
  }

  function migrateStorageState(syncStateRaw, localStateRaw, sharedOverride) {
    const shared = getShared(sharedOverride);
    const configMigration = migrateConfigState(syncStateRaw, shared);
    const runtimeMigration = migrateRuntimeState(localStateRaw, shared);
    const syncUpdates = configMigration.updates;
    const localUpdates = runtimeMigration.updates;

    return {
      sync: configMigration.state,
      local: runtimeMigration.state,
      syncUpdates,
      localUpdates,
      changed:
        Object.keys(syncUpdates).length > 0 ||
        Object.keys(localUpdates).length > 0,
      unsupportedFutureVersion: {
        config: configMigration.unsupportedFutureVersion,
        runtime: runtimeMigration.unsupportedFutureVersion
      }
    };
  }

  global.BiliFocusStorageSchema = Object.freeze({
    CONFIG_SCHEMA_VERSION,
    RUNTIME_SCHEMA_VERSION,
    CONFIG_SCHEMA_VERSION_KEY,
    RUNTIME_SCHEMA_VERSION_KEY,
    cloneStorageValue,
    migrateStorageState
  });
})(globalThis);
