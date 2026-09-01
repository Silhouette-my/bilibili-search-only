# Privacy

Effective date: 2026-07-30

Bilibili FOCUS is a local browser extension. It does not operate a project-owned
server, send analytics or telemetry, sell data, or load remote executable code.

## Data the extension handles

The extension stores only the state needed to provide its focus features:

- feature preferences, lock rules, and appearance settings in browser
  synchronized storage;
- effective feature state, lock status, focus-session timestamps, and aggregate
  daily usage duration in local extension storage;
- the most recent activity timestamp per matching tab, used to avoid counting
  inactive time;
- a Bilibili return URL for a blocked tab in session storage so the
  tab can return to a validated destination after the restriction ends.

Chrome 102 is the minimum supported browser version, so this return URL never
falls back to persistent local storage. The background validates that it is an
HTTP(S) Bilibili URL before storing or restoring it. Return URLs can contain
path, query, and fragment data supplied by Bilibili.

The extension does not intentionally collect page bodies, video titles, search
terms as a separate dataset, cookies, passwords, account tokens, or browsing
history outside its declared Bilibili scope.

## Browser synchronization

Settings written to `chrome.storage.sync` may be synchronized by the browser
vendor through the user's signed-in browser account. That transport and its
retention are controlled by the browser vendor and the user's browser settings,
not by this project. Usage counters, active focus sessions, and blocked-tab
return state are not intentionally synchronized by the extension.

## Permissions and page access

The extension runs content scripts on matching `bilibili.com` pages and observes
top-level navigation so it can apply the selected redirect and blocking policy.
It uses the tab identifier and browser-provided URL for those decisions. See
[PERMISSIONS.md](PERMISSIONS.md) for the purpose and boundary of every requested
permission.

## Network behavior

The packaged extension contains local JavaScript, HTML, CSS, and image assets.
It does not fetch project configuration, advertisements, analytics, or code
from a remote service. Normal Bilibili pages continue to make their own network
requests; those requests are made by Bilibili, not by a project backend.

## Retention and deletion

Local and session values remain inside the browser profile until they expire,
are replaced, the extension's storage is cleared, or the extension is removed.
Synchronized settings may also remain subject to the browser vendor's sync
retention. Users can clear extension data through browser settings and can
disable browser synchronization independently.

## Scope

This notice covers the code distributed from this repository. A modified fork,
third-party repackaging, or browser vendor may behave differently. Privacy or
security concerns should be reported using the private process in
[SECURITY.md](SECURITY.md).
