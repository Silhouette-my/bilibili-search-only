const {
  FEATURE_KEYS,
  DAY_LABELS,
  DEFAULT_LOCK_CONFIG,
  DEFAULT_APPEARANCE_CONFIG,
  DEFAULT_PLAYER_SHORTCUT_CONFIG,
  PLAYER_SHORTCUT_ACTIONS,
  ensureLockConfig,
  ensureAppearanceConfig,
  ensurePlayerShortcutConfig,
  normalizeShortcutBinding,
  getShortcutBindingSignature,
  formatTimeInput,
  parseTimeInput,
  createWindowId
} = globalThis.BiliFocusShared;
const backgroundClient = globalThis.BiliFocusClient;

const weeklyScheduleEnabled = document.getElementById('weeklyScheduleEnabled');
const weeklyWindowsList = document.getElementById('weeklyWindowsList');
const addWeeklyWindow = document.getElementById('addWeeklyWindow');
const dailyUsageEnabled = document.getElementById('dailyUsageEnabled');
const dailyUsageMinutes = document.getElementById('dailyUsageMinutes');
const dailyResetTime = document.getElementById('dailyResetTime');
const blockWhenScheduled = document.getElementById('blockWhenScheduled');
const blockDuringFocus = document.getElementById('blockDuringFocus');
const blockAfterDailyLimit = document.getElementById('blockAfterDailyLimit');
const strictModeEnabled = document.getElementById('strictModeEnabled');
const saveSettings = document.getElementById('saveSettings');
const saveHint = document.getElementById('saveHint');
const themeInputs = Array.from(document.querySelectorAll('input[name="themeMode"]'));
const lockedFeatureInputs = Array.from(document.querySelectorAll('[data-lock-feature-key]'));
const playerShortcutsEnabled = document.getElementById('playerShortcutsEnabled');
const shortcutBindingList = document.getElementById('shortcutBindingList');
const shortcutRecordingHint = document.getElementById('shortcutRecordingHint');

let workingConfig = ensureLockConfig(DEFAULT_LOCK_CONFIG);
let workingAppearance = ensureAppearanceConfig(DEFAULT_APPEARANCE_CONFIG);
let workingShortcutConfig = ensurePlayerShortcutConfig(DEFAULT_PLAYER_SHORTCUT_CONFIG);
let latestLockStatus = null;
let loadedRevision = null;
let loadedSettingsSignature = null;
let isDirty = false;
let recordingShortcutActionId = null;
let recordingShortcutButton = null;

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

function getRestrictionFieldLocks(config, lockStatus) {
  const status = lockStatus || latestLockStatus;
  const lockedFeatures = Boolean(status && status.panelLocked);
  if (!status || !status.enforced || !status.strictModeEnabled) {
    return {
      strictModeToggle: false,
      blockConditions: false,
      scheduleRule: false,
      dailyRule: false,
      lockedFeatures
    };
  }

  return {
    strictModeToggle: true,
    blockConditions: true,
    scheduleRule: Boolean(status.lockedBySchedule && config.blockConditions.schedule),
    dailyRule: Boolean(status.lockedByDailyLimit && config.blockConditions.dailyLimit),
    lockedFeatures
  };
}

function applyRestrictionFieldLocks(config, lockStatus) {
  const locks = getRestrictionFieldLocks(config, lockStatus);
  strictModeEnabled.disabled = locks.strictModeToggle;
  blockWhenScheduled.disabled = locks.blockConditions;
  blockDuringFocus.disabled = locks.blockConditions;
  blockAfterDailyLimit.disabled = locks.blockConditions;
  weeklyScheduleEnabled.disabled = locks.scheduleRule;
  addWeeklyWindow.disabled = locks.scheduleRule;
  dailyUsageEnabled.disabled = locks.dailyRule;
  dailyUsageMinutes.disabled = locks.dailyRule;
  dailyResetTime.disabled = locks.dailyRule;
  lockedFeatureInputs.forEach((input) => {
    input.disabled = locks.lockedFeatures;
  });

  const weeklyFields = weeklyWindowsList.querySelectorAll('select, input, button');
  weeklyFields.forEach((field) => {
    field.disabled = locks.scheduleRule;
  });
}

function markDirty() {
  isDirty = true;
  saveHint.textContent = '';
}

function getSettingsSignature(lockConfig, appearanceConfig, playerShortcutConfig) {
  return JSON.stringify({
    lockConfig: ensureLockConfig(lockConfig),
    appearanceConfig: ensureAppearanceConfig(appearanceConfig),
    playerShortcutConfig: ensurePlayerShortcutConfig(playerShortcutConfig)
  });
}

function getShortcutCodeLabel(code) {
  const labels = {
    Space: 'Space',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'Page Up',
    PageDown: 'Page Down'
  };
  if (labels[code]) return labels[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`;
  return code;
}

function formatShortcutBinding(binding) {
  const normalized = normalizeShortcutBinding(binding);
  if (!normalized) return '未设置';
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');
  const parts = [];
  if (normalized.ctrl) parts.push(isMac ? '⌃' : 'Ctrl');
  if (normalized.alt) parts.push(isMac ? '⌥' : 'Alt');
  if (normalized.shift) parts.push(isMac ? '⇧' : 'Shift');
  if (normalized.meta) parts.push(isMac ? '⌘' : 'Meta');
  parts.push(getShortcutCodeLabel(normalized.code));
  return parts.join(isMac ? '' : ' + ');
}

function finishShortcutRecording(message = '') {
  if (recordingShortcutButton) {
    recordingShortcutButton.classList.remove('is-recording');
    recordingShortcutButton.textContent = '录制';
  }
  recordingShortcutActionId = null;
  recordingShortcutButton = null;
  shortcutRecordingHint.textContent = message;
}

function startShortcutRecording(actionId, button) {
  finishShortcutRecording();
  recordingShortcutActionId = actionId;
  recordingShortcutButton = button;
  button.classList.add('is-recording');
  button.textContent = '按下按键…';
  shortcutRecordingHint.textContent = '请按下要绑定的单键或组合键；按 Esc 取消。';
}

function renderShortcutBindings() {
  shortcutBindingList.innerHTML = '';
  playerShortcutsEnabled.checked = workingShortcutConfig.enabled;

  PLAYER_SHORTCUT_ACTIONS.forEach((action) => {
    const row = document.createElement('div');
    row.className = 'shortcut-binding-row';
    row.dataset.action = action.id;

    const label = document.createElement('div');
    label.className = 'shortcut-action-copy';
    const title = document.createElement('strong');
    title.textContent = action.label;
    const value = document.createElement('span');
    value.className = 'shortcut-binding-value';
    value.textContent = formatShortcutBinding(workingShortcutConfig.bindings[action.id]);
    label.appendChild(title);
    label.appendChild(value);

    const actions = document.createElement('div');
    actions.className = 'shortcut-row-actions';
    const recordButton = document.createElement('button');
    recordButton.type = 'button';
    recordButton.className = 'secondary-button shortcut-record-button';
    recordButton.textContent = '录制';
    recordButton.addEventListener('click', () => {
      startShortcutRecording(action.id, recordButton);
    });
    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'danger-button shortcut-clear-button';
    clearButton.textContent = '清除';
    clearButton.disabled = !workingShortcutConfig.bindings[action.id];
    clearButton.addEventListener('click', () => {
      workingShortcutConfig.bindings[action.id] = null;
      finishShortcutRecording('已清除该快捷键。');
      renderShortcutBindings();
      markDirty();
    });
    actions.appendChild(recordButton);
    actions.appendChild(clearButton);
    row.appendChild(label);
    row.appendChild(actions);
    shortcutBindingList.appendChild(row);
  });
}

function applyShortcutConfigToForm(config) {
  workingShortcutConfig = ensurePlayerShortcutConfig(config);
  finishShortcutRecording();
  renderShortcutBindings();
}

function isInvalidRecordedShortcut(event) {
  return !normalizeShortcutBinding({
    code: event.code,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey
  });
}

function handleShortcutRecording(event) {
  if (!recordingShortcutActionId) return;
  event.preventDefault();
  event.stopImmediatePropagation();

  if (event.code === 'Escape') {
    finishShortcutRecording('已取消录制。');
    return;
  }
  if (event.repeat || isInvalidRecordedShortcut(event)) {
    shortcutRecordingHint.textContent = '这个按键不能使用，请换一个单键或组合键。';
    return;
  }

  const binding = normalizeShortcutBinding({
    code: event.code,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey
  });
  const signature = getShortcutBindingSignature(binding);
  PLAYER_SHORTCUT_ACTIONS.forEach((action) => {
    if (
      action.id !== recordingShortcutActionId &&
      getShortcutBindingSignature(workingShortcutConfig.bindings[action.id]) === signature
    ) {
      workingShortcutConfig.bindings[action.id] = null;
    }
  });
  workingShortcutConfig.bindings[recordingShortcutActionId] = binding;
  const message = `已录制 ${formatShortcutBinding(binding)}；点击“保存设置”后生效。`;
  finishShortcutRecording(message);
  renderShortcutBindings();
  shortcutRecordingHint.textContent = message;
  markDirty();
}

function createWindowRow(windowConfig) {
  const container = document.createElement('div');
  container.className = 'window-item';
  container.dataset.id = windowConfig.id;

  const weekdayField = document.createElement('label');
  weekdayField.className = 'field';
  weekdayField.innerHTML = '<span>星期</span>';
  const weekdaySelect = document.createElement('select');
  DAY_LABELS.forEach((label, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = label;
    option.selected = index === windowConfig.weekday;
    weekdaySelect.appendChild(option);
  });
  weekdayField.appendChild(weekdaySelect);

  const startField = document.createElement('label');
  startField.className = 'field';
  startField.innerHTML = '<span>开始时间</span>';
  const startInput = document.createElement('input');
  startInput.type = 'time';
  startInput.value = formatTimeInput(windowConfig.startMinutes);
  startField.appendChild(startInput);

  const endField = document.createElement('label');
  endField.className = 'field';
  endField.innerHTML = '<span>结束时间</span>';
  const endInput = document.createElement('input');
  endInput.type = 'time';
  endInput.value = formatTimeInput(windowConfig.endMinutes);
  endField.appendChild(endInput);

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'danger-button';
  removeButton.textContent = '删除';
  removeButton.addEventListener('click', () => {
    workingConfig.weeklyWindows = workingConfig.weeklyWindows.filter((item) => item.id !== windowConfig.id);
    renderWeeklyWindows();
    markDirty();
  });

  weekdaySelect.addEventListener('change', () => {
    updateWindow(windowConfig.id, { weekday: Number(weekdaySelect.value) });
  });
  startInput.addEventListener('change', () => {
    updateWindow(windowConfig.id, { startMinutes: parseTimeInput(startInput.value) });
  });
  endInput.addEventListener('change', () => {
    updateWindow(windowConfig.id, { endMinutes: parseTimeInput(endInput.value) });
  });

  container.appendChild(weekdayField);
  container.appendChild(startField);
  container.appendChild(endField);
  container.appendChild(removeButton);

  return container;
}

function updateWindow(id, patch) {
  workingConfig.weeklyWindows = workingConfig.weeklyWindows.map((item) => {
    if (item.id !== id) return item;
    return { ...item, ...patch };
  });
  markDirty();
}

function renderWeeklyWindows() {
  weeklyWindowsList.innerHTML = '';

  if (!workingConfig.weeklyWindows.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '还没有固定时段，点击“新增时段”开始配置。';
    weeklyWindowsList.appendChild(empty);
    return;
  }

  workingConfig.weeklyWindows.forEach((windowConfig) => {
    weeklyWindowsList.appendChild(createWindowRow(windowConfig));
  });
}

function applyConfigToForm(config) {
  workingConfig = ensureLockConfig(config);
  weeklyScheduleEnabled.checked = workingConfig.weeklyScheduleEnabled;
  dailyUsageEnabled.checked = workingConfig.dailyUsageLimit.enabled;
  dailyUsageMinutes.value = String(workingConfig.dailyUsageLimit.limitMinutes);
  dailyResetTime.value = formatTimeInput(workingConfig.dailyUsageLimit.resetMinutesAfterMidnight);
  blockWhenScheduled.checked = workingConfig.blockConditions.schedule;
  blockDuringFocus.checked = workingConfig.blockConditions.focus;
  blockAfterDailyLimit.checked = workingConfig.blockConditions.dailyLimit;
  strictModeEnabled.checked = workingConfig.strictModeEnabled;
  const lockedFeatureKeys = new Set(workingConfig.lockedFeatureKeys);
  lockedFeatureInputs.forEach((input) => {
    input.checked = lockedFeatureKeys.has(input.dataset.lockFeatureKey);
  });
  renderWeeklyWindows();
  applyRestrictionFieldLocks(workingConfig);
}

function applyAppearanceToForm(appearanceConfig) {
  workingAppearance = ensureAppearanceConfig(appearanceConfig);
  themeInputs.forEach((input) => {
    input.checked = input.value === workingAppearance.theme;
  });
  applyTheme(workingAppearance.theme);
}

function readConfigFromForm() {
  const lockedFeatureKeys = lockedFeatureInputs
    .filter((input) => input.checked && FEATURE_KEYS.includes(input.dataset.lockFeatureKey))
    .map((input) => input.dataset.lockFeatureKey);

  return ensureLockConfig({
    weeklyScheduleEnabled: weeklyScheduleEnabled.checked,
    weeklyWindows: workingConfig.weeklyWindows,
    dailyUsageLimit: {
      enabled: dailyUsageEnabled.checked,
      limitMinutes: Number(dailyUsageMinutes.value),
      resetMinutesAfterMidnight: parseTimeInput(dailyResetTime.value)
    },
    blockConditions: {
      schedule: blockWhenScheduled.checked,
      focus: blockDuringFocus.checked,
      dailyLimit: blockAfterDailyLimit.checked
    },
    lockedFeatureKeys,
    strictModeEnabled: strictModeEnabled.checked
  });
}

function readAppearanceFromForm() {
  const selected = themeInputs.find((input) => input.checked);
  return ensureAppearanceConfig({
    theme: selected ? selected.value : workingAppearance.theme
  });
}

async function loadConfig() {
  try {
    const snapshot = await backgroundClient.getState({ refresh: true });
    loadedRevision = snapshot.revision;
    loadedSettingsSignature = getSettingsSignature(
      snapshot.lockConfig,
      snapshot.appearanceConfig,
      snapshot.playerShortcutConfig
    );
    latestLockStatus = snapshot.lockStatus || null;
    applyConfigToForm(snapshot.lockConfig || DEFAULT_LOCK_CONFIG);
    applyAppearanceToForm(snapshot.appearanceConfig || DEFAULT_APPEARANCE_CONFIG);
    applyShortcutConfigToForm(
      snapshot.playerShortcutConfig || DEFAULT_PLAYER_SHORTCUT_CONFIG
    );
    isDirty = false;
  } catch (error) {
    saveHint.textContent = `加载失败：${error.message}`;
  }
}

async function saveConfig() {
  const nextConfig = readConfigFromForm();
  const nextAppearance = readAppearanceFromForm();

  saveSettings.disabled = true;
  try {
    const snapshot = await backgroundClient.saveSettings(
      nextConfig,
      nextAppearance,
      loadedRevision,
      loadedSettingsSignature,
      workingShortcutConfig
    );
    loadedRevision = snapshot.revision;
    loadedSettingsSignature = getSettingsSignature(
      snapshot.lockConfig,
      snapshot.appearanceConfig,
      snapshot.playerShortcutConfig
    );
    latestLockStatus = snapshot.lockStatus || null;
    applyConfigToForm(snapshot.lockConfig);
    applyAppearanceToForm(snapshot.appearanceConfig);
    applyShortcutConfigToForm(snapshot.playerShortcutConfig);
    isDirty = false;
    saveHint.textContent = `已保存 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  } catch (error) {
    saveHint.textContent = error.code === 'state_conflict'
      ? '设置已在其他页面或设备更新；请重新载入后再保存。'
      : `保存失败：${error.message}`;
  } finally {
    saveSettings.disabled = false;
  }
}

addWeeklyWindow.addEventListener('click', () => {
  workingConfig.weeklyWindows.push({
    id: createWindowId(),
    weekday: 1,
    startMinutes: 540,
    endMinutes: 1080
  });
  renderWeeklyWindows();
  markDirty();
});

themeInputs.forEach((input) => {
  input.addEventListener('change', () => {
    workingAppearance = readAppearanceFromForm();
    applyTheme(workingAppearance.theme);
    markDirty();
  });
});

playerShortcutsEnabled.addEventListener('change', () => {
  workingShortcutConfig.enabled = playerShortcutsEnabled.checked;
  markDirty();
});

window.addEventListener('keydown', handleShortcutRecording, true);

saveSettings.addEventListener('click', saveConfig);
document.addEventListener('input', markDirty);
document.addEventListener('change', markDirty);

backgroundClient.subscribe((snapshot) => {
  latestLockStatus = snapshot.lockStatus || null;
  applyRestrictionFieldLocks(workingConfig, latestLockStatus);
  const incomingSettingsSignature = getSettingsSignature(
    snapshot.lockConfig,
    snapshot.appearanceConfig,
    snapshot.playerShortcutConfig
  );

  if (isDirty) {
    const settingsChanged = loadedSettingsSignature !== incomingSettingsSignature;
    if (settingsChanged) {
      saveHint.textContent = '检测到外部设置更新；当前未保存编辑会保留，保存前请重新载入。';
    } else {
      loadedRevision = snapshot.revision;
    }
    return;
  }

  loadedRevision = snapshot.revision;
  if (loadedSettingsSignature === incomingSettingsSignature) return;

  loadedSettingsSignature = incomingSettingsSignature;
  applyConfigToForm(snapshot.lockConfig || DEFAULT_LOCK_CONFIG);
  applyAppearanceToForm(snapshot.appearanceConfig || DEFAULT_APPEARANCE_CONFIG);
  applyShortcutConfigToForm(
    snapshot.playerShortcutConfig || DEFAULT_PLAYER_SHORTCUT_CONFIG
  );
});

loadConfig();
