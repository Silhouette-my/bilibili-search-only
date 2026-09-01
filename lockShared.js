(function (global) {
  const FEATURE_KEYS = [
    'siteBlockEnabled',
    'redirectEnabled',
    'playerMaskEnabled',
    'autoPlayOffEnabled',
    'searchMaskEnabled'
  ];

  const DEFAULT_LOCKED_FEATURE_KEYS = ['siteBlockEnabled'];

  const DEFAULT_FEATURE_PREFERENCES = {
    siteBlockEnabled: false,
    redirectEnabled: true,
    playerMaskEnabled: true,
    autoPlayOffEnabled: true,
    searchMaskEnabled: true
  };

  const DEFAULT_LOCK_CONFIG = {
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
    lockedFeatureKeys: DEFAULT_LOCKED_FEATURE_KEYS,
    strictModeEnabled: true
  };

  const DEFAULT_APPEARANCE_CONFIG = {
    theme: 'light'
  };

  const PLAYER_SHORTCUT_ACTIONS = Object.freeze([
    { id: 'togglePlay', label: '播放 / 暂停' },
    { id: 'seekBackward', label: '后退 5 秒', repeatable: true },
    { id: 'seekForward', label: '前进 5 秒', repeatable: true },
    { id: 'toggleMute', label: '静音 / 恢复声音' },
    { id: 'speedDown', label: '降低倍速' },
    { id: 'speedUp', label: '提高倍速' },
    { id: 'speedReset', label: '恢复 1× 倍速' },
    { id: 'toggleSubtitle', label: '字幕开关' },
    { id: 'toggleDanmaku', label: '弹幕开关' },
    { id: 'toggleWebFullscreen', label: '网页全屏' },
    { id: 'toggleFullscreen', label: '全屏' }
  ]);
  const PLAYER_SHORTCUT_ACTION_IDS = Object.freeze(
    PLAYER_SHORTCUT_ACTIONS.map((action) => action.id)
  );
  const PLAYER_SHORTCUT_REPEATABLE_ACTIONS = Object.freeze(
    PLAYER_SHORTCUT_ACTIONS
      .filter((action) => action.repeatable)
      .map((action) => action.id)
  );
  const DEFAULT_PLAYER_SHORTCUT_BINDINGS = Object.freeze(
    PLAYER_SHORTCUT_ACTION_IDS.reduce((bindings, actionId) => {
      bindings[actionId] = null;
      return bindings;
    }, {})
  );
  const DEFAULT_PLAYER_SHORTCUT_CONFIG = Object.freeze({
    enabled: true,
    bindings: DEFAULT_PLAYER_SHORTCUT_BINDINGS
  });
  const INVALID_SHORTCUT_CODES = new Set([
    'Escape',
    'Tab',
    'ShiftLeft',
    'ShiftRight',
    'ControlLeft',
    'ControlRight',
    'AltLeft',
    'AltRight',
    'MetaLeft',
    'MetaRight',
    'Fn',
    'FnLock',
    'Hyper',
    'Super',
    'Symbol',
    'SymbolLock',
    'CapsLock',
    'NumLock',
    'ScrollLock',
    'Dead',
    'Process',
    'Unidentified'
  ]);

  const DEFAULT_FOCUS_SESSION = {
    endsAt: null,
    startedAt: null
  };

  const DEFAULT_USAGE_STATE = {
    dayKey: '',
    accumulatedMs: 0,
    exceeded: false,
    limitExceededAt: null,
    lastPingByTab: {}
  };

  const DEFAULT_LOCK_STATUS = {
    active: false,
    enforced: false,
    reasons: [],
    restrictionTriggered: false,
    restrictionReasons: [],
    nextUnlockAt: null,
    lockedBySchedule: false,
    lockedByFocusSession: false,
    lockedByDailyLimit: false,
    strictModeEnabled: true,
    panelLocked: false,
    overrideAllowed: false,
    overrideActive: false,
    updatedAt: null
  };

  const DEFAULT_EFFECTIVE_FEATURE_STATE = { ...DEFAULT_FEATURE_PREFERENCES };
  const DEFAULT_FEATURE_OVERRIDE_DISABLED = FEATURE_KEYS.reduce((state, key) => {
    state[key] = false;
    return state;
  }, {});

  const DAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  const REDIRECT_WHITELIST_HOSTS = [
    'search.bilibili.com',
    'passport.bilibili.com',
    'message.bilibili.com',
    'account.bilibili.com',
    'space.bilibili.com',
    'live.bilibili.com',
    'api.bilibili.com',
    'api.vc.bilibili.com',
    'pay.bilibili.com',
    't.bilibili.com'
  ];
  const REDIRECT_TARGET_URL = 'https://search.bilibili.com/all?vt=64450376';

  function clampNumber(value, min, max, fallback) {
    const num = Number(value);
    if (Number.isNaN(num)) return fallback;
    return Math.min(max, Math.max(min, num));
  }

  function ensureFeaturePreferences(raw) {
    const next = { ...DEFAULT_FEATURE_PREFERENCES };
    const source = raw || {};

    FEATURE_KEYS.forEach((key) => {
      if (typeof source[key] === 'boolean') {
        next[key] = source[key];
      }
    });

    return next;
  }

  function ensureFeatureOverrideDisabled(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return FEATURE_KEYS.reduce((state, key) => {
      state[key] = source[key] === true;
      return state;
    }, {});
  }

  function normalizeWeeklyWindow(rawWindow, index) {
    const source = rawWindow || {};
    return {
      id: typeof source.id === 'string' && source.id ? source.id : `window-${index}`,
      weekday: clampNumber(source.weekday, 0, 6, 1),
      startMinutes: clampNumber(source.startMinutes, 0, 1439, 540),
      endMinutes: clampNumber(source.endMinutes, 0, 1439, 1080)
    };
  }

  function ensureLockConfig(raw) {
    const source = raw || {};
    const dailySource = source.dailyUsageLimit || {};
    const blockConditionsSource = source.blockConditions || {};

    const lockedFeatureKeys = Array.isArray(source.lockedFeatureKeys)
      ? source.lockedFeatureKeys.filter(
        (key, index, keys) => FEATURE_KEYS.includes(key) && keys.indexOf(key) === index
      )
      : [...DEFAULT_LOCKED_FEATURE_KEYS];

    return {
      weeklyScheduleEnabled: Boolean(source.weeklyScheduleEnabled),
      weeklyWindows: Array.isArray(source.weeklyWindows)
        ? source.weeklyWindows.map(normalizeWeeklyWindow)
        : [],
      dailyUsageLimit: {
        enabled: Boolean(dailySource.enabled),
        limitMinutes: clampNumber(dailySource.limitMinutes, 1, 24 * 60, 120),
        resetMinutesAfterMidnight: clampNumber(dailySource.resetMinutesAfterMidnight, 0, 1439, 240)
      },
      blockConditions: {
        schedule: blockConditionsSource.schedule !== false,
        focus: blockConditionsSource.focus !== false,
        dailyLimit: blockConditionsSource.dailyLimit !== false
      },
      lockedFeatureKeys,
      strictModeEnabled: source.strictModeEnabled !== false
    };
  }

  function ensureFocusSession(raw) {
    const source = raw || {};
    const endsAt = source.endsAt === null || source.endsAt === undefined
      ? null
      : Number(source.endsAt);
    const startedAt = source.startedAt === null || source.startedAt === undefined
      ? null
      : Number(source.startedAt);

    return {
      endsAt: endsAt !== null && Number.isFinite(endsAt) ? endsAt : null,
      startedAt: startedAt !== null && Number.isFinite(startedAt) ? startedAt : null
    };
  }

  function ensureAppearanceConfig(raw) {
    const source = raw || {};
    const theme = source.theme === 'dark' ? 'dark' : 'light';

    return { theme };
  }

  function normalizeShortcutBinding(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const code = typeof raw.code === 'string' ? raw.code.trim() : '';
    if (
      !code ||
      code.length > 64 ||
      !/^[A-Za-z][A-Za-z0-9]*$/.test(code) ||
      INVALID_SHORTCUT_CODES.has(code)
    ) {
      return null;
    }

    return {
      code,
      ctrl: raw.ctrl === true,
      alt: raw.alt === true,
      shift: raw.shift === true,
      meta: raw.meta === true
    };
  }

  function getShortcutBindingSignature(binding) {
    const normalized = normalizeShortcutBinding(binding);
    if (!normalized) return null;
    return [
      normalized.code,
      normalized.ctrl ? '1' : '0',
      normalized.alt ? '1' : '0',
      normalized.shift ? '1' : '0',
      normalized.meta ? '1' : '0'
    ].join(':');
  }

  function ensurePlayerShortcutConfig(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw
      : {};
    const sourceBindings = source.bindings &&
      typeof source.bindings === 'object' &&
      !Array.isArray(source.bindings)
      ? source.bindings
      : {};
    const usedBindings = new Set();
    const bindings = {};

    PLAYER_SHORTCUT_ACTION_IDS.forEach((actionId) => {
      const binding = normalizeShortcutBinding(sourceBindings[actionId]);
      const signature = getShortcutBindingSignature(binding);
      if (!binding || usedBindings.has(signature)) {
        bindings[actionId] = null;
        return;
      }
      usedBindings.add(signature);
      bindings[actionId] = binding;
    });

    return {
      enabled: source.enabled !== false,
      bindings
    };
  }

  function shortcutBindingMatchesEvent(binding, event) {
    const normalized = normalizeShortcutBinding(binding);
    return Boolean(
      normalized &&
      event &&
      event.code === normalized.code &&
      Boolean(event.ctrlKey) === normalized.ctrl &&
      Boolean(event.altKey) === normalized.alt &&
      Boolean(event.shiftKey) === normalized.shift &&
      Boolean(event.metaKey) === normalized.meta
    );
  }

  function ensureUsageState(raw) {
    const source = raw || {};
    const accumulatedMs = Number(source.accumulatedMs);
    const limitExceededAt = source.limitExceededAt === null ||
      source.limitExceededAt === undefined
      ? null
      : Number(source.limitExceededAt);

    return {
      dayKey: typeof source.dayKey === 'string' ? source.dayKey : '',
      accumulatedMs: Number.isFinite(accumulatedMs)
        ? Math.max(0, accumulatedMs)
        : 0,
      exceeded: Boolean(source.exceeded),
      limitExceededAt:
        limitExceededAt !== null && Number.isFinite(limitExceededAt)
          ? limitExceededAt
          : null,
      lastPingByTab: source.lastPingByTab && typeof source.lastPingByTab === 'object'
        ? { ...source.lastPingByTab }
        : {}
    };
  }

  function ensureLockStatus(raw) {
    const source = raw || {};
    const nextUnlockAt = source.nextUnlockAt === null ||
      source.nextUnlockAt === undefined
      ? null
      : Number(source.nextUnlockAt);
    const updatedAt = source.updatedAt === null || source.updatedAt === undefined
      ? null
      : Number(source.updatedAt);

    return {
      active: Boolean(source.active),
      enforced: Boolean(source.enforced),
      reasons: Array.isArray(source.reasons) ? source.reasons.slice() : [],
      restrictionTriggered: Boolean(source.restrictionTriggered),
      restrictionReasons: Array.isArray(source.restrictionReasons) ? source.restrictionReasons.slice() : [],
      nextUnlockAt:
        nextUnlockAt !== null && Number.isFinite(nextUnlockAt)
          ? nextUnlockAt
          : null,
      lockedBySchedule: Boolean(source.lockedBySchedule),
      lockedByFocusSession: Boolean(source.lockedByFocusSession),
      lockedByDailyLimit: Boolean(source.lockedByDailyLimit),
      strictModeEnabled: source.strictModeEnabled !== false,
      panelLocked: Boolean(source.panelLocked),
      overrideAllowed: Boolean(source.overrideAllowed),
      overrideActive: Boolean(source.overrideActive),
      updatedAt:
        updatedAt !== null && Number.isFinite(updatedAt)
          ? updatedAt
          : null
    };
  }

  function ensureEffectiveFeatureState(raw) {
    return ensureFeaturePreferences(raw);
  }

  function getMinutesOfDay(date) {
    return date.getHours() * 60 + date.getMinutes();
  }

  function parseTimeInput(value) {
    if (typeof value !== 'string' || !value.includes(':')) return 0;
    const [hours, minutes] = value.split(':').map((part) => Number(part));
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return 0;
    return clampNumber(hours * 60 + minutes, 0, 1439, 0);
  }

  function formatTimeInput(minutes) {
    const safe = clampNumber(minutes, 0, 1439, 0);
    const hours = String(Math.floor(safe / 60)).padStart(2, '0');
    const mins = String(safe % 60).padStart(2, '0');
    return `${hours}:${mins}`;
  }

  function getLogicalDayStart(date, resetMinutesAfterMidnight) {
    const start = new Date(date);
    start.setSeconds(0, 0);
    start.setHours(0, 0, 0, 0);
    start.setMinutes(resetMinutesAfterMidnight);

    if (date.getTime() < start.getTime()) {
      start.setDate(start.getDate() - 1);
    }

    return start;
  }

  function getLogicalDayInfo(date, resetMinutesAfterMidnight) {
    const dayStart = getLogicalDayStart(date, resetMinutesAfterMidnight);
    const nextReset = new Date(dayStart);
    nextReset.setDate(nextReset.getDate() + 1);

    const dayKey = [
      dayStart.getFullYear(),
      String(dayStart.getMonth() + 1).padStart(2, '0'),
      String(dayStart.getDate()).padStart(2, '0')
    ].join('-');

    return {
      dayKey,
      dayStart,
      nextResetAt: nextReset.getTime()
    };
  }

  function isWeeklyWindowActiveAt(date, windowConfig) {
    const weekday = date.getDay();
    const minutes = getMinutesOfDay(date);

    if (windowConfig.endMinutes > windowConfig.startMinutes) {
      return (
        weekday === windowConfig.weekday &&
        minutes >= windowConfig.startMinutes &&
        minutes < windowConfig.endMinutes
      );
    }

    const nextDay = (windowConfig.weekday + 1) % 7;
    return (
      (weekday === windowConfig.weekday && minutes >= windowConfig.startMinutes) ||
      (weekday === nextDay && minutes < windowConfig.endMinutes)
    );
  }

  function getActiveWeeklyWindows(date, windows) {
    return windows.filter((windowConfig) => isWeeklyWindowActiveAt(date, windowConfig));
  }

  function buildWindowOccurrences(fromDate, windows, daysAhead) {
    const items = [];
    const startDate = new Date(fromDate);
    startDate.setHours(0, 0, 0, 0);

    for (let offset = 0; offset <= daysAhead; offset += 1) {
      const baseDate = new Date(startDate);
      baseDate.setDate(baseDate.getDate() + offset);
      const weekday = baseDate.getDay();

      windows.forEach((windowConfig) => {
        if (windowConfig.weekday !== weekday) return;

        const start = new Date(baseDate);
        start.setMinutes(windowConfig.startMinutes);

        const end = new Date(baseDate);
        if (windowConfig.endMinutes > windowConfig.startMinutes) {
          end.setMinutes(windowConfig.endMinutes);
        } else {
          end.setDate(end.getDate() + 1);
          end.setMinutes(windowConfig.endMinutes);
        }

        items.push(start.getTime(), end.getTime());
      });
    }

    return items;
  }

  function getUpcomingScheduleChanges(date, windows, daysAhead) {
    return buildWindowOccurrences(date, windows, daysAhead)
      .filter((time) => time > date.getTime())
      .sort((a, b) => a - b);
  }

  function getNextScheduleChangeAt(date, windows) {
    const futureTimes = getUpcomingScheduleChanges(date, windows, 8);

    return futureTimes.length ? futureTimes[0] : null;
  }

  function computeEffectiveFeatureState(featurePreferences, forcedFeatureKeys) {
    const effective = ensureFeaturePreferences(featurePreferences);
    const forcedKeys = forcedFeatureKeys === true
      ? DEFAULT_LOCKED_FEATURE_KEYS
      : (Array.isArray(forcedFeatureKeys) ? forcedFeatureKeys : []);

    forcedKeys.forEach((key) => {
      if (FEATURE_KEYS.includes(key)) effective[key] = true;
    });
    return effective;
  }

  function getLockReasonsSummary(reasons) {
    const labels = {
      schedule: '固定时段',
      focus: '专注倒计时',
      dailyLimit: '累计使用超时'
    };

    return reasons.map((reason) => labels[reason] || reason).join('、');
  }

  function formatDateTime(value) {
    if (!value) return '未设置';
    const date = new Date(value);
    return [
      `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`,
      `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    ].join(' ');
  }

  function formatDurationMinutes(minutes) {
    const totalMinutes = Math.max(0, Math.round(minutes));
    const hours = Math.floor(totalMinutes / 60);
    const remainMinutes = totalMinutes % 60;

    if (hours && remainMinutes) return `${hours}小时${remainMinutes}分钟`;
    if (hours) return `${hours}小时`;
    return `${remainMinutes}分钟`;
  }

  function createWindowId() {
    return `window-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  }

  function isBilibiliHostname(hostname) {
    return hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com');
  }

  function isBilibiliUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        isBilibiliHostname(url.hostname)
      );
    } catch (error) {
      return false;
    }
  }

  function isRedirectCandidateUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      const host = url.hostname;
      const pathname = url.pathname;

      if (!isBilibiliUrl(url.href)) return false;
      if (REDIRECT_WHITELIST_HOSTS.includes(host)) return false;
      if (
        pathname.startsWith('/video/') ||
        pathname.startsWith('/bangumi/play/') ||
        pathname.startsWith('/bangumi/media/') ||
        pathname.startsWith('/list/') ||
        pathname.startsWith('/medialist/')
      ) return false;

      return true;
    } catch (error) {
      return false;
    }
  }

  function getDefaultSyncState() {
    return {
      ...DEFAULT_FEATURE_PREFERENCES,
      lockConfig: ensureLockConfig(DEFAULT_LOCK_CONFIG),
      appearanceConfig: { ...DEFAULT_APPEARANCE_CONFIG },
      playerShortcutConfig: ensurePlayerShortcutConfig(DEFAULT_PLAYER_SHORTCUT_CONFIG)
    };
  }

  global.BiliFocusShared = {
    FEATURE_KEYS,
    DEFAULT_LOCKED_FEATURE_KEYS,
    DAY_LABELS,
    DEFAULT_FEATURE_PREFERENCES,
    DEFAULT_LOCK_CONFIG,
    DEFAULT_APPEARANCE_CONFIG,
    PLAYER_SHORTCUT_ACTIONS,
    PLAYER_SHORTCUT_ACTION_IDS,
    PLAYER_SHORTCUT_REPEATABLE_ACTIONS,
    DEFAULT_PLAYER_SHORTCUT_BINDINGS,
    DEFAULT_PLAYER_SHORTCUT_CONFIG,
    DEFAULT_FOCUS_SESSION,
    DEFAULT_USAGE_STATE,
    DEFAULT_LOCK_STATUS,
    DEFAULT_EFFECTIVE_FEATURE_STATE,
    DEFAULT_FEATURE_OVERRIDE_DISABLED,
    REDIRECT_WHITELIST_HOSTS,
    REDIRECT_TARGET_URL,
    ensureFeaturePreferences,
    ensureFeatureOverrideDisabled,
    ensureLockConfig,
    ensureFocusSession,
    ensureAppearanceConfig,
    normalizeShortcutBinding,
    getShortcutBindingSignature,
    ensurePlayerShortcutConfig,
    shortcutBindingMatchesEvent,
    ensureUsageState,
    ensureLockStatus,
    ensureEffectiveFeatureState,
    parseTimeInput,
    formatTimeInput,
    formatDateTime,
    formatDurationMinutes,
    getMinutesOfDay,
    getLogicalDayInfo,
    getActiveWeeklyWindows,
    getUpcomingScheduleChanges,
    getNextScheduleChangeAt,
    computeEffectiveFeatureState,
    getLockReasonsSummary,
    createWindowId,
    isBilibiliHostname,
    isBilibiliUrl,
    isRedirectCandidateUrl,
    getDefaultSyncState
  };
})(globalThis);
