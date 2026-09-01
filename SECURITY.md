# Security policy

## Supported code

Security fixes are developed on the current default branch and are intended for
the latest released extension version. Older unpacked copies and third-party
repackages may not receive fixes. When reporting a problem, include the
extension version from `manifest.json`, browser name and version, and whether
the extension was loaded unpacked or installed from a store.

## Reporting a vulnerability

Please do not open a public issue with an exploit, sensitive URL, or
proof-of-concept that could bypass an active restriction.

Use GitHub's private vulnerability reporting flow:

<https://github.com/Silhouette-my/bilibili-FOCUS/security/advisories/new>

Include:

- the affected version and browser;
- the required preconditions and trust boundary;
- exact reproduction steps or a minimal proof-of-concept;
- the expected and observed behavior;
- any evidence that the issue affects data confidentiality, extension
  privileges, or more than the reporting user's own focus controls.

If private vulnerability reporting is unavailable, contact the repository owner
privately before publishing technical details. Reports will be acknowledged and
triaged on a best-effort basis; coordinated disclosure timing will be discussed
with the reporter.

## Security model

The extension treats Bilibili page content and page JavaScript as untrusted.
Policy state and privileged tab navigation belong to the background service
worker. The extension-owned blocked page is a presentation and recovery surface;
it does not trust a return URL until the background rechecks sender identity,
current tab state, effective policy, protocol, and hostname.

Packaged extension pages, the browser extension platform, and the local browser
profile are trusted. Messages that mutate policy should be authorized by
extension-page role, validated against a typed request contract, and applied by
the background rather than by page DOM.

Player shortcuts and player/search overlays are presentation features. A
Bilibili page can alter shared DOM, so those features must never be treated as
enforcement boundaries. Shortcut configuration is limited to a fixed action
catalog and physical key descriptors; it cannot provide arbitrary selectors,
scripts, or privileged extension messages.

## Product boundary and non-goals

Bilibili FOCUS is a self-control aid, not parental-control, enterprise-policy,
digital-forensics, or compliance software. It does not claim to resist a device
owner who can:

- disable or uninstall the extension;
- edit an unpacked extension, browser profile, or extension storage;
- use developer tools, another browser/profile, incognito mode without the
  extension, a mobile app, proxy, or alternate domain;
- change the operating-system clock or timezone.

The current top-level navigation policy does not promise to block Bilibili
players embedded as subframes in unrelated sites. Protecting embedded frames,
alternate delivery domains, or a hostile local administrator requires a
different threat model and may require Declarative Net Request or managed
browser policy.

## Release security

The runtime has no third-party package dependency and must not load remote
executable code. Release artifacts are produced by
`scripts/package-extension.cjs`, which:

- packages only an explicit allowlist;
- requires the complete manifest/HTML/CSS/JavaScript runtime reference graph;
- rejects missing files, unexpected runtime references, symlinks, dangerous
  filenames, inline scripts, eval-style execution, and remote resource
  references;
- uses bytewise path ordering, fixed ZIP timestamps, fixed file modes, and the
  uncompressed ZIP method for reproducible output;
- emits a SHA-256 checksum beside the ZIP.

CI runs syntax checks, unit/regression tests, release validation, deterministic
packaging, and an isolated MV3 browser smoke test. Playwright is installed only
in CI at a fixed version and is not shipped with the extension. The smoke test
fulfills every Bilibili HTTP(S) document from a local fixture, aborts other
external HTTP(S) traffic, and requires the production Bilibili request count to
remain zero.

Release ZIPs should be generated from a reviewed commit, compared with their
published SHA-256 checksum, and uploaded through the browser store's authenticated
publisher account. CI credentials must be scoped to the minimum repository and
release permissions. Workflow actions should be updated deliberately and pinned
to reviewed revisions when the release process is hardened further.

## Dependency and license changes

Adding a runtime dependency, remote service, remotely hosted asset, build-time
code generator, or broader browser permission requires security review. This
repository does not select a project license in this policy; licensing must be
decided explicitly by the project owner before a license file is added.
