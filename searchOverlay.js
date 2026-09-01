const bfSearchBackgroundClient = globalThis.BiliFocusClient;

const bfSearchController = {
  active: false,
  observer: null,
  observerMode: 'none',
  resizeObserver: null,
  root: null,
  input: null,
  scrollHandler: null,
  resizeHandler: null,
  maskHideTimer: null,
  maskShowFrameId: null,
  updateFrameId: null,
  layoutRequested: false,
  mask: null
};

let bfSearchPageSuspended = false;
let bfLatestSearchFeatureState = {};
let bfSearchStateRequestId = 0;
let bfSearchUnsubscribe = null;
let bfSearchLifecycleGeneration = 0;

const BF_HEADER_HEIGHT = 64;
const BF_SHOW_THRESHOLD = 12;
const BF_ACTIVE_CLASS = 'bili-search-mask-active';
const BF_ENTRY_CLASS = 'bili-search-page-entry';
const BF_RESULTS_CLASS = 'bili-search-page-results';

function bfDetectSearchPageType() {
  const root = bfSearchController.root && bfSearchController.root.isConnected
    ? bfSearchController.root
    : null;
  const isEntry = Boolean(root && root.classList.contains('search-entry-page'));
  const isResults = Boolean(root && !isEntry && root.classList.contains('search-layout'));
  document.documentElement.classList.toggle(BF_ENTRY_CLASS, bfSearchController.active && isEntry);
  document.documentElement.classList.toggle(BF_RESULTS_CLASS, bfSearchController.active && isResults);
  return { isEntry, isResults };
}

function bfQuerySearchTarget() {
  const entryRoot = document.querySelector('.search-entry-page');
  const root = entryRoot || document.querySelector('.search-layout');
  const input = root?.querySelector('.search-input-wrap') ||
    document.querySelector('.search-input-wrap');
  return root && input ? { root, input } : null;
}

function bfDisconnectSearchObservers() {
  if (bfSearchController.observer) {
    bfSearchController.observer.disconnect();
    bfSearchController.observer = null;
  }
  if (bfSearchController.resizeObserver) {
    bfSearchController.resizeObserver.disconnect();
    bfSearchController.resizeObserver = null;
  }
  bfSearchController.observerMode = 'none';
}

function bfObserveSearchAncestorChildLists(observer, node, observedTargets = new Set()) {
  let current = node;
  while (current && current.parentNode) {
    const parent = current.parentNode;
    if (!observedTargets.has(parent)) {
      observer.observe(parent, { childList: true });
      observedTargets.add(parent);
    }
    current = parent;
  }
}

function bfObserveSearchTarget(target) {
  bfDisconnectSearchObservers();
  bfSearchController.root = target && target.root.isConnected ? target.root : null;
  bfSearchController.input = target && target.input.isConnected ? target.input : null;

  if (!bfSearchController.active || !document.body) return;

  if (!bfSearchController.root || !bfSearchController.input) {
    bfSearchController.root = null;
    bfSearchController.input = null;
    bfSearchController.observerMode = 'discovery';
    bfSearchController.observer = new MutationObserver(() => {
      if (!bfSearchController.active) return;
      bfSyncSearchTarget(true);
      bfScheduleSearchUpdate(true);
    });
    bfSearchController.observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    if (document.documentElement !== document.body) {
      bfSearchController.observer.observe(document.documentElement, { childList: true });
    }
    return;
  }

  const currentRoot = bfSearchController.root;
  const currentInput = bfSearchController.input;
  const resizeObserverAvailable = typeof ResizeObserver === 'function';
  bfSearchController.observerMode = 'target';
  bfSearchController.observer = new MutationObserver(() => {
    if (!bfSearchController.active) return;
    bfSyncSearchTarget(true);
    bfScheduleSearchUpdate(true);
  });
  const observedTargets = new Set([currentRoot]);
  bfSearchController.observer.observe(currentRoot, resizeObserverAvailable
    ? {
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    }
    : {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    });

  if (currentInput !== currentRoot) {
    bfSearchController.observer.observe(currentInput, resizeObserverAvailable
      ? {
        attributes: true,
        attributeFilter: ['class', 'style']
      }
      : {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style']
      });
    observedTargets.add(currentInput);
  }
  bfObserveSearchAncestorChildLists(
    bfSearchController.observer,
    currentRoot,
    observedTargets
  );
  bfObserveSearchAncestorChildLists(
    bfSearchController.observer,
    currentInput,
    observedTargets
  );

  if (resizeObserverAvailable) {
    bfSearchController.resizeObserver = new ResizeObserver(() => {
      if (!bfSearchController.active) return;
      if (!currentRoot.isConnected || !currentInput.isConnected) {
        bfSyncSearchTarget(true);
        bfScheduleSearchUpdate(true);
        return;
      }
      bfScheduleSearchUpdate(false);
    });
    bfSearchController.resizeObserver.observe(currentInput);
  }
}

function bfSyncSearchTarget(force = false) {
  if (
    !force &&
    bfSearchController.root &&
    bfSearchController.root.isConnected &&
    bfSearchController.input &&
    bfSearchController.input.isConnected
  ) {
    return {
      root: bfSearchController.root,
      input: bfSearchController.input
    };
  }

  const nextTarget = bfQuerySearchTarget();
  if (
    nextTarget &&
    nextTarget.root === bfSearchController.root &&
    nextTarget.input === bfSearchController.input
  ) {
    return nextTarget;
  }

  bfObserveSearchTarget(nextTarget);
  return nextTarget;
}

function bfEnsureLeftMask() {
  let mask = bfSearchController.mask;
  if (mask && mask.isConnected) return mask;

  mask = document.querySelector('#bili-header-mask-left');
  if (!mask) {
    mask = document.createElement('div');
    mask.id = 'bili-header-mask-left';
    document.body.appendChild(mask);
  }

  bfSearchController.mask = mask;
  return mask;
}

function bfRemoveLeftMask() {
  const mask = bfSearchController.mask || document.querySelector('#bili-header-mask-left');
  if (mask) {
    mask.remove();
  }
  bfSearchController.mask = null;
}

function bfUpdateMaskVisibility(pageType = null) {
  const mask = bfSearchController.mask || document.querySelector('#bili-header-mask-left');
  if (!mask || !bfSearchController.active) return;

  const target = bfSyncSearchTarget();
  const { isEntry, isResults } = pageType || bfDetectSearchPageType();
  const atTop = window.scrollY <= BF_SHOW_THRESHOLD;

  const inputWrap = target && target.input;
  let inputInHeaderBand = false;
  if (inputWrap) {
    const rect = inputWrap.getBoundingClientRect();
    inputInHeaderBand = rect.top >= -BF_SHOW_THRESHOLD && rect.top < BF_HEADER_HEIGHT + BF_SHOW_THRESHOLD;
  }

  const shouldShow = atTop && inputInHeaderBand && (isEntry || isResults);

  if (shouldShow) {
    if (bfSearchController.maskHideTimer !== null) {
      window.clearTimeout(bfSearchController.maskHideTimer);
      bfSearchController.maskHideTimer = null;
    }
    mask.style.display = 'block';
    if (mask.style.opacity === '1') return;
    if (bfSearchController.maskShowFrameId === null) {
      bfSearchController.maskShowFrameId = requestAnimationFrame(() => {
        bfSearchController.maskShowFrameId = null;
        if (bfSearchController.active && bfSearchController.mask === mask) {
          mask.style.opacity = '1';
        }
      });
    }
    return;
  }

  if (bfSearchController.maskShowFrameId !== null) {
    cancelAnimationFrame(bfSearchController.maskShowFrameId);
    bfSearchController.maskShowFrameId = null;
  }
  if (mask.style.display === 'none') return;
  mask.style.opacity = '0';
  if (bfSearchController.maskHideTimer === null) {
    bfSearchController.maskHideTimer = window.setTimeout(() => {
      bfSearchController.maskHideTimer = null;
      if (bfSearchController.active && bfSearchController.mask === mask) {
        mask.style.display = 'none';
      }
    }, 130);
  }
}

function bfApplySearchMaskLayout() {
  if (!bfSearchController.active || !document.body) return;

  document.documentElement.classList.add(BF_ACTIVE_CLASS);
  bfEnsureLeftMask();
  bfSyncSearchTarget(true);
  const pageType = bfDetectSearchPageType();
  bfUpdateMaskVisibility(pageType);
}

function bfScheduleSearchUpdate(fullLayout = false) {
  if (!bfSearchController.active) return;
  bfSearchController.layoutRequested = bfSearchController.layoutRequested || fullLayout;
  if (bfSearchController.updateFrameId !== null) return;

  bfSearchController.updateFrameId = requestAnimationFrame(() => {
    bfSearchController.updateFrameId = null;
    if (!bfSearchController.active) return;

    const shouldApplyLayout = bfSearchController.layoutRequested;
    bfSearchController.layoutRequested = false;
    if (shouldApplyLayout) {
      bfApplySearchMaskLayout();
    } else {
      bfUpdateMaskVisibility();
    }
  });
}

function bfStartSearchMask() {
  if (bfSearchController.active || bfSearchPageSuspended || !document.body) return;

  bfSearchController.active = true;
  bfObserveSearchTarget(bfQuerySearchTarget());
  bfScheduleSearchUpdate(true);

  bfSearchController.scrollHandler = () => bfScheduleSearchUpdate(false);
  bfSearchController.resizeHandler = () => bfScheduleSearchUpdate(false);
  window.addEventListener('scroll', bfSearchController.scrollHandler, { passive: true });
  window.addEventListener('resize', bfSearchController.resizeHandler);
}

function bfStopSearchMask() {
  bfSearchController.active = false;
  bfSearchController.layoutRequested = false;

  if (bfSearchController.updateFrameId !== null) {
    cancelAnimationFrame(bfSearchController.updateFrameId);
    bfSearchController.updateFrameId = null;
  }

  if (bfSearchController.maskShowFrameId !== null) {
    cancelAnimationFrame(bfSearchController.maskShowFrameId);
    bfSearchController.maskShowFrameId = null;
  }

  bfDisconnectSearchObservers();
  bfSearchController.root = null;
  bfSearchController.input = null;

  if (bfSearchController.scrollHandler) {
    window.removeEventListener('scroll', bfSearchController.scrollHandler);
    bfSearchController.scrollHandler = null;
  }

  if (bfSearchController.resizeHandler) {
    window.removeEventListener('resize', bfSearchController.resizeHandler);
    bfSearchController.resizeHandler = null;
  }

  if (bfSearchController.maskHideTimer !== null) {
    window.clearTimeout(bfSearchController.maskHideTimer);
    bfSearchController.maskHideTimer = null;
  }

  document.documentElement.classList.remove(
    BF_ACTIVE_CLASS,
    BF_ENTRY_CLASS,
    BF_RESULTS_CLASS
  );
  bfRemoveLeftMask();
}

function bfApplySearchFeatureState(featureState) {
  bfLatestSearchFeatureState = featureState || {};
  if (bfSearchPageSuspended) {
    bfStopSearchMask();
    return;
  }

  const enabled = !featureState || featureState.searchMaskEnabled !== false;

  if (enabled) {
    bfStartSearchMask();
  } else {
    bfStopSearchMask();
  }
}

function bfApplySearchSnapshot(snapshot) {
  const featureState = snapshot && snapshot.effectiveFeatureState || {};
  bfApplySearchFeatureState(featureState);
}

function bfSubscribeSearchRuntime() {
  if (bfSearchUnsubscribe) return;

  bfSearchUnsubscribe = bfSearchBackgroundClient.subscribe((snapshot) => {
    bfSearchStateRequestId += 1;
    bfApplySearchSnapshot(snapshot);
  });
}

function bfUnsubscribeSearchRuntime() {
  if (!bfSearchUnsubscribe) return;
  bfSearchUnsubscribe();
  bfSearchUnsubscribe = null;
}

async function bfRefreshSearchRuntime() {
  const requestId = ++bfSearchStateRequestId;
  const snapshot = await bfSearchBackgroundClient.getState({ refresh: true });

  if (requestId !== bfSearchStateRequestId || bfSearchPageSuspended) return;
  bfApplySearchSnapshot(snapshot);
}

function bfSuspendSearchRuntime() {
  bfSearchPageSuspended = true;
  bfSearchLifecycleGeneration += 1;
  bfSearchStateRequestId += 1;
  bfUnsubscribeSearchRuntime();
  bfStopSearchMask();
}

function bfResumeSearchRuntime() {
  if (!bfSearchPageSuspended) return;
  bfSearchPageSuspended = false;
  const lifecycleGeneration = ++bfSearchLifecycleGeneration;
  bfRefreshSearchRuntime().catch(() => {
    if (
      !bfSearchPageSuspended &&
      lifecycleGeneration === bfSearchLifecycleGeneration
    ) {
      const cachedSnapshot = bfSearchBackgroundClient.getCachedState();
      bfApplySearchSnapshot(cachedSnapshot || {
        effectiveFeatureState: bfLatestSearchFeatureState
      });
    }
  }).finally(() => {
    if (
      !bfSearchPageSuspended &&
      lifecycleGeneration === bfSearchLifecycleGeneration
    ) {
      bfSubscribeSearchRuntime();
    }
  });
}

window.addEventListener('pagehide', bfSuspendSearchRuntime);
window.addEventListener('pageshow', bfResumeSearchRuntime);

function bfInitializeSearchRuntime() {
  const lifecycleGeneration = bfSearchLifecycleGeneration;
  bfSubscribeSearchRuntime();
  bfRefreshSearchRuntime().catch(() => {
    const cachedSnapshot = bfSearchBackgroundClient.getCachedState();
    if (
      !bfSearchPageSuspended &&
      lifecycleGeneration === bfSearchLifecycleGeneration &&
      cachedSnapshot
    ) {
      bfApplySearchSnapshot(cachedSnapshot);
    }
  });
}

bfInitializeSearchRuntime();
