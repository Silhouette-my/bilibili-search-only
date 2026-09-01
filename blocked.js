const {
  ensureEffectiveFeatureState,
  ensureLockStatus,
  formatDateTime,
  getLockReasonsSummary
} = globalThis.BiliFocusShared;
const backgroundClient = globalThis.BiliFocusClient;

const blockedSubtitle = document.getElementById('blockedSubtitle');
const blockedReasons = document.getElementById('blockedReasons');
const blockedUntil = document.getElementById('blockedUntil');
const blockedMode = document.getElementById('blockedMode');
const blockedError = document.getElementById('blockedError');

let latestLockStatus = ensureLockStatus(null);
let resumeInFlight = false;
let blockedPageSuspended = false;
let blockedStateRequestId = 0;
let blockedUnsubscribe = null;
let remainingTimerId = null;
let blockedLifecycleGeneration = 0;
let blockedResumeRequestId = 0;

function formatRemaining(unlockAt) {
  if (!unlockAt) return '暂不可用';
  const remainingMinutes = Math.max(0, Math.ceil((unlockAt - Date.now()) / 60000));
  if (!remainingMinutes) return '即将结束';

  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  if (hours && minutes) return `${hours}小时${minutes}分钟`;
  if (hours) return `${hours}小时`;
  return `${minutes}分钟`;
}

function renderLockStatus(lockStatus) {
  latestLockStatus = ensureLockStatus(lockStatus);
  const reasons = latestLockStatus.restrictionReasons.length
    ? latestLockStatus.restrictionReasons
    : latestLockStatus.reasons;

  blockedReasons.textContent = reasons.length
    ? getLockReasonsSummary(reasons)
    : '手动站点封锁';
  blockedUntil.textContent = latestLockStatus.nextUnlockAt
    ? `${formatDateTime(latestLockStatus.nextUnlockAt)} · 约 ${formatRemaining(latestLockStatus.nextUnlockAt)}后`
    : '暂不可用';
  blockedSubtitle.textContent = latestLockStatus.enforced
    ? '访问限制已由扩展后台生效，页面内容无法自行移除这层保护。'
    : '站点封锁已开启，关闭后此标签页会自动恢复。';
  blockedMode.textContent = latestLockStatus.strictModeEnabled && latestLockStatus.enforced
    ? '严格模式已开启，无法通过页面或控制面板提前解除本次限制。'
    : '限制解除后，此标签页会自动恢复到安全目标。';
}

async function resumeIfAllowed() {
  if (resumeInFlight) return;
  resumeInFlight = true;
  const resumeRequestId = ++blockedResumeRequestId;
  const lifecycleGeneration = blockedLifecycleGeneration;
  blockedError.textContent = '';

  try {
    await backgroundClient.resumeBlockedTab();
  } catch (error) {
    if (resumeRequestId !== blockedResumeRequestId) return;
    if (
      !blockedPageSuspended &&
      lifecycleGeneration === blockedLifecycleGeneration
    ) {
      blockedError.textContent = `自动恢复暂时失败：${error.message}`;
    }
    resumeInFlight = false;
  }
}

async function applyBlockedSnapshot(snapshot) {
  const effectiveFeatureState = ensureEffectiveFeatureState(snapshot.effectiveFeatureState);

  if (!effectiveFeatureState.siteBlockEnabled) {
    await resumeIfAllowed();
    return;
  }

  blockedResumeRequestId += 1;
  resumeInFlight = false;
  blockedError.textContent = '';
  renderLockStatus(snapshot.lockStatus);
}

async function refreshBlockedState(forceRefresh = false, suppliedSnapshot = null) {
  const requestId = ++blockedStateRequestId;
  const snapshot = suppliedSnapshot ||
    await backgroundClient.getState({ refresh: forceRefresh });
  if (requestId !== blockedStateRequestId || blockedPageSuspended) return;
  await applyBlockedSnapshot(snapshot);
}

function subscribeBlockedRuntime() {
  if (blockedUnsubscribe) return;

  blockedUnsubscribe = backgroundClient.subscribe((snapshot) => {
    refreshBlockedState(false, snapshot).catch((error) => {
      if (!blockedPageSuspended) {
        blockedError.textContent = `状态刷新失败：${error.message}`;
      }
    });
  });
}

function unsubscribeBlockedRuntime() {
  if (!blockedUnsubscribe) return;
  blockedUnsubscribe();
  blockedUnsubscribe = null;
}

function updateRemainingTime() {
  if (latestLockStatus.nextUnlockAt) {
    blockedUntil.textContent =
      `${formatDateTime(latestLockStatus.nextUnlockAt)} · 约 ${formatRemaining(latestLockStatus.nextUnlockAt)}后`;
  }
}

function startRemainingTimer() {
  if (remainingTimerId !== null || blockedPageSuspended) return;
  updateRemainingTime();
  remainingTimerId = window.setInterval(updateRemainingTime, 1000);
}

function stopRemainingTimer() {
  if (remainingTimerId === null) return;
  window.clearInterval(remainingTimerId);
  remainingTimerId = null;
}

function suspendBlockedRuntime() {
  blockedPageSuspended = true;
  blockedLifecycleGeneration += 1;
  blockedStateRequestId += 1;
  blockedResumeRequestId += 1;
  resumeInFlight = false;
  unsubscribeBlockedRuntime();
  stopRemainingTimer();
}

async function resumeBlockedRuntime() {
  if (!blockedPageSuspended) return;
  blockedPageSuspended = false;
  const lifecycleGeneration = ++blockedLifecycleGeneration;
  startRemainingTimer();

  const requestId = ++blockedStateRequestId;
  try {
    const snapshot = await backgroundClient.getState({ refresh: true });
    if (requestId !== blockedStateRequestId || blockedPageSuspended) return;
    await applyBlockedSnapshot(snapshot);
  } catch (error) {
    if (
      !blockedPageSuspended &&
      lifecycleGeneration === blockedLifecycleGeneration
    ) {
      blockedError.textContent = `状态加载失败：${error.message}`;
    }
  } finally {
    if (
      !blockedPageSuspended &&
      lifecycleGeneration === blockedLifecycleGeneration
    ) {
      subscribeBlockedRuntime();
    }
  }
}

window.addEventListener('pagehide', suspendBlockedRuntime);
window.addEventListener('pageshow', resumeBlockedRuntime);

startRemainingTimer();
subscribeBlockedRuntime();
const initialBlockedLifecycleGeneration = blockedLifecycleGeneration;
refreshBlockedState(true).catch((error) => {
  if (
    !blockedPageSuspended &&
    initialBlockedLifecycleGeneration === blockedLifecycleGeneration
  ) {
    blockedError.textContent = `状态加载失败：${error.message}`;
  }
});
