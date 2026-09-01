# Permission rationale

Bilibili FOCUS follows a least-authority policy: each requested permission must
map to a current feature, and release validation rejects undeclared runtime
files and remote executable code.

## Extension permissions

### `storage`

Stores user preferences and schedule configuration, plus local runtime state
such as the active focus session, aggregate usage duration, and the effective
lock status. Settings intended to follow the user may use synchronized storage;
device/session state remains local or session-scoped.

### `tabs`

Finds already-open Bilibili tabs, reads their current or pending URL, moves a
matching top-level tab to the extension-owned blocked page, and safely restores
it after the restriction ends. The Tabs permission can expose sensitive tab
metadata in principle; the implementation limits its queries and navigation
decisions to validated Bilibili URLs and the extension's own blocked page.

Removing this permission should be reevaluated whenever the browser APIs change.
Some Tabs operations are callable with host permissions alone, but the project
must verify `pendingUrl`, filtered queries, and extension-page restoration in a
real MV3 browser before reducing the permission.

### `alarms`

Wakes the Manifest V3 service worker periodically to reconcile schedules, focus
sessions, daily usage limits, and expired restrictions. It does not create
operating-system alarms or notifications.

### `webNavigation`

Receives top-level navigation and same-document History API events. The
background uses these events to reapply policy when a Bilibili single-page app
changes routes without creating a new document. Subframe events are ignored by
the enforcement handler.

## Host permission

### `*://*.bilibili.com/*`

Allows the extension to run its focus content scripts and inspect the URL of
matching Bilibili tabs. The scheme wildcard currently covers both HTTP and HTTPS
for compatibility with existing links; authoritative URL checks reject all
other protocols and require the exact `bilibili.com` domain boundary.

This permission does not grant access to unrelated domains. Broadening it to
`<all_urls>` is not part of the current design.

## Content-script scope

- `lockShared.js`, `runtimeContracts.js`, `backgroundClient.js`, and
  `redirect.js` run on matching Bilibili documents at document start for typed
  background-policy wake-up and activity accounting. Privileged redirect
  decisions remain in the background.
- `playerShortcuts.js` is loaded with the document-start bundle but remains
  inactive outside `www.bilibili.com/video/*`. It reads synchronized bindings
  and invokes a fixed catalog of player actions; users cannot supply selectors,
  scripts, or runtime messages through this configuration.
- `playerOverlay.js` runs only on `www.bilibili.com/video/*`.
- `searchOverlay.js` and `searchOverlay.css` run only on
  `search.bilibili.com/*`.
- Content scripts use the browser's isolated JavaScript world. Player controls
  and presentation changes made to page DOM are user-experience features, not
  security boundaries.

## Permissions intentionally not requested

The extension does not request cookies, history, downloads, bookmarks,
geolocation, native messaging, clipboard, debugger, proxy, or arbitrary
`<all_urls>` access. It also does not request permission to execute remotely
downloaded code.

## Review checklist

Any pull request that changes `manifest.json` should answer all of the
following:

1. Which concrete feature needs the new authority?
2. Can an existing narrower host pattern or API provide it?
3. What browser-visible data becomes accessible?
4. Is the authority used only in the background or also exposed to content
   scripts and extension pages?
5. Which unit and real-browser tests prove the intended boundary?
