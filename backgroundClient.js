(function (global) {
  const {
    MESSAGE_TYPES,
    ERROR_CODES,
    getErrorMessage
  } = global.BiliFocusContracts;

  let latestSnapshot = null;
  let stateRequest = null;
  const subscribers = new Set();
  let storageListenerInstalled = false;
  let storageChangeListener = null;

  function updateSnapshot(response) {
    if (response && response.snapshot) {
      const nextSnapshot = response.snapshot;
      const currentRevision = latestSnapshot && Number(latestSnapshot.revision);
      const nextRevision = Number(nextSnapshot.revision);

      if (
        Number.isSafeInteger(currentRevision) &&
        Number.isSafeInteger(nextRevision) &&
        nextRevision < currentRevision
      ) {
        return latestSnapshot;
      }

      const currentUsage = latestSnapshot && latestSnapshot.usageState;
      const nextUsage = nextSnapshot.usageState;
      if (
        nextRevision === currentRevision &&
        currentUsage &&
        nextUsage &&
        nextUsage.dayKey === currentUsage.dayKey &&
        Number(nextUsage.accumulatedMs) < Number(currentUsage.accumulatedMs)
      ) {
        return latestSnapshot;
      }

      if (
        latestSnapshot &&
        JSON.stringify(nextSnapshot) === JSON.stringify(latestSnapshot)
      ) {
        return latestSnapshot;
      }

      latestSnapshot = nextSnapshot;
      subscribers.forEach((listener) => {
        try {
          listener(latestSnapshot);
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      });
    }
    return latestSnapshot;
  }

  async function request(type, payload = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    updateSnapshot(response);

    if (!response || response.ok !== true) {
      const error = new Error(getErrorMessage(response));
      error.code = response && response.error && response.error.code || 'internal_error';
      error.snapshot = response && response.snapshot || null;
      throw error;
    }

    return response;
  }

  function getState(options = {}) {
    const refresh = options.refresh !== false;
    if (stateRequest) {
      if (!refresh || stateRequest.refresh) {
        return stateRequest.promise;
      }

      const pendingRequest = stateRequest;
      return pendingRequest.promise.then(
        () => getState({ refresh: true }),
        () => getState({ refresh: true })
      );
    }

    const pendingRequest = {
      refresh,
      promise: null
    };
    pendingRequest.promise = request(MESSAGE_TYPES.GET_STATE, { refresh })
      .then(() => latestSnapshot)
      .finally(() => {
        if (stateRequest === pendingRequest) {
          stateRequest = null;
        }
      });
    stateRequest = pendingRequest;

    return pendingRequest.promise;
  }

  function getCachedState() {
    return latestSnapshot;
  }

  function installStorageListener() {
    if (storageListenerInstalled) return;
    storageListenerInstalled = true;

    storageChangeListener = (changes, areaName) => {
      if (areaName !== 'sync' && areaName !== 'local') return;
      if (!changes || !Object.keys(changes).length) return;

      if (areaName === 'local' && changes.stateRevision) {
        const currentRevision = latestSnapshot && Number(latestSnapshot.revision);
        const nextRevision = Number(changes.stateRevision.newValue);
        if (
          changes.stateRevision.newValue === undefined ||
          (
            Number.isSafeInteger(currentRevision) &&
            Number.isSafeInteger(nextRevision) &&
            nextRevision < currentRevision
          )
        ) {
          latestSnapshot = null;
        }
      }

      getState({ refresh: false }).catch(() => null);
    };
    chrome.storage.onChanged.addListener(storageChangeListener);
  }

  function uninstallStorageListener() {
    if (
      !storageListenerInstalled ||
      subscribers.size > 0 ||
      !storageChangeListener
    ) {
      return;
    }

    chrome.storage.onChanged.removeListener(storageChangeListener);
    storageChangeListener = null;
    storageListenerInstalled = false;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') {
      return () => {};
    }

    subscribers.add(listener);
    installStorageListener();
    if (latestSnapshot) {
      listener(latestSnapshot);
    }

    return () => {
      subscribers.delete(listener);
      uninstallStorageListener();
    };
  }

  function getSettingsSignature(snapshot) {
    if (!snapshot) return null;
    return JSON.stringify({
      lockConfig: snapshot.lockConfig,
      appearanceConfig: snapshot.appearanceConfig,
      playerShortcutConfig: snapshot.playerShortcutConfig
    });
  }

  async function runStateCommand(type, payload = {}, canRetryConflict = null) {
    const baseSnapshot = latestSnapshot;
    const commandPayload = { ...payload };
    const explicitBaseRevision = commandPayload.baseRevision;
    delete commandPayload.baseRevision;

    try {
      await request(type, {
        baseRevision: explicitBaseRevision ?? (baseSnapshot && baseSnapshot.revision),
        ...commandPayload
      });
    } catch (error) {
      const freshSnapshot = error.snapshot || latestSnapshot;
      const retryAllowed = (
        error.code === ERROR_CODES.CONFLICT &&
        baseSnapshot &&
        freshSnapshot &&
        typeof canRetryConflict === 'function' &&
        canRetryConflict(baseSnapshot, freshSnapshot)
      );

      if (!retryAllowed) throw error;

      await request(type, {
        baseRevision: freshSnapshot.revision,
        ...commandPayload
      });
    }

    return latestSnapshot;
  }

  const client = {
    getState,
    getCachedState,
    subscribe,
    ensureRuntime() {
      return request(MESSAGE_TYPES.ENSURE_RUNTIME)
        .then(() => latestSnapshot);
    },
    updatePreference(key, value) {
      return runStateCommand(
        MESSAGE_TYPES.UPDATE_PREFERENCE,
        {
          key,
          value,
          basePreferenceValue:
            latestSnapshot && latestSnapshot.featurePreferences
              ? latestSnapshot.featurePreferences[key]
              : undefined
        },
        (baseSnapshot, freshSnapshot) => (
          baseSnapshot.featurePreferences &&
          freshSnapshot.featurePreferences &&
          baseSnapshot.featurePreferences[key] === freshSnapshot.featurePreferences[key]
        )
      );
    },
    saveSettings(
      lockConfig,
      appearanceConfig,
      baseRevision = null,
      baseSettingsSignature = null,
      playerShortcutConfig = null
    ) {
      const payload = {
        lockConfig,
        appearanceConfig,
        playerShortcutConfig: playerShortcutConfig || (
          latestSnapshot && latestSnapshot.playerShortcutConfig
        )
      };
      if (baseRevision !== null && baseRevision !== undefined) {
        payload.baseRevision = baseRevision;
      }
      if (baseSettingsSignature) {
        payload.baseSettingsSignature = baseSettingsSignature;
      }
      return runStateCommand(
        MESSAGE_TYPES.SAVE_SETTINGS,
        payload,
        (baseSnapshot, freshSnapshot) => (
          (baseSettingsSignature || getSettingsSignature(baseSnapshot)) ===
          getSettingsSignature(freshSnapshot)
        )
      );
    },
    setSiteBlockOverride(disabled) {
      return runStateCommand(MESSAGE_TYPES.SET_SITE_BLOCK_OVERRIDE, { disabled });
    },
    startFocusSession(minutes) {
      return runStateCommand(MESSAGE_TYPES.START_FOCUS_SESSION, { minutes });
    },
    stopFocusSession() {
      return runStateCommand(MESSAGE_TYPES.STOP_FOCUS_SESSION);
    },
    activityPing(final = false) {
      return request(MESSAGE_TYPES.ACTIVITY_PING, { final })
        .then(() => latestSnapshot);
    },
    resumeBlockedTab() {
      return request(MESSAGE_TYPES.RESUME_BLOCKED_TAB)
        .then((response) => response.result);
    }
  };

  global.BiliFocusClient = client;
})(globalThis);
