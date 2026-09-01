'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (error) {
  process.stderr.write(
    'Playwright is required only for MV3 E2E. Install the pinned CI version with: ' +
    'npm install --ignore-scripts --no-audit --no-fund --no-save --no-package-lock playwright@1.55.0\n'
  );
  process.exit(1);
}

const DEFAULT_EXTENSION_PATH = path.resolve(__dirname, '..');
const DEFAULT_TIMEOUT_MS = 20000;
const TEST_HTML = `<!doctype html>
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8">
      <title>Local Bilibili MV3 boundary</title>
      <style>
        .bpx-player-container { width: 640px; height: 360px; }
        video { width: 100%; height: 100%; }
      </style>
    </head>
    <body>
      <main id="local-test-surface">isolated Bilibili test surface</main>
      <section class="bpx-player-container" aria-label="local player fixture">
        <video></video>
        <button class="bpx-player-dm-switch" type="button">danmaku</button>
        <button class="bpx-player-ctrl-web" type="button">web fullscreen</button>
        <button class="bpx-player-ctrl-full" type="button">fullscreen</button>
      </section>
      <script>
        window.__fixtureKeydownCount = 0;
        window.addEventListener('keydown', () => {
          window.__fixtureKeydownCount += 1;
        }, true);
      </script>
    </body>
  </html>`;

function parseCliArguments(argv) {
  let extensionPath = DEFAULT_EXTENSION_PATH;
  let executablePath = process.env.BILI_FOCUS_CHROMIUM || chromium.executablePath();
  let timeoutMs = Number(process.env.BILI_FOCUS_E2E_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  let headed = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--extension') {
      extensionPath = path.resolve(argv[index + 1] || '');
      index += 1;
    } else if (argument === '--executable') {
      executablePath = path.resolve(argv[index + 1] || '');
      index += 1;
    } else if (argument === '--timeout-ms') {
      timeoutMs = Number(argv[index + 1]);
      index += 1;
    } else if (argument === '--headed') {
      headed = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  assert.ok(Number.isFinite(timeoutMs) && timeoutMs >= 1000, 'Invalid E2E timeout.');
  return { extensionPath, executablePath, timeoutMs, headed };
}

function isBilibiliHttpUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (
        url.hostname === 'bilibili.com' ||
        url.hostname.endsWith('.bilibili.com')
      )
    );
  } catch (error) {
    return false;
  }
}

async function waitForServiceWorker(context, timeoutMs) {
  const existing = context.serviceWorkers().find((worker) => (
    /^chrome-extension:\/\/[^/]+\/background\.js$/.test(worker.url())
  ));
  if (existing) return existing;

  const worker = await context.waitForEvent('serviceworker', { timeout: timeoutMs });
  assert.match(worker.url(), /^chrome-extension:\/\/[^/]+\/background\.js$/);
  return worker;
}

async function openAllowedVideo(context, timeoutMs, suffix = 'BV1') {
  const page = await context.newPage();
  const url = `https://www.bilibili.com/video/${suffix}`;
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs
  });
  await page.locator('#local-test-surface').waitFor({ timeout: timeoutMs });
  assert.equal(page.url(), url);
  return { page, url };
}

async function main() {
  const options = parseCliArguments(process.argv.slice(2));
  assert.equal(
    fs.existsSync(path.join(options.extensionPath, 'manifest.json')),
    true,
    `manifest.json missing from extension path: ${options.extensionPath}`
  );
  assert.equal(
    fs.existsSync(options.executablePath),
    true,
    `Chromium executable missing: ${options.executablePath}`
  );

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-focus-mv3-e2e-'));
  let context = null;

  const networkIsolation = {
    interceptedBilibiliRequests: 0,
    fulfilledBilibiliDocuments: 0,
    productionBilibiliRequests: 0,
    blockedExternalRequests: 0
  };

  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: options.executablePath,
      headless: !options.headed,
      viewport: { width: 1280, height: 800 },
      args: [
        `--disable-extensions-except=${options.extensionPath}`,
        `--load-extension=${options.extensionPath}`
      ]
    });

    context.on('response', (response) => {
      if (
        isBilibiliHttpUrl(response.url()) &&
        response.headers()['x-bili-focus-local-fixture'] !== '1'
      ) {
        networkIsolation.productionBilibiliRequests += 1;
      }
    });

    await context.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      if (isBilibiliHttpUrl(requestUrl)) {
        networkIsolation.interceptedBilibiliRequests += 1;
        networkIsolation.fulfilledBilibiliDocuments += 1;
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          headers: {
            'cache-control': 'no-store',
            'x-bili-focus-local-fixture': '1'
          },
          body: TEST_HTML
        });
        return;
      }

      if (/^https?:/i.test(requestUrl)) {
        networkIsolation.blockedExternalRequests += 1;
        await route.abort('blockedbyclient');
        return;
      }

      await route.continue();
    });

    const worker = await waitForServiceWorker(context, options.timeoutMs);
    const extensionId = new URL(worker.url()).hostname;
    const blockedPageUrl = `chrome-extension://${extensionId}/blocked.html`;
    const browserVersion = context.browser() ? context.browser().version() : 'unknown';
    const redirectTarget = await worker.evaluate(() => (
      globalThis.BiliFocusShared.REDIRECT_TARGET_URL
    ));

    await worker.evaluate(async () => {
      const shared = globalThis.BiliFocusShared;
      await chrome.storage.sync.set(shared.getDefaultSyncState());
      await chrome.storage.local.set({
        focusSession: { ...shared.DEFAULT_FOCUS_SESSION },
        usageState: {
          ...shared.DEFAULT_USAGE_STATE,
          lastPingByTab: {}
        },
        siteBlockOverrideDisabled: false,
        strictConfigSnapshot: null
      });
      await globalThis.refreshRuntimeState({
        forceBlockOpenTabs: true
      });
    });

    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/controlPanel.html`, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs
    });
    const redirectToggle = popupPage.locator('#toggleRedirect');
    await redirectToggle.waitFor({ timeout: options.timeoutMs });
    assert.equal(await redirectToggle.isChecked(), true);
    await popupPage.locator('#toggleRedirect + .toggle-slider').click();
    await popupPage.waitForFunction(async () => (
      (await chrome.storage.sync.get(['redirectEnabled'])).redirectEnabled === false
    ), null, { timeout: options.timeoutMs });
    await popupPage.waitForFunction(() => (
      document.getElementById('toggleRedirect').checked === false
    ), null, { timeout: options.timeoutMs });
    assert.equal(await redirectToggle.isChecked(), false);
    assert.equal(await popupPage.locator('#commandError').textContent(), '');

    await popupPage.locator('#toggleRedirect + .toggle-slider').click();
    await popupPage.waitForFunction(async () => (
      (await chrome.storage.sync.get(['redirectEnabled'])).redirectEnabled === true
    ), null, { timeout: options.timeoutMs });
    await popupPage.waitForFunction(() => (
      document.getElementById('toggleRedirect').checked === true
    ), null, { timeout: options.timeoutMs });
    assert.equal(await redirectToggle.isChecked(), true);
    assert.equal(await popupPage.locator('#commandError').textContent(), '');

    const siteBlockToggle = popupPage.locator('#toggleSiteBlock');
    assert.equal(await siteBlockToggle.isChecked(), false);
    await popupPage.locator('#toggleSiteBlock + .toggle-slider').click();
    await popupPage.waitForFunction(async () => (
      (await chrome.storage.sync.get(['siteBlockEnabled'])).siteBlockEnabled === true
    ), null, { timeout: options.timeoutMs });
    await popupPage.waitForFunction(() => (
      document.getElementById('toggleSiteBlock').checked === true
    ), null, { timeout: options.timeoutMs });

    await popupPage.locator('#toggleSiteBlock + .toggle-slider').click();
    await popupPage.waitForFunction(async () => (
      (await chrome.storage.sync.get(['siteBlockEnabled'])).siteBlockEnabled === false
    ), null, { timeout: options.timeoutMs });
    await popupPage.waitForFunction(() => (
      document.getElementById('toggleSiteBlock').checked === false
    ), null, { timeout: options.timeoutMs });
    assert.equal(await siteBlockToggle.isChecked(), false);
    assert.equal(await popupPage.locator('#commandError').textContent(), '');
    await popupPage.close();

    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs
    });
    const darkThemeInput = optionsPage.locator('input[name="themeMode"][value="dark"]');
    await darkThemeInput.waitFor({ timeout: options.timeoutMs });
    await optionsPage.locator('input[name="themeMode"][value="dark"] + .theme-card').click();
    const muteShortcutRow = optionsPage.locator(
      '.shortcut-binding-row[data-action="toggleMute"]'
    );
    await muteShortcutRow.locator('.shortcut-record-button').click();
    await optionsPage.keyboard.press('m');
    assert.equal(
      await muteShortcutRow.locator('.shortcut-binding-value').textContent(),
      'M'
    );
    await optionsPage.locator('#saveSettings').click();
    await optionsPage.locator('#saveHint').filter({ hasText: '已保存' }).waitFor({
      timeout: options.timeoutMs
    });
    await optionsPage.waitForFunction(async () => (
      (await chrome.storage.sync.get(['appearanceConfig'])).appearanceConfig.theme === 'dark'
    ), null, { timeout: options.timeoutMs });
    await optionsPage.waitForFunction(async () => {
      const { playerShortcutConfig } = await chrome.storage.sync.get([
        'playerShortcutConfig'
      ]);
      const binding = playerShortcutConfig &&
        playerShortcutConfig.bindings &&
        playerShortcutConfig.bindings.toggleMute;
      return binding &&
        binding.code === 'KeyM' &&
        binding.ctrl === false &&
        binding.alt === false &&
        binding.shift === false &&
        binding.meta === false;
    }, null, { timeout: options.timeoutMs });
    assert.equal(await darkThemeInput.isChecked(), true);

    await optionsPage.reload({ waitUntil: 'domcontentloaded' });
    await optionsPage.locator('input[name="themeMode"][value="dark"]').waitFor({
      timeout: options.timeoutMs
    });
    assert.equal(
      await optionsPage.locator('input[name="themeMode"][value="dark"]').isChecked(),
      true
    );
    assert.equal(
      await optionsPage.locator(
        '.shortcut-binding-row[data-action="toggleMute"] .shortcut-binding-value'
      ).textContent(),
      'M'
    );
    await optionsPage.close();

    const shortcutCase = await openAllowedVideo(
      context,
      options.timeoutMs,
      'BV-shortcut'
    );
    const shortcutPlayer = shortcutCase.page.locator('.bpx-player-container');
    await shortcutPlayer.hover();
    await shortcutCase.page.waitForTimeout(150);
    assert.equal(
      await shortcutCase.page.locator('.bpx-player-container video').evaluate(
        (video) => video.muted
      ),
      false
    );
    assert.equal(
      await shortcutCase.page.evaluate(() => window.__fixtureKeydownCount),
      0
    );
    await shortcutCase.page.keyboard.press('m');
    await shortcutCase.page.waitForFunction(() => (
      document.querySelector('.bpx-player-container video').muted === true
    ), null, { timeout: options.timeoutMs });
    assert.equal(
      await shortcutCase.page.locator('#bili-focus-shortcut-toast').textContent(),
      '已静音'
    );
    assert.equal(
      await shortcutCase.page.evaluate(() => window.__fixtureKeydownCount),
      0
    );
    await shortcutCase.page.close();

    const pushStateCase = await openAllowedVideo(context, options.timeoutMs, 'BV-push');
    await pushStateCase.page.evaluate(() => {
      history.pushState({ mv3E2E: 'pushState' }, '', '/');
    });
    await pushStateCase.page.waitForURL(redirectTarget, { timeout: options.timeoutMs });
    assert.equal(pushStateCase.page.url(), redirectTarget);
    await pushStateCase.page.close();

    const replaceStateCase = await openAllowedVideo(context, options.timeoutMs, 'BV-replace');
    await replaceStateCase.page.evaluate(() => {
      history.replaceState({ mv3E2E: 'replaceState' }, '', '/');
    });
    await replaceStateCase.page.waitForURL(redirectTarget, { timeout: options.timeoutMs });
    assert.equal(replaceStateCase.page.url(), redirectTarget);
    await replaceStateCase.page.close();

    const historyCase = await openAllowedVideo(
      context,
      options.timeoutMs,
      'BV-history-start'
    );
    await historyCase.page.evaluate(() => {
      history.pushState({ mv3E2E: 'candidate' }, '', '/');
      history.pushState({ mv3E2E: 'safe' }, '', '/video/BV-history-safe');
    });
    assert.equal(
      historyCase.page.url(),
      'https://www.bilibili.com/video/BV-history-safe'
    );
    const historyRedirect = historyCase.page.waitForURL(redirectTarget, {
      timeout: options.timeoutMs
    });
    await historyCase.page.goBack({ timeout: options.timeoutMs });
    await historyRedirect;
    assert.equal(historyCase.page.url(), redirectTarget);
    await historyCase.page.close();

    const blockCase = await openAllowedVideo(context, options.timeoutMs, 'BV-block');
    await worker.evaluate(async () => {
      await chrome.storage.sync.set({ siteBlockEnabled: true });
    });
    await blockCase.page.waitForURL(blockedPageUrl, { timeout: options.timeoutMs });
    await blockCase.page.locator('.blocked-card').waitFor({ timeout: options.timeoutMs });
    const blockedState = await blockCase.page.evaluate(() => ({
      href: location.href,
      protocol: location.protocol,
      hasExtensionCard: Boolean(document.querySelector('.blocked-card')),
      hasLegacySharedOverlay: Boolean(
        document.querySelector('#bili-focus-site-block')
      )
    }));
    assert.deepEqual(blockedState, {
      href: blockedPageUrl,
      protocol: 'chrome-extension:',
      hasExtensionCard: true,
      hasLegacySharedOverlay: false
    });

    await worker.evaluate(async () => {
      await chrome.storage.sync.set({ siteBlockEnabled: false });
    });
    await blockCase.page.waitForURL(blockCase.url, { timeout: options.timeoutMs });
    await blockCase.page.locator('#local-test-surface').waitFor({
      timeout: options.timeoutMs
    });
    assert.equal(blockCase.page.url(), blockCase.url);
    await blockCase.page.close();

    assert.ok(
      networkIsolation.interceptedBilibiliRequests > 0,
      'The local Bilibili fixture was not exercised.'
    );
    assert.equal(
      networkIsolation.productionBilibiliRequests,
      0,
      'A production Bilibili request escaped local routing.'
    );

    const results = {
      outcome: 'pass',
      browserVersion,
      executablePath: options.executablePath,
      extensionId,
      serviceWorkerUrl: worker.url(),
      networkIsolation,
      checks: {
        serviceWorkerLoaded: true,
        popupPreferenceTogglePersisted: true,
        optionsSettingsPersistedAfterReload: true,
        playerShortcutRecordedAndPersisted: true,
        playerShortcutChangedVideoState: true,
        playerShortcutInterceptedHostKeydown: true,
        pushStateRedirectedToFixedTarget: true,
        replaceStateRedirectedToFixedTarget: true,
        browserHistoryCandidateRedirectedToFixedTarget: true,
        siteBlockNavigatedToExtensionOwnedPage: true,
        legacySharedDomOverlayAbsent: true,
        validatedVideoUrlResumedAfterUnlock: true,
        productionBilibiliRequestsZero: true
      }
    };
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } finally {
    if (context) {
      await context.close().catch(() => null);
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
