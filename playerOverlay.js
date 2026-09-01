const BF_PLAYER_RECOMMENDATIONS_SELECTOR = '.recommend-list-v1';

const bfPlayerBackgroundClient = globalThis.BiliFocusClient;

const bfPlayerRecommendationsController = {
  active: false,
  style: null
};

const bfAutoPlayController = {
  active: false,
  style: null,
  observer: null,
  observerMode: 'none',
  root: null,
  switchButton: null,
  intervalId: null,
  timeoutId: null,
  frameId: null,
  lastClickTime: 0
};

let bfPlayerPageSuspended = false;
let bfLatestPlayerFeatureState = {};
let bfPlayerStateRequestId = 0;
let bfPlayerUnsubscribe = null;
let bfPlayerLifecycleGeneration = 0;

function bfEnsurePlayerRecommendationsStyle() {
  if (bfPlayerRecommendationsController.style) {
    if (!bfPlayerRecommendationsController.style.isConnected) {
      document.head.appendChild(bfPlayerRecommendationsController.style);
    }
    return;
  }

  const style = document.createElement('style');
  style.id = 'bili-hide-player-recommendations-style';
  style.textContent = `
    ${BF_PLAYER_RECOMMENDATIONS_SELECTOR} {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
  bfPlayerRecommendationsController.style = style;
}

function bfStartPlayerRecommendations() {
  if (bfPlayerPageSuspended || !document.head) return;

  bfPlayerRecommendationsController.active = true;
  bfEnsurePlayerRecommendationsStyle();
}

function bfStopPlayerRecommendations() {
  bfPlayerRecommendationsController.active = false;
  if (bfPlayerRecommendationsController.style) {
    bfPlayerRecommendationsController.style.remove();
    bfPlayerRecommendationsController.style = null;
  }
}

function bfObserveAncestorChildLists(observer, node, observedTargets = new Set()) {
  let current = node;
  while (current && current.parentNode) {
    const parent = current.parentNode;
    if (!observedTargets.has(parent)) {
      observer.observe(parent, {
        childList: true,
        attributes: true,
        attributeFilter: ['class', 'style']
      });
      observedTargets.add(parent);
    }
    current = parent;
  }
}

function bfEnsureEndingStyle() {
  if (bfAutoPlayController.style) {
    if (!bfAutoPlayController.style.isConnected) {
      document.head.appendChild(bfAutoPlayController.style);
    }
    return;
  }

  const style = document.createElement('style');
  style.id = 'bili-hide-ending-related-style';
  style.textContent = `
    .bpx-player-ending-related {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
  bfAutoPlayController.style = style;
}

function bfRemoveEndingStyle() {
  if (bfAutoPlayController.style) {
    bfAutoPlayController.style.remove();
    bfAutoPlayController.style = null;
  }
}

function bfQueryAutoPlayTarget() {
  const root = Array.from(document.querySelectorAll('.continuous-btn .txt'))
    .find((label) => label.textContent.trim() === '自动连播')
    ?.closest('.continuous-btn') || null;
  const switchButton = root?.querySelector('.switch-btn') || null;
  return root && switchButton ? { root, switchButton } : null;
}

function bfDisconnectAutoPlayObserver() {
  if (bfAutoPlayController.observer) {
    bfAutoPlayController.observer.disconnect();
    bfAutoPlayController.observer = null;
  }
  bfAutoPlayController.observerMode = 'none';
}

function bfObserveAutoPlayTarget(target) {
  bfDisconnectAutoPlayObserver();
  bfAutoPlayController.root = target && target.root.isConnected ? target.root : null;
  bfAutoPlayController.switchButton =
    target && target.switchButton.isConnected ? target.switchButton : null;

  if (!bfAutoPlayController.active || !document.body) return;

  if (!bfAutoPlayController.root || !bfAutoPlayController.switchButton) {
    bfAutoPlayController.root = null;
    bfAutoPlayController.switchButton = null;
    bfAutoPlayController.observerMode = 'discovery';
    bfAutoPlayController.observer = new MutationObserver(() => {
      if (!bfAutoPlayController.active) return;
      bfSyncAutoPlayTarget(true);
      bfScheduleAutoPlayCheck();
    });
    bfAutoPlayController.observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    if (document.documentElement !== document.body) {
      bfAutoPlayController.observer.observe(document.documentElement, { childList: true });
    }
    bfAutoPlayController.observer.observe(document.head, { childList: true });
    return;
  }

  const currentRoot = bfAutoPlayController.root;
  bfAutoPlayController.observerMode = 'target';
  bfAutoPlayController.observer = new MutationObserver(() => {
    if (!bfAutoPlayController.active) return;
    bfSyncAutoPlayTarget(true);
    bfScheduleAutoPlayCheck();
  });
  bfAutoPlayController.observer.observe(currentRoot, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  });
  bfObserveAncestorChildLists(
    bfAutoPlayController.observer,
    currentRoot,
    new Set([currentRoot])
  );
  bfAutoPlayController.observer.observe(document.head, { childList: true });
}

function bfSyncAutoPlayTarget(force = false) {
  if (
    !force &&
    bfAutoPlayController.root &&
    bfAutoPlayController.root.isConnected &&
    bfAutoPlayController.switchButton &&
    bfAutoPlayController.switchButton.isConnected
  ) {
    return {
      root: bfAutoPlayController.root,
      switchButton: bfAutoPlayController.switchButton
    };
  }

  const nextTarget = bfQueryAutoPlayTarget();
  if (
    nextTarget &&
    nextTarget.root === bfAutoPlayController.root &&
    nextTarget.switchButton === bfAutoPlayController.switchButton
  ) {
    return nextTarget;
  }
  bfObserveAutoPlayTarget(nextTarget);
  return nextTarget;
}

function bfCloseAutoPlayIfNeeded() {
  bfEnsureEndingStyle();
  const target = bfSyncAutoPlayTarget();
  const switchButton = target && target.switchButton;
  if (!switchButton || !switchButton.classList.contains('on')) return;

  const now = Date.now();
  if (now - bfAutoPlayController.lastClickTime < 1000) return;

  bfAutoPlayController.lastClickTime = now;
  switchButton.click();
}

function bfScheduleAutoPlayCheck() {
  if (!bfAutoPlayController.active || bfAutoPlayController.frameId !== null) return;

  bfAutoPlayController.frameId = requestAnimationFrame(() => {
    bfAutoPlayController.frameId = null;
    if (bfAutoPlayController.active) {
      bfCloseAutoPlayIfNeeded();
    }
  });
}

function bfStartAutoPlayController() {
  if (bfAutoPlayController.active || bfPlayerPageSuspended || !document.body) return;

  bfAutoPlayController.active = true;
  bfEnsureEndingStyle();
  bfObserveAutoPlayTarget(bfQueryAutoPlayTarget());
  bfScheduleAutoPlayCheck();

  bfAutoPlayController.intervalId = window.setInterval(bfScheduleAutoPlayCheck, 1000);
  bfAutoPlayController.timeoutId = window.setTimeout(() => {
    if (bfAutoPlayController.intervalId !== null) {
      window.clearInterval(bfAutoPlayController.intervalId);
      bfAutoPlayController.intervalId = null;
    }
    bfAutoPlayController.timeoutId = null;
  }, 15000);

}

function bfStopAutoPlayController() {
  bfAutoPlayController.active = false;
  bfAutoPlayController.lastClickTime = 0;

  if (bfAutoPlayController.frameId !== null) {
    cancelAnimationFrame(bfAutoPlayController.frameId);
    bfAutoPlayController.frameId = null;
  }

  bfDisconnectAutoPlayObserver();
  bfAutoPlayController.root = null;
  bfAutoPlayController.switchButton = null;
  if (bfAutoPlayController.intervalId !== null) {
    window.clearInterval(bfAutoPlayController.intervalId);
    bfAutoPlayController.intervalId = null;
  }
  if (bfAutoPlayController.timeoutId !== null) {
    window.clearTimeout(bfAutoPlayController.timeoutId);
    bfAutoPlayController.timeoutId = null;
  }

  bfRemoveEndingStyle();
}

function bfApplyEffectiveFeatureState(featureState) {
  bfLatestPlayerFeatureState = featureState || {};
  if (bfPlayerPageSuspended) {
    bfStopPlayerRecommendations();
    bfStopAutoPlayController();
    return;
  }

  const playerRecommendationsHidden =
    !featureState || featureState.playerMaskEnabled !== false;
  const autoPlayOffEnabled = !featureState || featureState.autoPlayOffEnabled !== false;

  if (playerRecommendationsHidden) {
    bfStartPlayerRecommendations();
  } else {
    bfStopPlayerRecommendations();
  }

  if (autoPlayOffEnabled) {
    bfStartAutoPlayController();
  } else {
    bfStopAutoPlayController();
  }
}

function bfApplyPlayerSnapshot(snapshot) {
  const featureState = snapshot && snapshot.effectiveFeatureState || {};
  bfApplyEffectiveFeatureState(featureState);
}

function bfSubscribePlayerRuntime() {
  if (bfPlayerUnsubscribe) return;

  bfPlayerUnsubscribe = bfPlayerBackgroundClient.subscribe((snapshot) => {
    bfPlayerStateRequestId += 1;
    bfApplyPlayerSnapshot(snapshot);
  });
}

function bfUnsubscribePlayerRuntime() {
  if (!bfPlayerUnsubscribe) return;
  bfPlayerUnsubscribe();
  bfPlayerUnsubscribe = null;
}

async function bfRefreshPlayerRuntime() {
  const requestId = ++bfPlayerStateRequestId;
  const snapshot = await bfPlayerBackgroundClient.getState({ refresh: true });

  if (requestId !== bfPlayerStateRequestId || bfPlayerPageSuspended) return;
  bfApplyPlayerSnapshot(snapshot);
}

function bfSuspendPlayerRuntime() {
  bfPlayerPageSuspended = true;
  bfPlayerLifecycleGeneration += 1;
  bfPlayerStateRequestId += 1;
  bfUnsubscribePlayerRuntime();
  bfStopPlayerRecommendations();
  bfStopAutoPlayController();
}

function bfResumePlayerRuntime() {
  if (!bfPlayerPageSuspended) return;
  bfPlayerPageSuspended = false;
  const lifecycleGeneration = ++bfPlayerLifecycleGeneration;
  bfRefreshPlayerRuntime().catch(() => {
    if (
      !bfPlayerPageSuspended &&
      lifecycleGeneration === bfPlayerLifecycleGeneration
    ) {
      const cachedSnapshot = bfPlayerBackgroundClient.getCachedState();
      bfApplyPlayerSnapshot(cachedSnapshot || {
        effectiveFeatureState: bfLatestPlayerFeatureState
      });
    }
  }).finally(() => {
    if (
      !bfPlayerPageSuspended &&
      lifecycleGeneration === bfPlayerLifecycleGeneration
    ) {
      bfSubscribePlayerRuntime();
    }
  });
}

window.addEventListener('pagehide', bfSuspendPlayerRuntime);
window.addEventListener('pageshow', bfResumePlayerRuntime);

function bfInitializePlayerRuntime() {
  const lifecycleGeneration = bfPlayerLifecycleGeneration;
  bfSubscribePlayerRuntime();
  bfRefreshPlayerRuntime().catch(() => {
    const cachedSnapshot = bfPlayerBackgroundClient.getCachedState();
    if (
      !bfPlayerPageSuspended &&
      lifecycleGeneration === bfPlayerLifecycleGeneration &&
      cachedSnapshot
    ) {
      bfApplyPlayerSnapshot(cachedSnapshot);
    }
  });
}

bfInitializePlayerRuntime();
