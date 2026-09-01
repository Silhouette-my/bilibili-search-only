const backgroundClient = globalThis.BiliFocusClient;

let bfHeartbeatTimer = null;
let bfHeartbeatActive = false;

function bfSendActivityPing(final = false) {
  backgroundClient.activityPing(final).catch(() => null);
}

function bfStopHeartbeat() {
  if (bfHeartbeatTimer) {
    window.clearInterval(bfHeartbeatTimer);
    bfHeartbeatTimer = null;
  }
  bfHeartbeatActive = false;
}

function bfStartHeartbeat() {
  if (bfHeartbeatActive) return;
  bfHeartbeatActive = true;
  bfSendActivityPing();
  bfHeartbeatTimer = window.setInterval(bfSendActivityPing, 15000);
}

function bfSyncHeartbeat() {
  const shouldBeActive = document.visibilityState === 'visible' && document.hasFocus();

  if (shouldBeActive) {
    bfStartHeartbeat();
    return;
  }

  if (bfHeartbeatActive) {
    bfSendActivityPing();
    bfStopHeartbeat();
  }
}

async function bfLoadRuntimeState() {
  await backgroundClient.ensureRuntime();
}

document.addEventListener('visibilitychange', bfSyncHeartbeat);
window.addEventListener('focus', bfSyncHeartbeat);
window.addEventListener('blur', bfSyncHeartbeat);
window.addEventListener('pagehide', () => {
  if (bfHeartbeatActive) {
    bfSendActivityPing(true);
    bfStopHeartbeat();
  }
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    bfLoadRuntimeState().catch(() => null);
  }
  bfSyncHeartbeat();
});

bfLoadRuntimeState().catch(() => null);
bfSyncHeartbeat();
