const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const PLAYER_SOURCE = fs.readFileSync(path.join(ROOT, 'playerOverlay.js'), 'utf8');
const SEARCH_SOURCE = fs.readFileSync(path.join(ROOT, 'searchOverlay.js'), 'utf8');
const BLOCKED_SOURCE = fs.readFileSync(path.join(ROOT, 'blocked.js'), 'utf8');

function toCssProperty(property) {
  return String(property).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

class FakeStyle {
  constructor() {
    this._values = new Map();
    this._priorities = new Map();
  }

  setProperty(property, value, priority = '') {
    const name = String(property);
    const normalizedValue = String(value);
    if (!normalizedValue) {
      this.removeProperty(name);
      return;
    }
    this._values.set(name, normalizedValue);
    this._priorities.set(name, String(priority));
  }

  getPropertyValue(property) {
    return this._values.get(String(property)) || '';
  }

  getPropertyPriority(property) {
    return this._priorities.get(String(property)) || '';
  }

  removeProperty(property) {
    const name = String(property);
    const previous = this.getPropertyValue(name);
    this._values.delete(name);
    this._priorities.delete(name);
    return previous;
  }

  get length() {
    return this._values.size;
  }

  item(index) {
    return Array.from(this._values.keys())[index] || '';
  }

  get cssText() {
    return Array.from(this._values, ([property, value]) => {
      const priority = this.getPropertyPriority(property);
      return `${property}: ${value}${priority ? ` !${priority}` : ''};`;
    }).join(' ');
  }
}

function createStyle() {
  const target = new FakeStyle();
  return new Proxy(target, {
    get(style, property, receiver) {
      if (typeof property === 'symbol' || property in style) {
        return Reflect.get(style, property, receiver);
      }
      return style.getPropertyValue(toCssProperty(property));
    },
    set(style, property, value, receiver) {
      if (typeof property === 'symbol' || property in style || String(property).startsWith('_')) {
        return Reflect.set(style, property, value, receiver);
      }
      style.setProperty(toCssProperty(property), value);
      return true;
    }
  });
}

class FakeClassList {
  constructor(element) {
    this.element = element;
    this.values = new Set();
  }

  add(...tokens) {
    tokens.forEach((token) => this.values.add(token));
  }

  remove(...tokens) {
    tokens.forEach((token) => this.values.delete(token));
  }

  contains(token) {
    return this.values.has(token);
  }

  toggle(token, force) {
    const enabled = force === undefined ? !this.contains(token) : Boolean(force);
    if (enabled) this.add(token);
    else this.remove(token);
    return enabled;
  }

  replaceFromString(value) {
    this.values = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  toString() {
    return Array.from(this.values).join(' ');
  }
}

function matchesSimpleSelector(element, selector) {
  if (selector.startsWith('.')) return element.classList.contains(selector.slice(1));
  if (selector.startsWith('#')) return element.id === selector.slice(1);
  return element.tagName.toLowerCase() === selector.toLowerCase();
}

function matchesSelector(element, selector) {
  const parts = selector.trim().split(/\s+/);
  let current = element;

  if (!matchesSimpleSelector(current, parts.pop())) return false;
  while (parts.length) {
    const expected = parts.pop();
    current = current.parentNode;
    while (current && !matchesSimpleSelector(current, expected)) {
      current = current.parentNode;
    }
    if (!current) return false;
  }
  return true;
}

function descendantsOf(element) {
  const result = [];
  const visit = (node) => {
    node.children.forEach((child) => {
      result.push(child);
      visit(child);
    });
  };
  visit(element);
  return result;
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.parentNode = null;
    this.children = [];
    this.style = createStyle();
    this.classList = new FakeClassList(this);
    this.id = '';
    this.textContent = '';
    this.clickCount = 0;
    this._documentRoot = false;
    this._rect = {
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0
    };
    this.computedStyle = {
      borderTopLeftRadius: '0px',
      borderTopRightRadius: '0px',
      borderBottomLeftRadius: '0px',
      borderBottomRightRadius: '0px'
    };
  }

  get className() {
    return this.classList.toString();
  }

  set className(value) {
    this.classList.replaceFromString(value);
  }

  get isConnected() {
    let current = this;
    while (current) {
      if (current._documentRoot) return true;
      current = current.parentNode;
    }
    return false;
  }

  appendChild(child) {
    if (child.parentNode) {
      child.parentNode.children = child.parentNode.children.filter((entry) => entry !== child);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((entry) => entry !== this);
    this.parentNode = null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    return descendantsOf(this).filter((element) => matchesSelector(element, selector));
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (matchesSelector(current, selector)) return current;
      current = current.parentNode;
    }
    return null;
  }

  setRect(rect) {
    this._rect = { ...this._rect, ...rect };
  }

  getBoundingClientRect() {
    return { ...this._rect };
  }

  click() {
    this.clickCount += 1;
  }
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement('html');
    this.documentElement._documentRoot = true;
    this.head = new FakeElement('head');
    this.body = new FakeElement('body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  getElementById(id) {
    return this.querySelector(`#${id}`);
  }

  querySelector(selector) {
    if (matchesSelector(this.documentElement, selector)) return this.documentElement;
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector) {
    const results = this.documentElement.querySelectorAll(selector);
    if (matchesSelector(this.documentElement, selector)) results.unshift(this.documentElement);
    return results;
  }
}

function createEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) {
        listener(event);
      }
    },
    listenerCount(type) {
      return listeners.get(type)?.size || 0;
    }
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createAnimationFrameScheduler() {
  let nextId = 1;
  const callbacks = new Map();

  return {
    request(callback) {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    },
    cancel(id) {
      callbacks.delete(id);
    },
    pendingCount() {
      return callbacks.size;
    },
    flushFrame() {
      const frame = Array.from(callbacks.entries());
      frame.forEach(([id]) => callbacks.delete(id));
      frame.forEach(([, callback]) => callback());
      return frame.length;
    },
    flushAll() {
      let executed = 0;
      for (let frame = 0; callbacks.size && frame < 20; frame += 1) {
        executed += this.flushFrame();
      }
      assert.equal(callbacks.size, 0, 'animation frame queue did not settle');
      return executed;
    }
  };
}

function createTimerScheduler() {
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();

  return {
    setTimeout(callback) {
      const id = nextId;
      nextId += 1;
      timeouts.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    setInterval(callback) {
      const id = nextId;
      nextId += 1;
      intervals.set(id, callback);
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    fireTimeout(id) {
      const callback = timeouts.get(id);
      if (!callback) return false;
      timeouts.delete(id);
      callback();
      return true;
    },
    fireAllTimeouts() {
      for (const id of Array.from(timeouts.keys())) {
        this.fireTimeout(id);
      }
    },
    fireInterval(id) {
      const callback = intervals.get(id);
      if (!callback) return false;
      callback();
      return true;
    },
    timeoutCount() {
      return timeouts.size;
    },
    intervalCount() {
      return intervals.size;
    }
  };
}

function createMutationObserverHarness() {
  const observers = [];

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.connected = false;
      this.observations = new Map();
      observers.push(this);
    }

    observe(target, options = {}) {
      this.connected = true;
      this.observations.set(target, { ...options });
    }

    disconnect() {
      this.connected = false;
      this.observations.clear();
    }
  }

  function observationMatchesTarget(observationTarget, options, target) {
    if (observationTarget === target) return true;
    if (!options.subtree) return false;
    let current = target && target.parentNode;
    while (current) {
      if (current === observationTarget) return true;
      current = current.parentNode;
    }
    return false;
  }

  function observationAcceptsRecord(options, record) {
    if (record.type === 'attributes') {
      if (!options.attributes) return false;
      return !record.attributeName ||
        !options.attributeFilter ||
        options.attributeFilter.includes(record.attributeName);
    }
    if (record.type === 'childList') return options.childList === true;
    return false;
  }

  return {
    FakeMutationObserver,
    trigger(times = 1, records = []) {
      for (let index = 0; index < times; index += 1) {
        observers
          .filter((observer) => observer.connected)
          .forEach((observer) => observer.callback(records, observer));
      }
    },
    triggerFor(target, record = { type: 'childList', target }) {
      observers
        .filter((observer) => observer.connected)
        .filter((observer) => Array.from(observer.observations).some(
          ([observationTarget, options]) =>
            observationMatchesTarget(observationTarget, options, target) &&
            observationAcceptsRecord(options, record)
        ))
        .forEach((observer) => observer.callback([record], observer));
    },
    hasObservation(target, predicate = () => true) {
      return observers
        .filter((observer) => observer.connected)
        .some((observer) => {
          const options = observer.observations.get(target);
          return Boolean(options && predicate(options));
        });
    },
    connectedCount() {
      return observers.filter((observer) => observer.connected).length;
    }
  };
}

function createResizeObserverHarness() {
  const observers = [];

  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      observers.push(this);
    }

    observe(target) {
      this.targets.add(target);
    }

    unobserve(target) {
      this.targets.delete(target);
    }

    disconnect() {
      this.targets.clear();
    }
  }

  return {
    FakeResizeObserver,
    trigger(target) {
      observers
        .filter((observer) => observer.targets.has(target))
        .forEach((observer) => observer.callback([{ target }], observer));
    },
    isObserving(target) {
      return observers.some((observer) => observer.targets.has(target));
    },
    connectedCount() {
      return observers.filter((observer) => observer.targets.size > 0).length;
    }
  };
}

function createBackgroundClient(featureState) {
  const subscribers = new Set();
  let currentFeatureState = { ...featureState };
  let latestSnapshot = null;
  const getStateCalls = [];

  function createSnapshot() {
    return {
      effectiveFeatureState: { ...currentFeatureState }
    };
  }

  function publish(snapshot) {
    latestSnapshot = snapshot;
    subscribers.forEach((listener) => listener(snapshot));
  }

  return {
    async getState(options = {}) {
      getStateCalls.push({ ...options });
      const snapshot = createSnapshot();
      publish(snapshot);
      return snapshot;
    },
    getCachedState() {
      return latestSnapshot;
    },
    subscribe(listener) {
      subscribers.add(listener);
      if (latestSnapshot) listener(latestSnapshot);
      return () => subscribers.delete(listener);
    },
    setFeatureState(nextFeatureState, emitChange = true) {
      currentFeatureState = { ...nextFeatureState };
      if (emitChange) {
        publish(createSnapshot());
      }
    },
    publishSnapshot(snapshot) {
      publish({
        effectiveFeatureState: { ...(snapshot.effectiveFeatureState || {}) }
      });
    },
    getStateCalls,
    subscriberCount() {
      return subscribers.size;
    }
  };
}

async function createOverlayHarness(
  source,
  featureState,
  { resizeObserverAvailable = true } = {}
) {
  const document = new FakeDocument();
  const events = createEventTarget();
  const raf = createAnimationFrameScheduler();
  const timers = createTimerScheduler();
  const mutations = createMutationObserverHarness();
  const resizes = createResizeObserverHarness();
  const client = createBackgroundClient(featureState);
  let computedStyleReadCount = 0;
  const window = {
    innerWidth: 1280,
    innerHeight: 720,
    scrollY: 0,
    addEventListener: events.addEventListener,
    removeEventListener: events.removeEventListener,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval
  };

  const contextValues = {
    console,
    document,
    window,
    BiliFocusClient: client,
    MutationObserver: mutations.FakeMutationObserver,
    requestAnimationFrame: raf.request,
    cancelAnimationFrame: raf.cancel,
    getComputedStyle(element) {
      computedStyleReadCount += 1;
      return element.computedStyle;
    }
  };
  if (resizeObserverAvailable) {
    contextValues.ResizeObserver = resizes.FakeResizeObserver;
  }
  const context = vm.createContext(contextValues);

  vm.runInContext(source, context);
  await new Promise((resolve) => setImmediate(resolve));

  return {
    client,
    context,
    document,
    events,
    mutations,
    raf,
    resizes,
    timers,
    window,
    computedStyleReadCount() {
      return computedStyleReadCount;
    },
    async settle() {
      await new Promise((resolve) => setImmediate(resolve));
    },
    run(expression) {
      return vm.runInContext(expression, context);
    }
  };
}

function createBlockedClient(initialSnapshot) {
  const subscribers = new Set();
  const getStateCalls = [];
  let latestSnapshot = null;
  let currentSnapshot = initialSnapshot;
  let resumeCount = 0;

  function cloneSnapshot(snapshot) {
    return {
      effectiveFeatureState: { ...snapshot.effectiveFeatureState },
      lockStatus: {
        ...snapshot.lockStatus,
        restrictionReasons: [...(snapshot.lockStatus.restrictionReasons || [])],
        reasons: [...(snapshot.lockStatus.reasons || [])]
      }
    };
  }

  function publish(snapshot) {
    latestSnapshot = snapshot;
    subscribers.forEach((listener) => listener(snapshot));
  }

  return {
    async getState(options = {}) {
      getStateCalls.push({ ...options });
      const snapshot = cloneSnapshot(currentSnapshot);
      publish(snapshot);
      return snapshot;
    },
    getCachedState() {
      return latestSnapshot;
    },
    subscribe(listener) {
      subscribers.add(listener);
      if (latestSnapshot) listener(latestSnapshot);
      return () => subscribers.delete(listener);
    },
    async resumeBlockedTab() {
      resumeCount += 1;
      return { resumed: true };
    },
    setSnapshot(snapshot, emitChange = true) {
      currentSnapshot = snapshot;
      if (emitChange) publish(cloneSnapshot(currentSnapshot));
    },
    getStateCalls,
    subscriberCount() {
      return subscribers.size;
    },
    resumeCount() {
      return resumeCount;
    }
  };
}

async function createBlockedHarness(initialSnapshot) {
  const document = new FakeDocument();
  [
    'blockedSubtitle',
    'blockedReasons',
    'blockedUntil',
    'blockedMode',
    'blockedError'
  ].forEach((id) => {
    const element = document.createElement('p');
    element.id = id;
    document.body.appendChild(element);
  });

  const events = createEventTarget();
  const timers = createTimerScheduler();
  const client = createBlockedClient(initialSnapshot);
  const window = {
    addEventListener: events.addEventListener,
    removeEventListener: events.removeEventListener,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval
  };
  const shared = {
    ensureEffectiveFeatureState(state) {
      return {
        siteBlockEnabled: Boolean(state && state.siteBlockEnabled)
      };
    },
    ensureLockStatus(lockStatus) {
      return {
        restrictionReasons: [],
        reasons: [],
        nextUnlockAt: null,
        enforced: false,
        strictModeEnabled: false,
        ...(lockStatus || {})
      };
    },
    formatDateTime(value) {
      return `time:${value}`;
    },
    getLockReasonsSummary(reasons) {
      return reasons.join('、');
    }
  };
  const context = vm.createContext({
    console,
    document,
    window,
    BiliFocusClient: client,
    BiliFocusShared: shared
  });

  vm.runInContext(BLOCKED_SOURCE, context);
  await new Promise((resolve) => setImmediate(resolve));

  return {
    client,
    context,
    document,
    events,
    timers,
    async settle() {
      await new Promise((resolve) => setImmediate(resolve));
    },
    run(expression) {
      return vm.runInContext(expression, context);
    }
  };
}

function appendAutoPlaySwitch(document) {
  const container = document.createElement('div');
  container.className = 'continuous-btn';
  const label = document.createElement('span');
  label.className = 'txt';
  label.textContent = '自动连播';
  const switchButton = document.createElement('button');
  switchButton.className = 'switch-btn on';
  container.appendChild(label);
  container.appendChild(switchButton);
  document.body.appendChild(container);
  return switchButton;
}

function appendSearchPage(document) {
  const entry = document.createElement('main');
  entry.className = 'search-entry-page';
  const center = document.createElement('section');
  center.className = 'search-center';
  const input = document.createElement('div');
  input.className = 'search-input-wrap';
  input.setRect({
    top: 20,
    left: 300,
    right: 940,
    bottom: 60,
    width: 640,
    height: 40
  });
  center.appendChild(input);
  entry.appendChild(center);
  document.body.appendChild(entry);
  return { entry, center, input };
}

function appendSearchResultsPage(document) {
  const root = document.createElement('main');
  root.className = 'search-layout';
  const inputHost = document.createElement('section');
  inputHost.className = 'search-header';
  const input = document.createElement('div');
  input.className = 'search-input-wrap';
  input.setRect({
    top: 16,
    left: 280,
    right: 920,
    bottom: 56,
    width: 640,
    height: 40
  });
  inputHost.appendChild(input);
  root.appendChild(inputHost);
  document.body.appendChild(root);
  return { root, inputHost, input };
}
test('player recommendations style hides the complete sidebar and mounts idempotently', async () => {
  const harness = await createOverlayHarness(PLAYER_SOURCE, {
    playerMaskEnabled: false,
    autoPlayOffEnabled: false
  });
  const recommendations = harness.document.createElement('aside');
  recommendations.className = 'recommend-list-v1';
  harness.document.body.appendChild(recommendations);

  assert.equal(
    harness.document.getElementById('bili-hide-player-recommendations-style'),
    null
  );

  harness.run('bfStartPlayerRecommendations()');
  const firstStyle = harness.document.getElementById(
    'bili-hide-player-recommendations-style'
  );

  assert.ok(firstStyle);
  assert.match(
    firstStyle.textContent,
    /\.recommend-list-v1\s*\{[^}]*display:\s*none\s*!important;/s
  );
  assert.equal(harness.run('bfPlayerRecommendationsController.active'), true);
  assert.equal(
    harness.document.querySelectorAll('#bili-hide-player-recommendations-style').length,
    1
  );
  assert.equal(harness.mutations.connectedCount(), 0);
  assert.equal(harness.resizes.connectedCount(), 0);
  assert.equal(harness.events.listenerCount('wheel'), 0);
  assert.equal(harness.events.listenerCount('touchmove'), 0);
  assert.equal(harness.document.body.style.getPropertyValue('overflow'), '');

  firstStyle.remove();
  harness.run('bfStartPlayerRecommendations()');

  assert.equal(firstStyle.isConnected, true);
  assert.equal(
    harness.document.querySelectorAll('#bili-hide-player-recommendations-style').length,
    1
  );

  harness.run('bfStopPlayerRecommendations()');
  assert.equal(
    harness.document.getElementById('bili-hide-player-recommendations-style'),
    null
  );
});

test('player recommendations and autoplay protection remain independently switchable', async () => {
  const harness = await createOverlayHarness(PLAYER_SOURCE, {
    playerMaskEnabled: false,
    autoPlayOffEnabled: false
  });
  const switchButton = appendAutoPlaySwitch(harness.document);

  harness.client.setFeatureState({
    playerMaskEnabled: true,
    autoPlayOffEnabled: false
  });

  assert.ok(harness.document.getElementById('bili-hide-player-recommendations-style'));
  assert.equal(harness.document.getElementById('bili-hide-ending-related-style'), null);
  assert.equal(harness.run('bfPlayerRecommendationsController.active'), true);
  assert.equal(harness.run('bfAutoPlayController.active'), false);
  assert.equal(harness.timers.intervalCount(), 0);
  assert.equal(harness.timers.timeoutCount(), 0);

  harness.client.setFeatureState({
    playerMaskEnabled: false,
    autoPlayOffEnabled: true
  });

  assert.equal(
    harness.document.getElementById('bili-hide-player-recommendations-style'),
    null
  );
  assert.ok(harness.document.getElementById('bili-hide-ending-related-style'));
  assert.equal(harness.run('bfPlayerRecommendationsController.active'), false);
  assert.equal(harness.run('bfAutoPlayController.active'), true);
  assert.equal(harness.timers.intervalCount(), 1);
  assert.equal(harness.timers.timeoutCount(), 1);

  harness.raf.flushAll();
  assert.equal(switchButton.clickCount, 1);

  harness.client.setFeatureState({
    playerMaskEnabled: false,
    autoPlayOffEnabled: false
  });
  assert.equal(harness.document.getElementById('bili-hide-ending-related-style'), null);
});
test('stopping autoplay protection cancels a queued frame before it can click', async () => {
  const harness = await createOverlayHarness(PLAYER_SOURCE, {
    playerMaskEnabled: false,
    autoPlayOffEnabled: false
  });
  const switchButton = appendAutoPlaySwitch(harness.document);

  harness.run('bfStartAutoPlayController()');
  assert.equal(harness.raf.pendingCount(), 1);
  assert.equal(harness.timers.intervalCount(), 1);
  assert.equal(harness.timers.timeoutCount(), 1);

  harness.run('bfStopAutoPlayController()');
  assert.equal(harness.raf.pendingCount(), 0);
  assert.equal(harness.timers.intervalCount(), 0);
  assert.equal(harness.timers.timeoutCount(), 0);
  assert.equal(harness.mutations.connectedCount(), 0);
  harness.raf.flushAll();
  assert.equal(switchButton.clickCount, 0);
});

test('autoplay polling timeout retires its interval and clears its own handle', async () => {
  const harness = await createOverlayHarness(PLAYER_SOURCE, {
    playerMaskEnabled: false,
    autoPlayOffEnabled: false
  });

  harness.run('bfStartAutoPlayController()');
  const timeoutId = harness.run('bfAutoPlayController.timeoutId');
  assert.equal(harness.timers.fireTimeout(timeoutId), true);
  assert.equal(harness.timers.intervalCount(), 0);
  assert.equal(harness.run('bfAutoPlayController.timeoutId'), null);
  harness.run('bfStopAutoPlayController()');
});

test('autoplay switches from body discovery to a narrow target observer and rebinds', async () => {
  const harness = await createOverlayHarness(PLAYER_SOURCE, {
    playerMaskEnabled: false,
    autoPlayOffEnabled: false
  });
  const firstSwitch = appendAutoPlaySwitch(harness.document);
  const firstRoot = firstSwitch.parentNode;
  const shell = harness.document.createElement('section');
  const firstHost = harness.document.createElement('div');
  firstHost.appendChild(firstRoot);
  shell.appendChild(firstHost);
  harness.document.body.appendChild(shell);

  harness.run('bfStartAutoPlayController()');
  assert.equal(harness.run('bfAutoPlayController.observerMode'), 'target');
  assert.equal(harness.run('bfAutoPlayController.root') === firstRoot, true);
  assert.equal(
    harness.mutations.hasObservation(harness.document.body, (options) => options.subtree === true),
    false
  );

  firstHost.remove();
  const replacementHost = harness.document.createElement('div');
  shell.appendChild(replacementHost);
  const replacementSwitch = appendAutoPlaySwitch(harness.document);
  const replacementRoot = replacementSwitch.parentNode;
  replacementHost.appendChild(replacementRoot);
  harness.mutations.triggerFor(shell);
  harness.raf.flushAll();

  assert.equal(harness.run('bfAutoPlayController.root') === replacementRoot, true);
  assert.equal(harness.run('bfAutoPlayController.switchButton') === replacementSwitch, true);
  harness.run('bfStopAutoPlayController()');
});

test('player pagehide tears down controllers and pageshow reloads current feature state', async () => {
  const harness = await createOverlayHarness(PLAYER_SOURCE, {
    playerMaskEnabled: false,
    autoPlayOffEnabled: false
  });
  appendAutoPlaySwitch(harness.document);
  harness.client.setFeatureState({
    playerMaskEnabled: true,
    autoPlayOffEnabled: true
  });
  harness.raf.flushAll();

  assert.equal(harness.run('bfPlayerRecommendationsController.active'), true);
  assert.equal(harness.run('bfAutoPlayController.active'), true);
  assert.equal(harness.client.subscriberCount(), 1);
  harness.events.dispatch('pagehide', { persisted: true });
  assert.equal(harness.run('bfPlayerRecommendationsController.active'), false);
  assert.equal(harness.run('bfAutoPlayController.active'), false);
  assert.equal(
    harness.document.getElementById('bili-hide-player-recommendations-style'),
    null
  );
  assert.equal(harness.document.getElementById('bili-hide-ending-related-style'), null);
  assert.equal(harness.mutations.connectedCount(), 0);
  assert.equal(harness.resizes.connectedCount(), 0);
  assert.equal(harness.events.listenerCount('wheel'), 0);
  assert.equal(harness.events.listenerCount('touchmove'), 0);
  assert.equal(harness.raf.pendingCount(), 0);
  assert.equal(harness.timers.intervalCount(), 0);
  assert.equal(harness.timers.timeoutCount(), 0);
  assert.equal(harness.client.subscriberCount(), 0);

  const callsBeforeRestore = harness.client.getStateCalls.length;
  harness.client.setFeatureState({
    playerMaskEnabled: true,
    autoPlayOffEnabled: false
  }, false);
  harness.events.dispatch('pageshow', { persisted: true });
  await harness.settle();
  harness.raf.flushAll();

  assert.equal(harness.run('bfPlayerRecommendationsController.active'), true);
  assert.equal(harness.run('bfAutoPlayController.active'), false);
  assert.ok(harness.document.getElementById('bili-hide-player-recommendations-style'));
  assert.equal(harness.client.getStateCalls.length, callsBeforeRestore + 1);
  assert.equal(harness.client.subscriberCount(), 1);
  harness.run('bfStopPlayerRecommendations()');
});

test('an older player BFCache resume cannot subscribe over a newer restore cycle', async () => {
  const harness = await createOverlayHarness(PLAYER_SOURCE, {
    playerMaskEnabled: false,
    autoPlayOffEnabled: false
  });
  const deferredCalls = [];
  harness.client.getState = () => {
    const deferred = createDeferred();
    deferredCalls.push(deferred);
    return deferred.promise.then((snapshot) => {
      harness.client.publishSnapshot(snapshot);
      return snapshot;
    });
  };

  harness.events.dispatch('pagehide', { persisted: true });
  harness.events.dispatch('pageshow', { persisted: true });
  assert.equal(deferredCalls.length, 1);

  harness.events.dispatch('pagehide', { persisted: true });
  harness.events.dispatch('pageshow', { persisted: true });
  assert.equal(deferredCalls.length, 2);

  deferredCalls[0].reject(new Error('stale restore failed'));
  await harness.settle();
  assert.equal(harness.client.subscriberCount(), 0);
  assert.equal(deferredCalls.length, 2);

  deferredCalls[1].resolve({
    effectiveFeatureState: {
      playerMaskEnabled: true,
      autoPlayOffEnabled: false
    }
  });
  await harness.settle();
  harness.raf.flushAll();

  assert.equal(harness.run('bfPlayerRecommendationsController.active'), true);
  assert.equal(harness.run('bfAutoPlayController.active'), false);
  assert.ok(harness.document.getElementById('bili-hide-player-recommendations-style'));
  assert.equal(harness.client.subscriberCount(), 1);
  harness.events.dispatch('pagehide', { persisted: false });
});

test('blocked pagehide pauses countdown work and every pageshow restarts with fresh state', async () => {
  const firstUnlockAt = Date.now() + 120000;
  const harness = await createBlockedHarness({
    effectiveFeatureState: { siteBlockEnabled: true },
    lockStatus: {
      restrictionReasons: ['focus_session'],
      reasons: [],
      nextUnlockAt: firstUnlockAt,
      enforced: true,
      strictModeEnabled: true
    }
  });

  assert.equal(harness.timers.intervalCount(), 1);
  assert.equal(harness.client.subscriberCount(), 1);
  const firstTimerId = harness.run('remainingTimerId');
  assert.ok(firstTimerId);

  harness.events.dispatch('pagehide', { persisted: true });
  assert.equal(harness.run('remainingTimerId'), null);
  assert.equal(harness.timers.intervalCount(), 0);
  assert.equal(harness.client.subscriberCount(), 0);

  const secondUnlockAt = Date.now() + 240000;
  harness.client.setSnapshot({
    effectiveFeatureState: { siteBlockEnabled: true },
    lockStatus: {
      restrictionReasons: ['scheduled_window'],
      reasons: [],
      nextUnlockAt: secondUnlockAt,
      enforced: true,
      strictModeEnabled: false
    }
  }, false);
  const callsBeforeFirstRestore = harness.client.getStateCalls.length;
  harness.events.dispatch('pageshow', { persisted: true });
  assert.equal(harness.timers.intervalCount(), 1);
  await harness.settle();

  assert.equal(harness.client.getStateCalls.length, callsBeforeFirstRestore + 1);
  assert.equal(harness.client.subscriberCount(), 1);
  assert.equal(harness.run('latestLockStatus.nextUnlockAt'), secondUnlockAt);
  assert.notEqual(harness.run('remainingTimerId'), firstTimerId);
  assert.match(
    harness.document.getElementById('blockedUntil').textContent,
    new RegExp(`time:${secondUnlockAt}`)
  );
  assert.equal(harness.timers.fireInterval(harness.run('remainingTimerId')), true);

  harness.events.dispatch('pagehide', { persisted: true });
  assert.equal(harness.timers.intervalCount(), 0);
  const callsBeforeSecondRestore = harness.client.getStateCalls.length;
  harness.events.dispatch('pageshow', { persisted: true });
  await harness.settle();
  assert.equal(harness.client.getStateCalls.length, callsBeforeSecondRestore + 1);
  assert.equal(harness.timers.intervalCount(), 1);
  assert.equal(harness.client.subscriberCount(), 1);

  harness.events.dispatch('pagehide', { persisted: false });
  assert.equal(harness.timers.intervalCount(), 0);
  assert.equal(harness.client.subscriberCount(), 0);
});

test('search mask coalesces a mutation burst into one full-layout update', async () => {
  const harness = await createOverlayHarness(SEARCH_SOURCE, {
    searchMaskEnabled: false
  });
  appendSearchPage(harness.document);
  harness.run('bfStartSearchMask()');
  harness.raf.flushAll();
  harness.run(`
    globalThis.__searchLayoutUpdates = 0;
    globalThis.__originalSearchLayoutUpdate = bfApplySearchMaskLayout;
    bfApplySearchMaskLayout = function (...args) {
      globalThis.__searchLayoutUpdates += 1;
      return globalThis.__originalSearchLayoutUpdate(...args);
    };
  `);

  harness.mutations.trigger(12);

  assert.equal(harness.raf.pendingCount(), 1);
  assert.equal(harness.raf.flushFrame(), 1);
  assert.equal(harness.run('globalThis.__searchLayoutUpdates'), 1);
  assert.equal(harness.raf.pendingCount(), 0);
  harness.run('bfStopSearchMask()');
});

test('search mask narrows observation and rebinds its root and input after replacement', async () => {
  const harness = await createOverlayHarness(SEARCH_SOURCE, {
    searchMaskEnabled: false
  });
  const entryPage = appendSearchPage(harness.document);
  const shell = harness.document.createElement('section');
  const entryHost = harness.document.createElement('div');
  entryHost.appendChild(entryPage.entry);
  shell.appendChild(entryHost);
  harness.document.body.appendChild(shell);
  harness.run('bfStartSearchMask()');
  harness.raf.flushAll();

  assert.equal(harness.run('bfSearchController.observerMode'), 'target');
  assert.equal(harness.resizes.isObserving(entryPage.input), true);
  assert.equal(
    harness.mutations.hasObservation(harness.document.body, (options) => options.subtree === true),
    false
  );

  entryHost.remove();
  const resultsHost = harness.document.createElement('div');
  shell.appendChild(resultsHost);
  const resultsPage = appendSearchResultsPage(harness.document);
  resultsHost.appendChild(resultsPage.root);
  harness.mutations.triggerFor(shell);
  harness.raf.flushAll();

  assert.equal(harness.run('bfSearchController.root') === resultsPage.root, true);
  assert.equal(harness.run('bfSearchController.input') === resultsPage.input, true);
  assert.equal(harness.resizes.isObserving(entryPage.input), false);
  assert.equal(harness.resizes.isObserving(resultsPage.input), true);
  assert.equal(
    harness.document.documentElement.classList.contains('bili-search-page-results'),
    true
  );
  harness.run('bfStopSearchMask()');
});

test('search discovery and target fallback work without ResizeObserver', async () => {
  const harness = await createOverlayHarness(
    SEARCH_SOURCE,
    { searchMaskEnabled: false },
    { resizeObserverAvailable: false }
  );

  harness.run('bfStartSearchMask()');
  assert.equal(harness.run('bfSearchController.observerMode'), 'discovery');
  assert.equal(
    harness.mutations.hasObservation(harness.document.body, (options) => options.subtree === true),
    true
  );

  const page = appendSearchPage(harness.document);
  harness.mutations.triggerFor(harness.document.body);
  harness.raf.flushAll();

  assert.equal(harness.run('bfSearchController.observerMode'), 'target');
  assert.equal(
    harness.mutations.hasObservation(page.entry, (options) => options.subtree === true),
    true
  );
  assert.equal(harness.resizes.connectedCount(), 0);
  harness.run('bfStopSearchMask()');
});

test('search pagehide stops DOM work and pageshow reapplies the latest stored state', async () => {
  const harness = await createOverlayHarness(SEARCH_SOURCE, {
    searchMaskEnabled: false
  });
  appendSearchPage(harness.document);
  harness.client.setFeatureState({ searchMaskEnabled: true });
  harness.raf.flushAll();
  assert.equal(harness.run('bfSearchController.active'), true);
  assert.ok(harness.document.querySelector('#bili-header-mask-left'));
  assert.equal(harness.client.subscriberCount(), 1);

  harness.events.dispatch('pagehide', { persisted: true });
  assert.equal(harness.run('bfSearchController.active'), false);
  assert.equal(harness.mutations.connectedCount(), 0);
  assert.equal(harness.resizes.connectedCount(), 0);
  assert.equal(harness.raf.pendingCount(), 0);
  assert.equal(harness.timers.timeoutCount(), 0);
  assert.equal(harness.document.querySelector('#bili-header-mask-left'), null);
  assert.equal(harness.client.subscriberCount(), 0);

  const callsBeforeRestore = harness.client.getStateCalls.length;
  harness.client.setFeatureState({ searchMaskEnabled: true }, false);
  harness.events.dispatch('pageshow', { persisted: true });
  await harness.settle();
  harness.raf.flushAll();

  assert.equal(harness.run('bfSearchController.active'), true);
  assert.ok(harness.document.querySelector('#bili-header-mask-left'));
  assert.equal(harness.resizes.connectedCount(), 1);
  assert.equal(harness.client.getStateCalls.length, callsBeforeRestore + 1);
  assert.equal(harness.client.subscriberCount(), 1);
  harness.run('bfStopSearchMask()');
});

test('showing the search mask clears an older hide timer before it can hide the mask', async () => {
  const harness = await createOverlayHarness(SEARCH_SOURCE, {
    searchMaskEnabled: false
  });
  appendSearchPage(harness.document);
  harness.run('bfStartSearchMask()');
  harness.raf.flushAll();
  const mask = harness.document.querySelector('#bili-header-mask-left');
  assert.ok(mask);
  assert.equal(mask.style.display, 'block');
  assert.equal(mask.style.opacity, '1');

  harness.window.scrollY = 100;
  harness.events.dispatch('scroll');
  harness.raf.flushFrame();
  const staleTimerId = harness.run('bfSearchController.maskHideTimer');
  assert.ok(staleTimerId);
  assert.equal(harness.timers.timeoutCount(), 1);
  assert.equal(mask.style.opacity, '0');

  harness.window.scrollY = 0;
  harness.events.dispatch('scroll');
  harness.raf.flushFrame();
  assert.equal(harness.timers.timeoutCount(), 0);
  assert.equal(harness.timers.fireTimeout(staleTimerId), false);
  harness.raf.flushAll();
  assert.equal(mask.style.display, 'block');
  assert.equal(mask.style.opacity, '1');
  harness.run('bfStopSearchMask()');
});

test('stopping the search mask cancels a queued show frame', async () => {
  const harness = await createOverlayHarness(SEARCH_SOURCE, {
    searchMaskEnabled: false
  });
  appendSearchPage(harness.document);
  harness.run('bfStartSearchMask()');
  harness.raf.flushAll();

  harness.window.scrollY = 100;
  harness.events.dispatch('scroll');
  harness.raf.flushFrame();
  assert.equal(harness.timers.timeoutCount(), 1);

  harness.window.scrollY = 0;
  harness.events.dispatch('scroll');
  harness.raf.flushFrame();
  assert.equal(harness.raf.pendingCount(), 1);
  assert.equal(harness.timers.timeoutCount(), 0);

  harness.run('bfStopSearchMask()');
  assert.equal(harness.raf.pendingCount(), 0);
  assert.equal(harness.raf.flushAll(), 0);
});

test('stopping the search mask cancels frames and timers without altering page inline styles', async () => {
  const harness = await createOverlayHarness(SEARCH_SOURCE, {
    searchMaskEnabled: false
  });
  const page = appendSearchPage(harness.document);
  harness.document.documentElement.className = 'host-root is-entry is-results';
  harness.document.documentElement.style.setProperty('overflow', 'clip', 'important');
  harness.document.body.style.setProperty('background', 'navy');
  page.entry.style.setProperty('display', 'grid', 'important');
  page.center.style.setProperty('min-height', '33vh');
  page.input.style.setProperty('position', 'absolute');
  page.input.style.setProperty('left', '17px');
  const before = {
    root: harness.document.documentElement.style.cssText,
    body: harness.document.body.style.cssText,
    entry: page.entry.style.cssText,
    center: page.center.style.cssText,
    input: page.input.style.cssText
  };

  harness.run('bfStartSearchMask()');
  harness.raf.flushAll();
  harness.window.scrollY = 100;
  harness.events.dispatch('scroll');
  harness.raf.flushFrame();
  assert.equal(harness.timers.timeoutCount(), 1);

  harness.mutations.trigger(5);
  assert.equal(harness.raf.pendingCount(), 1);
  harness.run('bfStopSearchMask()');

  assert.equal(harness.raf.pendingCount(), 0);
  assert.equal(harness.timers.timeoutCount(), 0);
  assert.equal(harness.mutations.connectedCount(), 0);
  assert.equal(harness.events.listenerCount('scroll'), 0);
  assert.equal(harness.events.listenerCount('resize'), 0);
  assert.equal(harness.raf.flushAll(), 0);
  harness.timers.fireAllTimeouts();
  assert.equal(harness.document.querySelector('#bili-header-mask-left'), null);
  assert.equal(
    harness.document.documentElement.className,
    'host-root is-entry is-results'
  );
  assert.deepEqual({
    root: harness.document.documentElement.style.cssText,
    body: harness.document.body.style.cssText,
    entry: page.entry.style.cssText,
    center: page.center.style.cssText,
    input: page.input.style.cssText
  }, before);
});
