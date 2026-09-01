const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SHARED_SOURCE = fs.readFileSync(path.join(ROOT, 'lockShared.js'), 'utf8');
const SHORTCUT_SOURCE = fs.readFileSync(
  path.join(ROOT, 'playerShortcuts.js'),
  'utf8'
);

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  replace(value) {
    this.values = new Set(String(value).split(/\s+/).filter(Boolean));
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

  toString() {
    return Array.from(this.values).join(' ');
  }
}

function parseSelector(selector) {
  const attribute = /\[([^=\]]+)(?:=["']?([^\]"']+)["']?)?\]$/.exec(selector);
  const withoutAttribute = attribute
    ? selector.slice(0, attribute.index)
    : selector;
  return {
    base: withoutAttribute,
    attribute: attribute && attribute[1] || null,
    attributeValue: attribute && attribute[2] || null
  };
}

function matchesSelector(element, selector) {
  if (!element || element.nodeType !== 1) return false;
  if (selector === ':hover') return element.hovered;
  const parsed = parseSelector(selector);
  let baseMatches = true;
  if (parsed.base.startsWith('.')) {
    baseMatches = element.classList.contains(parsed.base.slice(1));
  } else if (parsed.base.startsWith('#')) {
    baseMatches = element.id === parsed.base.slice(1);
  } else if (parsed.base) {
    baseMatches = element.tagName.toLowerCase() === parsed.base.toLowerCase();
  }
  if (!baseMatches || !parsed.attribute) return baseMatches;
  const value = element.getAttribute(parsed.attribute);
  return parsed.attributeValue === null
    ? value !== null
    : value === parsed.attributeValue;
}

function descendantsOf(element) {
  const descendants = [];
  const visit = (node) => {
    node.children.forEach((child) => {
      descendants.push(child);
      visit(child);
    });
  };
  visit(element);
  return descendants;
}

class FakeElement {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.parentNode = null;
    this.children = [];
    this.classList = new FakeClassList();
    this.attributes = new Map();
    this.style = {};
    this.id = '';
    this.textContent = '';
    this.isContentEditable = false;
    this.hovered = false;
    this.clickCount = 0;
    this.onClick = null;
    this.rect = {
      top: 100,
      left: 200,
      right: 1000,
      bottom: 550,
      width: 800,
      height: 450
    };
  }

  get className() {
    return this.classList.toString();
  }

  set className(value) {
    this.classList.replace(value);
  }

  appendChild(child) {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(
      (child) => child !== this
    );
    this.parentNode = null;
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    return this.attributes.has(String(name))
      ? this.attributes.get(String(name))
      : null;
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (matchesSelector(current, selector)) return current;
      current = current.parentNode;
    }
    return null;
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    return descendantsOf(this).filter((node) => matchesSelector(node, selector));
  }

  getBoundingClientRect() {
    return { ...this.rect };
  }

  click() {
    this.clickCount += 1;
    if (this.onClick) this.onClick();
  }
}

function createEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      if (!listeners.get(type).includes(listener)) listeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      if (!listeners.has(type)) return;
      listeners.set(
        type,
        listeners.get(type).filter((entry) => entry !== listener)
      );
    },
    dispatch(type, event = {}) {
      for (const listener of [...(listeners.get(type) || [])]) {
        listener(event);
        if (event.immediatePropagationStopped) break;
      }
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    }
  };
}

class FakeDocument {
  constructor(events) {
    this.events = events;
    this.documentElement = new FakeElement('html');
    this.body = new FakeElement('body');
    this.documentElement.appendChild(this.body);
    this.fullscreenElement = null;
  }

  addEventListener(...args) {
    this.events.addEventListener(...args);
  }

  removeEventListener(...args) {
    this.events.removeEventListener(...args);
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  querySelector(selector) {
    if (matchesSelector(this.documentElement, selector)) return this.documentElement;
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector) {
    const matches = this.documentElement.querySelectorAll(selector);
    if (matchesSelector(this.documentElement, selector)) {
      matches.unshift(this.documentElement);
    }
    return matches;
  }
}

function createTimerScheduler() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback) {
      const id = nextId;
      nextId += 1;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    fireAll() {
      for (const [id, callback] of Array.from(timers)) {
        timers.delete(id);
        callback();
      }
    },
    count() {
      return timers.size;
    }
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createClient(initialConfig) {
  let config = clone(initialConfig);
  const subscribers = new Set();
  const getStateCalls = [];
  return {
    async getState(options = {}) {
      getStateCalls.push({ ...options });
      return { playerShortcutConfig: clone(config) };
    },
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    publish(nextConfig) {
      config = clone(nextConfig);
      subscribers.forEach((listener) => listener({
        playerShortcutConfig: clone(config)
      }));
    },
    subscriberCount() {
      return subscribers.size;
    },
    getStateCalls
  };
}

function binding(code, modifiers = {}) {
  return {
    code,
    ctrl: Boolean(modifiers.ctrl),
    alt: Boolean(modifiers.alt),
    shift: Boolean(modifiers.shift),
    meta: Boolean(modifiers.meta)
  };
}

function shortcutConfig(bindings = {}, enabled = true) {
  return { enabled, bindings };
}

function appendPlayer(document, { rect, hovered = false } = {}) {
  const player = document.createElement('section');
  player.className = 'bpx-player-container';
  player.hovered = hovered;
  if (rect) player.rect = { ...player.rect, ...rect };
  const video = document.createElement('video');
  video.paused = true;
  video.currentTime = 0;
  video.duration = 100;
  video.muted = false;
  video.playbackRate = 1;
  video.playCount = 0;
  video.pauseCount = 0;
  video.play = async () => {
    video.playCount += 1;
    video.paused = false;
  };
  video.pause = () => {
    video.pauseCount += 1;
    video.paused = true;
  };
  player.appendChild(video);
  document.body.appendChild(player);
  return { player, video };
}

function appendControl(document, player, className, options = {}) {
  const control = document.createElement(options.tagName || 'button');
  control.className = className;
  Object.entries(options.attributes || {}).forEach(([name, value]) => {
    control.setAttribute(name, value);
  });
  control.onClick = options.onClick || null;
  player.appendChild(control);
  return control;
}

function createKeyEvent(code, options = {}) {
  const target = options.target || null;
  return {
    code,
    ctrlKey: Boolean(options.ctrlKey),
    altKey: Boolean(options.altKey),
    shiftKey: Boolean(options.shiftKey),
    metaKey: Boolean(options.metaKey),
    repeat: Boolean(options.repeat),
    isComposing: Boolean(options.isComposing),
    keyCode: options.keyCode || 0,
    target,
    defaultPrevented: false,
    immediatePropagationStopped: false,
    composedPath() {
      return options.path || [target];
    },
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {
      this.immediatePropagationStopped = true;
    }
  };
}

async function createHarness(config, pathname = '/video/BV-test') {
  const windowEvents = createEventTarget();
  const documentEvents = createEventTarget();
  const timers = createTimerScheduler();
  const document = new FakeDocument(documentEvents);
  const client = createClient(config);
  const window = {
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener: windowEvents.addEventListener,
    removeEventListener: windowEvents.removeEventListener,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout
  };
  const context = vm.createContext({
    console,
    document,
    window,
    location: {
      hostname: 'www.bilibili.com',
      pathname
    },
    BiliFocusClient: client,
    Promise,
    Set,
    URL
  });
  vm.runInContext(SHARED_SOURCE, context, { filename: 'lockShared.js' });
  vm.runInContext(SHORTCUT_SOURCE, context, { filename: 'playerShortcuts.js' });
  await new Promise((resolve) => setImmediate(resolve));
  return {
    client,
    context,
    document,
    documentEvents,
    timers,
    window,
    windowEvents,
    dispatchKey(code, options = {}) {
      const event = createKeyEvent(code, {
        target: document.body,
        ...options
      });
      windowEvents.dispatch('keydown', event);
      return event;
    },
    toastText() {
      return document.querySelector('#bili-focus-shortcut-toast')?.textContent || '';
    },
    async settle() {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

test('shortcut schema uses physical codes, exact modifiers, and safe defaults', () => {
  const context = vm.createContext({ URL, console });
  vm.runInContext(SHARED_SOURCE, context, { filename: 'lockShared.js' });
  const shared = context.BiliFocusShared;
  const normalized = shared.ensurePlayerShortcutConfig({
    enabled: true,
    bindings: {
      togglePlay: binding('KeyC', { meta: true }),
      toggleMute: binding('KeyC', { meta: true }),
      speedUp: binding('Period', { shift: true }),
      speedDown: binding('CapsLock'),
      unknownAction: binding('KeyZ')
    }
  });

  assert.equal(normalized.enabled, true);
  assert.deepEqual(clone(normalized.bindings.togglePlay), binding('KeyC', { meta: true }));
  assert.equal(normalized.bindings.toggleMute, null);
  assert.equal(normalized.bindings.speedDown, null);
  assert.equal(Object.hasOwn(normalized.bindings, 'unknownAction'), false);
  assert.equal(
    shared.shortcutBindingMatchesEvent(normalized.bindings.speedUp, {
      code: 'Period',
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
      metaKey: false
    }),
    true
  );
  assert.equal(
    shared.shortcutBindingMatchesEvent(normalized.bindings.speedUp, {
      code: 'Period',
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false
    }),
    false
  );
});

test('shortcuts require player context and release editable or composing input', async () => {
  const harness = await createHarness(shortcutConfig({
    togglePlay: binding('KeyP', { ctrl: true })
  }));
  const { player, video } = appendPlayer(harness.document);

  let downstreamCount = 0;
  harness.window.addEventListener('keydown', () => {
    downstreamCount += 1;
  });

  let event = harness.dispatchKey('KeyP', { ctrlKey: true });
  assert.equal(event.defaultPrevented, false);
  assert.equal(downstreamCount, 1);

  harness.documentEvents.dispatch('pointerover', { target: video });
  const input = harness.document.createElement('input');
  event = harness.dispatchKey('KeyP', {
    ctrlKey: true,
    target: input,
    path: [input]
  });
  assert.equal(event.defaultPrevented, false);
  assert.equal(downstreamCount, 2);

  const editor = harness.document.createElement('div');
  editor.isContentEditable = true;
  event = harness.dispatchKey('KeyP', {
    ctrlKey: true,
    target: editor,
    path: [editor]
  });
  assert.equal(event.defaultPrevented, false);

  const textbox = harness.document.createElement('div');
  textbox.setAttribute('role', 'textbox');
  event = harness.dispatchKey('KeyP', {
    ctrlKey: true,
    target: textbox,
    path: [textbox]
  });
  assert.equal(event.defaultPrevented, false);

  event = harness.dispatchKey('KeyP', { ctrlKey: true, isComposing: true });
  assert.equal(event.defaultPrevented, false);
  event = harness.dispatchKey('KeyP', { ctrlKey: true, keyCode: 229 });
  assert.equal(event.defaultPrevented, false);

  event = harness.dispatchKey('KeyP', { ctrlKey: true });
  await harness.settle();
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.immediatePropagationStopped, true);
  assert.equal(video.playCount, 1);
  assert.equal(downstreamCount, 6);
  assert.equal(harness.toastText(), '继续播放');

  player.hovered = false;
  harness.documentEvents.dispatch('pointerout', {
    target: video,
    relatedTarget: harness.document.body
  });
});

test('hover, fullscreen, and 90 percent viewport coverage activate shortcuts', async () => {
  const harness = await createHarness(shortcutConfig({
    toggleMute: binding('KeyM')
  }));
  const first = appendPlayer(harness.document);

  first.player.hovered = true;
  let event = harness.dispatchKey('KeyM');
  assert.equal(event.defaultPrevented, true);
  assert.equal(first.video.muted, true);

  first.player.hovered = false;
  harness.document.fullscreenElement = first.video;
  event = harness.dispatchKey('KeyM');
  assert.equal(event.defaultPrevented, true);
  assert.equal(first.video.muted, false);

  harness.document.fullscreenElement = null;
  first.player.rect = {
    top: 0,
    left: 0,
    right: 1280,
    bottom: 660,
    width: 1280,
    height: 660
  };
  event = harness.dispatchKey('KeyM');
  assert.equal(event.defaultPrevented, true);
  assert.equal(first.video.muted, true);

  first.player.rect.bottom = 640;
  first.player.rect.height = 640;
  event = harness.dispatchKey('KeyM');
  assert.equal(event.defaultPrevented, false);
});

test('native video actions clamp seeking and only seek actions repeat', async () => {
  const harness = await createHarness(shortcutConfig({
    togglePlay: binding('KeyP'),
    seekBackward: binding('KeyJ'),
    seekForward: binding('KeyL'),
    toggleMute: binding('KeyM')
  }));
  const { player, video } = appendPlayer(harness.document, { hovered: true });

  let event = harness.dispatchKey('KeyP', { repeat: true });
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.immediatePropagationStopped, true);
  assert.equal(video.playCount, 0);

  event = harness.dispatchKey('KeyP');
  await harness.settle();
  assert.equal(event.defaultPrevented, true);
  assert.equal(video.playCount, 1);
  harness.dispatchKey('KeyP');
  assert.equal(video.pauseCount, 1);

  video.currentTime = 2;
  event = harness.dispatchKey('KeyJ', { repeat: true });
  assert.equal(event.defaultPrevented, true);
  assert.equal(video.currentTime, 0);

  video.currentTime = 98;
  harness.dispatchKey('KeyL', { repeat: true });
  assert.equal(video.currentTime, 100);

  harness.dispatchKey('KeyM');
  assert.equal(video.muted, true);
  assert.equal(harness.toastText(), '已静音');
  assert.equal(harness.timers.count(), 1);

  player.hovered = false;
});

test('speed actions prefer native menu items and fall back to playbackRate', async () => {
  const harness = await createHarness(shortcutConfig({
    speedDown: binding('Comma'),
    speedUp: binding('Period'),
    speedReset: binding('KeyR')
  }));
  const { player, video } = appendPlayer(harness.document, { hovered: true });
  const speed125 = appendControl(
    harness.document,
    player,
    'bpx-player-ctrl-playbackrate-menu-item',
    {
      attributes: { 'data-value': '1.25' },
      onClick: () => {
        video.playbackRate = 1.25;
      }
    }
  );

  harness.dispatchKey('Period');
  assert.equal(speed125.clickCount, 1);
  assert.equal(video.playbackRate, 1.25);
  assert.equal(harness.toastText(), '倍速 1.25×');

  harness.dispatchKey('Comma');
  assert.equal(video.playbackRate, 1);
  harness.dispatchKey('Comma');
  assert.equal(video.playbackRate, 0.75);
  video.playbackRate = 2;
  harness.dispatchKey('Period');
  assert.equal(video.playbackRate, 2);
  harness.dispatchKey('KeyR');
  assert.equal(video.playbackRate, 1);
});

test('semantic controls toggle safely and subtitle errors explain the cause', async () => {
  const harness = await createHarness(shortcutConfig({
    toggleSubtitle: binding('KeyC'),
    toggleDanmaku: binding('KeyD'),
    toggleWebFullscreen: binding('KeyW'),
    toggleFullscreen: binding('KeyF')
  }));
  const { player } = appendPlayer(harness.document, { hovered: true });

  const subtitleControl = appendControl(
    harness.document,
    player,
    'bpx-player-ctrl-subtitle'
  );
  const closeSwitch = appendControl(
    harness.document,
    player,
    'bpx-player-ctrl-subtitle-close-switch bpx-state-active'
  );
  closeSwitch.onClick = () => closeSwitch.classList.remove('bpx-state-active');
  appendControl(
    harness.document,
    player,
    'bpx-player-ctrl-subtitle-language-item'
  );
  const danmaku = appendControl(
    harness.document,
    player,
    'bpx-player-dm-switch'
  );
  const web = appendControl(
    harness.document,
    player,
    'bpx-player-ctrl-web'
  );
  const fullscreen = appendControl(
    harness.document,
    player,
    'bpx-player-ctrl-full'
  );

  harness.dispatchKey('KeyC');
  assert.equal(closeSwitch.clickCount, 1);
  assert.equal(subtitleControl.clickCount, 0);
  assert.equal(harness.toastText(), '字幕已开启');
  harness.dispatchKey('KeyD');
  harness.dispatchKey('KeyW');
  harness.dispatchKey('KeyF');
  assert.equal(danmaku.clickCount, 1);
  assert.equal(web.clickCount, 1);
  assert.equal(fullscreen.clickCount, 1);

  const language = player.querySelector('.bpx-player-ctrl-subtitle-language-item');
  language.remove();
  harness.dispatchKey('KeyC');
  assert.equal(harness.toastText(), '当前视频没有可用字幕');
  appendControl(
    harness.document,
    player,
    'bpx-player-ctrl-subtitle-language-item bpx-player-ctrl-subtitle-language-unlogin'
  );
  harness.dispatchKey('KeyC');
  assert.equal(harness.toastText(), '登录后才能使用字幕');

  danmaku.remove();
  harness.dispatchKey('KeyD');
  assert.equal(harness.toastText(), '当前播放器不支持弹幕切换');
});

test('BFCache teardown is complete and replacement players work without duplicates', async () => {
  const harness = await createHarness(shortcutConfig({
    toggleMute: binding('KeyM')
  }));
  const first = appendPlayer(harness.document, { hovered: true });

  assert.equal(harness.windowEvents.listenerCount('keydown'), 1);
  assert.equal(harness.documentEvents.listenerCount('pointerover'), 1);
  assert.equal(harness.client.subscriberCount(), 1);
  harness.dispatchKey('KeyM');
  assert.equal(first.video.muted, true);

  harness.windowEvents.dispatch('pagehide', {});
  assert.equal(harness.windowEvents.listenerCount('keydown'), 0);
  assert.equal(harness.documentEvents.listenerCount('pointerover'), 0);
  assert.equal(harness.client.subscriberCount(), 0);
  assert.equal(harness.document.querySelector('#bili-focus-shortcut-toast'), null);

  harness.windowEvents.dispatch('pageshow', {});
  harness.windowEvents.dispatch('pageshow', {});
  await harness.settle();
  assert.equal(harness.windowEvents.listenerCount('keydown'), 1);
  assert.equal(harness.documentEvents.listenerCount('pointerover'), 1);
  assert.equal(harness.client.subscriberCount(), 1);

  first.player.remove();
  const replacement = appendPlayer(harness.document, { hovered: true });
  const event = harness.dispatchKey('KeyM');
  assert.equal(event.defaultPrevented, true);
  assert.equal(replacement.video.muted, true);
});

test('non-video pages keep installed shortcut listeners inert', async () => {
  const harness = await createHarness(shortcutConfig({
    togglePlay: binding('KeyP')
  }), '/bangumi/play/ep1');
  const { player, video } = appendPlayer(harness.document, { hovered: true });
  const event = harness.dispatchKey('KeyP');
  assert.equal(harness.windowEvents.listenerCount('keydown'), 1);
  assert.equal(harness.documentEvents.listenerCount('pointerover'), 1);
  assert.equal(harness.client.subscriberCount(), 1);
  assert.equal(harness.client.getStateCalls.length, 1);
  assert.equal(event.defaultPrevented, false);
  assert.equal(video.playCount, 0);
  player.hovered = false;
});
