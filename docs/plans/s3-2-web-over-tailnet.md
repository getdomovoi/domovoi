# S3.2 plan: the daemon serves the web app over the tailnet

Status: plan, written 2026-10-01 on `feat/s3-2-web-over-tailnet` from `origin/main` 164eb985.
Every `file:line` below was read on that commit. The owner answered section 7 on 2026-10-01
(Q286, A for each).

## What this closes

`SHIP-PLAN.md` `S3.2` has one open M1 line: over the tailnet there is no web app to reach,
because `apps/web` is served by vite on `127.0.0.1:5178` only (`apps/web/package.json`, `dev`
script). Decided 2026-09-17 and recorded as ask 4 in
`~/.agents/plans/2026-09-17-domovoi-daemon-asks.md`: the daemon serves the built web app under the
certificate the phone already trusts, as a separate artifact beside the daemon rather than
compiled in, so a web regression is not a daemon release. Ask 4 names three parts:

1. `GET /` and the bundle's static paths on the daemon's listener, from a configured directory
   (`DOMOVOI_WEB_DIR`, default beside the daemon's install), with an app CSP, cache rules that let
   a new bundle replace an old one, and a plain page when nothing is there. Plaintext on loopback
   only, as for the socket.
2. `apps/web` reads its rpc URL from `location` when served by the daemon and keeps the
   `VITE_DOMOVOI_RPC_URL` override for the dev server.
3. The daemon's own origin joins `allowedOrigins` when it serves the bundle, and the preview
   CSP's `frame-ancestors` names it, so Design review works from the served app.

This plan adds what the ask did not cover: how the bundle is checked before it is served, which
host names the listener answers to, and one existing defect that blocks Design review over the
tailnet (section 2.4).

## 1. Where the bundle lives and how the daemon finds it

### 1.1 Layout

The bundle is the output of `vite build` in `apps/web` plus one manifest file the build writes:

```text
<web dir>/
  domovoi-web.json          manifest, never served
  index.html
  manifest.webmanifest
  sw.js
  icons/...
  assets/<name>-<hash>.js|css|woff2|...
```

`domovoi-web.json` (format 1):

```json
{
  "format": 1,
  "version": "0.0.1",
  "protocolVersion": "0.8.0",
  "files": {
    "index.html": { "sha256": "<hex>", "bytes": 1234 },
    "assets/index-abc123.js": { "sha256": "<hex>", "bytes": 456789 }
  }
}
```

- `version` is the workspace version the bundle was built at. Every package shares one version
  (`CONTRIBUTING.md`, Release metadata), so this records provenance, not compatibility.
- `protocolVersion` is the protocol the bundle was compiled against. Compatibility is decided by
  it alone, with the existing admission rule: major and minor must match, patch may differ
  (`docs/protocol-version-negotiation.md`, Admission policy). A newer web bundle on the same
  protocol minor can therefore be installed beside an older daemon, which is what "versioned
  separately" buys.
- `files` is the complete allow-list of what the daemon serves. A file on disk that the manifest
  does not name is never served.
- The digests detect a partial or mixed copy. They are not authentication: they come from the same
  place as the files. Signing belongs to `S1.4`.

The manifest schema lives in `packages/protocol` as a non-wire export (`web-bundle.ts`), so the
build that writes it and the daemon that reads it share one zod schema with its tests. It is not
an RPC or notification, so `scripts/protocol-wire.mjs` records nothing new and no protocol bump
follows.

### 1.2 How the daemon finds it

- `DOMOVOI_WEB_DIR`: an absolute directory, parsed in `apps/daemon/src/config.ts` beside the other
  path settings (`parseStatePath`, used at `config.ts:71-78`). Relative paths, NUL and newlines
  are refused like the other paths.
- Default when unset: `<daemon package root>/web`, resolved from the daemon's own module URL
  (`new URL("../web/", import.meta.url)` from `dist/`). That is "beside the daemon's install" for
  the repository build (`apps/daemon/web`), the bootstrap runtime (`.runtime-*/web`,
  `docs/distribution.md:96-115`) and the desktop's runtime copy
  (`<profile>/runtime/<version>/<id>`, `apps/daemon/src/service/desktop-service.ts:81-86`). The npm
  tarball's `files` list (`apps/daemon/package.json`) does not include `web/`, so a daemon release
  never carries a bundle.
- The service keeps the setting: `service.json`'s schema is `.strict()`
  (`apps/daemon/src/service/configuration.ts:17-37`), so it gains an optional `webDirectory`, and
  `serviceEnvironment` (`configuration.ts:57-78`) maps it back to `DOMOVOI_WEB_DIR`. Without this a
  supervised daemon silently loses the setting, which is the failure ask 3 named for the profile
  directory.

### 1.3 Loading and checking

The bundle is loaded once, in `apps/daemon/src/production-daemon.ts` next to `loadTls`
(`production-daemon.ts:139`), before the listener exists, into an immutable in-memory map from
URL path to `{ bytes, contentType, etag, cacheClass }`. Per request the daemon reads nothing from
disk. Replacing the bundle takes a daemon restart (Q4, answered A).

The loader refuses the whole bundle, and the daemon serves the plain page instead, when any of
these hold:

| Check | Why |
| --- | --- |
| `domovoi-web.json` missing | state `absent`, the common case on a machine with no web app |
| manifest fails the schema, or exceeds a size bound | state `invalid` |
| `protocolVersion` major.minor differs from the daemon's | state `incompatible` |
| a listed path is not a plain relative path: empty, `.` or `..` segments, backslash, NUL, leading `/`, `//` | traversal is impossible by construction, not by a check at request time |
| a listed path collides with a daemon route: `rpc`, `healthz`, anything under `artifacts/` | a bundle cannot shadow the socket, the health probe or preview access |
| a listed extension is outside a fixed table (`.html .js .css .svg .png .ico .webmanifest .woff2`) | content type comes from the table, never from the file |
| a path component under the real root is a symlink when checked, or the leaf is not a regular file | symlink refusal; the root itself may be a symlink the owner configured, resolved once with `realpath`. What these checks prove is stated below the table |
| the real root is inside the profile directory (which holds `worktrees/`), or holds it | agent-written files must never be served as the app (section 3.4); a pathname policy, see there |
| the manifest or a listed file has more than one hard link | its other name can be anywhere on the volume, `worktrees/` included (review F3, Q297) |
| on POSIX, the root, a directory under it, the manifest or a listed file is owned by an account other than the daemon's effective uid or root, or is writable by group or others | mode bits alone do not keep another account out: an owner keeps write and chmod rights whatever the mode. Never `fs.access(W_OK)`, which answers for the daemon's account only (review F1, Q297) |
| on POSIX, a directory above the real root, up to `/`, is owned by another account, or is writable by group or others without the sticky bit | whoever can replace an ancestor can replace the root (review F1, Q297) |
| a file's size or SHA-256 differs from the manifest | partial or mismatched copy |
| file count, per-file size or total size exceeds a bound | memory bound; bounds set from a measured build with headroom, like the coverage floors |

Leaves are opened with `O_NOFOLLOW` where the platform has it and read through that descriptor, so
a symlink swapped in at the leaf during the load is refused rather than followed. Each directory
between the root and a file is checked with `lstat` before the open and after the read and must be
the same directory both times.

Stated limit (review F2, Q297): this is not link-free traversal. Every call re-resolves a pathname;
Node has no `openat2` or other lookup anchored to a checked directory handle, and `O_NOFOLLOW`
covers only the last component (Windows has neither). A directory swapped for a link and back
between two checks is not seen. With the ownership checks below, only the daemon's own account or
root can change the bundle tree, so a race by that account is a trusted-account limit. The digests
still bind every byte kept to the manifest that was parsed.

Stated limit (review F1, Q297): access control lists are not read. macOS ACLs and Windows ACLs can
grant another account rights the mode bits do not show, and on Windows neither ownership nor mode
is checked, the same stated limit as the TLS key check (`tls-material.ts:29-38`). The checks show
that the mode bits and owners give no other account write access to the bundle tree; they do not
prove that no other account can swap the app. Installing the bundle in a location only the owner
or an administrator controls is the supported contract.

### 1.4 How a missing or mismatched bundle is reported

- **At startup, on stdout**, beside `domovoid listening on <url>` (`apps/daemon/src/index.ts:295-296`):
  `domovoid web app served from <dir> (web <version>, protocol <x.y.z>)`, or
  `domovoid web app not served: <reason> at <dir>`. The path is shown here because only the owner
  reads this stream.
- **In the daemon log**, through the existing error sink, for `invalid` and `incompatible`, naming
  the first failing check and file.
- **At `/`**, a small fixed page with status 503 and `cache-control: no-store`, so a later install
  is not hidden by a cached refusal. It never names a path, a user name or a file: the page is
  unauthenticated and reachable from the whole tailnet. Copy per state, plain punctuation:
  - absent: "No web app is installed beside this Domovoi daemon. The machine's owner can install
    one; the daemon's startup output says where it looks."
  - incompatible: "The web app installed here is for protocol <a.b>, and this daemon speaks
    <c.d>. Install the web app from the same release as the daemon." (Both versions are already
    public on `/healthz`, `server.ts:2772-2776`.)
  - invalid: "The web app installed here failed its checks, so it is not served. The daemon's log
    names the file."
- Every other path answers the existing `404 {"error":"not_found"}`.

A `system.hello` fact so the desktop's Settings can show the state is a later, separate protocol
item. It is not needed for M1.

## 2. Which listener serves it

### 2.1 How the phone reaches the daemon over the tailnet today

- One listener per daemon. `start()` builds an `https` server when TLS material was loaded and an
  `http` server otherwise (`apps/daemon/src/server.ts:2765-2770`), and binds exactly
  `this.host:requestedPort` (`server.ts:2881-2884`). Default `127.0.0.1:47831`
  (`config.ts:135-141`, `config.ts:143-155`).
- A non-loopback `DOMOVOI_HOST` needs `DOMOVOI_ALLOW_REMOTE_TRANSPORT=1` and both
  `DOMOVOI_TLS_CERT_PATH` and `DOMOVOI_TLS_KEY_PATH` (`config.ts:50-64`). The material is PEM, the
  key must not be readable by others (`apps/daemon/src/tls-material.ts:25-48`), and it is loaded
  once at startup (`production-daemon.ts:139`).
- The documented tailnet setup (`apps/mobile/README.md`, "Over the tailnet") binds the machine's
  tailnet IPv4 address and serves a certificate from `tailscale cert <domain>` for the machine's
  tailnet DNS name. The phone dials the name, not the address.
- The pairing code carries `wss://<name>:<port>/rpc`, with the name read from the served
  certificate's DNS SANs (`apps/daemon/src/pairing-address.ts:30-43`, `:64-101`;
  `server.ts:2034-2041`). Wildcards and multiple names are refused there.
- `DOMOVOI_TAILNET_HOST` and `DOMOVOI_ADVERTISE_HOST` only classify advertised fleet endpoints
  (`apps/daemon/src/advertised-transports.ts:19-50`, `config.ts:82-85`); they do not change the
  bind.

### 2.2 Decision: the same listener, the same certificate

The web app is served by that one listener, under that one certificate. No second port and no
second TLS configuration. Consequences:

- Over the tailnet the app's origin is `https://<cert name>:<port>`, the same origin as
  `wss://<cert name>:<port>/rpc` and `/artifacts/...`.
- On a loopback daemon without TLS the origin is `http://127.0.0.1:<port>` (or `localhost`,
  `[::1]`). Plaintext stays loopback only, because `config.ts:57-64` already refuses a
  non-loopback listener without TLS; nothing here adds a second rule.
- Loopback serves the app too (Q3, answered A), with A14's loopback limit restated.

### 2.3 Path layout on the listener

| Path | Owner | Auth | Change |
| --- | --- | --- | --- |
| `/healthz` | existing, `server.ts:2772-2776` | none | none |
| `GET /artifacts/<id>?...` | existing, `server.ts:2778-2786`, `:5449-5548` | signed grant, HMAC (`server.ts:12655-12678`) | Host check widened, section 2.4 |
| `/rpc` WebSocket upgrade | existing, `server.ts:2792-2801` | bearer or `system.hello` | origin set gains served origins, section 3.5 |
| `GET`/`HEAD /` and each manifest path | new module | none, static only | new |
| anything else | existing 404 | | none |

Order in the request listener stays: `/healthz`, then `/artifacts/`, then the web app hook, then
the 404. The WebSocket upgrade never reaches the request listener (`ws` takes the `upgrade` event),
and a manifest cannot list `rpc`, `healthz` or `artifacts/` (section 1.3), so the three cannot
shadow each other. There is no single-page fallback: the app has no client-side routes
(`apps/web/src/main.tsx` renders one root), so an unknown path is a 404, not `index.html`.

### 2.4 Existing defect: the listener only answers to its bind address

`#acceptsHost` (`server.ts:5068-5072`) compares the request's Host with the bound host and port
through `hostAuthorityMatches` (`server.ts:12680-12697`; osnova shows `#acceptsHost` as its only
production caller). In the documented tailnet setup the bound host is the tailnet IPv4 address and
every client sends the certificate's DNS name as Host. Read from source, not run: every
`/artifacts/` request over the tailnet name answers 404 today. That blocks Design review from a
tailnet-served web app, and it looks like the reason a phone WebView render over the tailnet would
fail too (`S3.3` lists that render as unverified on a device). Slice 5 starts with a failing test
that settles it.

The fix is one shared answer to "which authorities does this listener answer to", in a new module
`apps/daemon/src/listener-authorities.ts`:

- the bound host and actual port, when the host is not a wildcard;
- `localhost` when bound to a loopback address (what `hostAuthorityMatches` already allows);
- on a TLS listener, each DNS name from `certificateHostNames` (`pairing-address.ts:30-43`), with
  the actual port. Wildcard entries are not expanded, as there;
- `DOMOVOI_ADVERTISE_HOST` and `DOMOVOI_TAILNET_HOST` with the actual port, when set.

From the same set it derives the listener's own origins (`https://<name>:<port>` on TLS,
`http://<loopback>:<port>` on plaintext loopback). The static hook, `#acceptsHost`, the origin set
and the preview `frame-ancestors` all read it, so they cannot disagree.

## 3. Security

### 3.1 What an unauthenticated request can fetch

Only the files the manifest lists, plus the fixed state page at `/`. All of it is the public web
app: compiled JavaScript, CSS, fonts, icons. No session data, no configuration, no paths. The
bundle contains no secret: `rpcUrl` comes from `location` (section 3.6), and the app reads
credentials only from the browser's own storage (`apps/web/src/credential.ts`).

Request handling, all in the new module:

- Methods: `GET` and `HEAD`. Anything else is `405` with `allow: GET, HEAD`.
- The request target must be origin-form (starts with `/`). Absolute-form or `*` is a 404.
- The path is parsed with `new URL(target, "http://domovoi.local")`, which resolves dot segments
  and `%2e%2e`, then decoded once. A decode failure, a decoded NUL, a backslash or a `%2f` is a
  404. The result is looked up in the in-memory map, so no request string ever reaches the file
  system: there is nothing to traverse.
- No directory listing exists to disable: `/assets/` is not a key, so it is a 404.
- The query string is ignored and never logged or echoed. It matters because a pairing code
  arrives as `/?code=...` (`apps/web/src/main.tsx:34-41`).
- Host must be one of the listener's authorities (section 2.4), otherwise 404. A static file is
  public, so this is not about secrecy. It refuses DNS-rebinding names on the plaintext loopback
  listener, the same reason `/artifacts/` checks Host today.
- `Range` is ignored; responses are whole files. No compression in the first slices.

### 3.2 Headers

On every app response:

```text
content-security-policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' <ws-scheme>://<authority>;
  frame-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none';
  form-action 'none'; frame-ancestors 'none'
x-content-type-options: nosniff
referrer-policy: no-referrer
x-frame-options: DENY
cross-origin-opener-policy: same-origin
cross-origin-resource-policy: same-origin
permissions-policy: camera=(), microphone=(), geolocation=()
```

- The policy is modelled on the desktop renderer's (`apps/desktop/src/main/renderer-security.ts:108-119`):
  `script-src 'self'` with no `unsafe-inline`; `style-src 'unsafe-inline'` because React writes
  style attributes. `connect-src` names `wss://<authority>` (or `ws://` on loopback) explicitly as
  well as `'self'`, because not every browser version in use matches `ws:` and `wss:` against
  `'self'`; the real-browser check in section 5.2 settles whether `'self'` alone would do. `<authority>` is the
  request's Host only after it passed the authority check, so it cannot inject a source.
- `frame-src 'self'` admits the preview iframes, which are same origin (section 3.4).
- `frame-ancestors 'none'` and `X-Frame-Options: DENY`: the app shows approval buttons, so no other
  page may frame it.
- No `Strict-Transport-Security`. HSTS binds a host name on every port, and a tailnet name may
  carry other plain HTTP services the owner runs. The certificate check already covers this
  listener.
- The state page at `/` gets `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'`.

### 3.3 Caching

| Class | Paths | Header |
| --- | --- | --- |
| entry | `index.html`, `manifest.webmanifest`, `sw.js`, `icons/*` | `cache-control: no-cache`, strong `ETag` from the manifest digest, `If-None-Match` answers 304 |
| hashed | `assets/*` (vite content-hashed names) | `cache-control: private, max-age=31536000, immutable` |
| state page, 404, 405 | | `cache-control: no-store` |

`index.html` revalidates on every load, so a new bundle reaches the next reload. Hashed assets
never go stale because a new bundle names new files. A tab left open across a daemon upgrade keeps
its old JavaScript until reloaded; if the protocol minor changed, the existing mismatch copy tells
the person to reload (`apps/web/src/daemon-pairing.ts:126-131`). `apps/web/public/sw.js` has no
`fetch` listener, so it caches nothing; slice 2 pins that with a test, because a caching service
worker at scope `/` would also sit over `/artifacts/` on this origin.

### 3.4 One origin for the app and the previews

Preview documents are agent-written and therefore untrusted. Today they are on the daemon's origin
(`:47831`) and the web app is on vite's (`:5178`), so they never share an origin. Served by the
daemon, they do. What keeps them apart is the CSP `sandbox` directive on every `/artifacts/`
response (`server.ts:5521-5523`): `sandbox allow-scripts` for previews and bare `sandbox` for
derived documents, never `allow-same-origin`, so each document runs in an opaque origin. It cannot
read the app's `sessionStorage` (where the credential lives, `main.tsx:54`) or `localStorage`,
cannot register a service worker, and its WebSocket `Origin` is `null`, which the allow-list does
not admit. The shell's iframes also carry `sandbox="allow-scripts"`
(`packages/ui/src/artifact-dock.tsx:743`, `:968`). An artifact is served as `text/html`, which a
browser refuses as a service worker script.

That sandbox becomes load-bearing for the app's origin, not only for the preview. Slice 5 adds a
test that every `/artifacts/` response, for every purpose and error path that returns a document,
carries a `sandbox` directive without `allow-same-origin`. The alternative, a separate port for
the app, was Q1's option B; the owner chose the shared origin (A).

The web root must also never hold agent output. It is configured by the owner, outside the
profile's `worktrees/`. The loader refuses a root whose real path overlaps the profile directory's
(either inside the other), and any manifest or listed file with a second hard link (`nlink` above
1), since that name can sit anywhere on the volume. This is a pathname policy, not physical
isolation (review F3, Q297): a bind mount or another alias of the profile that is not a symbolic
link shows profile files under an unrelated path and is not detected. A trusted install location
is the supported contract.

### 3.5 Origin allow-list changes, and why

The `/rpc` admission rule is `!origin || allowedOrigins.has(origin) || namesThisDaemon(origin, req)`
(`server.ts:2792-2794`). `namesThisDaemon` admits an Origin whose host equals the request's Host,
on encrypted sockets only (`server.ts:559-583`); the default list is the vite origins, `file://`
and `domovoi-app://desktop` (`server.ts:1879-1881`).

- **Tailnet, TLS:** the served page's Origin is `https://<name>:<port>` and its Host is
  `<name>:<port>`, so `namesThisDaemon` already admits it. No change is needed for the socket.
- **Loopback, plaintext:** the served page's Origin is `http://127.0.0.1:<port>`, which is refused
  today on purpose (`apps/daemon/src/socket-origin.test.ts`, "refuses an origin that names this
  daemon"), because over plaintext a rebound name can make Origin and Host agree. The change admits
  only the listener's literal loopback origins (`http://127.0.0.1:<port>`,
  `http://localhost:<port>`, `http://[::1]:<port>` as bound), and only while a bundle is loaded. A
  rebinding page carries its own host name in Origin and cannot claim a literal loopback origin,
  so the existing refusal and its test stay as they are.
- **Preview `frame-ancestors`:** built from `allowedOrigins` (`frameAncestorsFor`,
  `server.ts:12607-12622`, used at `:5522`). On a TLS listener the served origin is not in that
  set, because admission came from `namesThisDaemon`, so a browser would refuse to frame previews
  in the served app. The listener's own origins (section 2.4) are added to the set after
  `listen`, when the actual port is known, which fixes both the loopback admission and the
  `frame-ancestors` list in one place. Explicit origins rather than `'self'`: the preview document
  is sandboxed into an opaque origin, and what `'self'` then means in `frame-ancestors` is not
  something to rely on without a browser test.

This is ask 4's "allowedOrigins gains it by construction rather than by list": nothing new is
configured, and `DOMOVOI_ALLOWED_ORIGINS` keeps working as today.

### 3.6 Pairing and authentication over the same origin

No new pairing flow. The served app uses the existing one:

- The machine shows a web code (desktop Settings, Phone and tablet; or
  `domovoid pair --client web --label <label>`). The owner picks the access level when the code is
  issued (`device.issueCode` `clientAccess`, `server.ts:7340-7356`).
- The page spends it with `device.redeemCode` on a socket that sends no greeting first
  (`apps/web/src/daemon-pairing.ts:64-95`), keeps only the returned device credential in
  `sessionStorage`, and greets with it from then on (`apps/web/src/credential.ts`).
- `rpcUrl` comes from the page's own location: `wss://<host>/rpc` on `https:`, `ws://<host>/rpc` on
  `http:` (slice 2). Today it is the build-time `VITE_DOMOVOI_RPC_URL` or
  `ws://127.0.0.1:47831/rpc` (`main.tsx:21`).

Audit finding A14 (2026-09-22, P3, deferred as a stated limit by the 2026-09-25 ruling) is that the
web client sends its credential to whatever answers on `127.0.0.1:47831`, with no owner proof like
the desktop's (`apps/daemon/src/local-daemon.ts` nonce and proof). What changes:

- **Over the tailnet it is closed for the served app.** The page and its socket share one origin,
  and the browser verified the certificate for that name before the page loaded. A listener that
  cannot present that certificate never serves the page and never receives the credential.
- **On loopback plaintext it stands, in a different shape.** Another local account that binds the
  port while the daemon is down can now serve the page itself, not only answer the socket, so it
  could also ask for a code. The exposure is the same port and the same accounts as A14 today.
  The plan restates A14 in the daemon README rather than claiming a fix.

The pasted root-bearer path (`pairBrowserDevice`, `daemon-pairing.ts:149-170`) moves the daemon's
root credential into a browser. On a page served to another machine that sends the root
credential off the execution machine, against the architecture rule that secrets stay there. Q5,
answered A: off loopback the served app offers code pairing only (slice 6).

A web credential with `full` access is a full client: it can answer gates and, per ruling Q67, grant
repository trust (`server.ts:2087-2104`). Served over the tailnet, that client can be on another
machine. This is the point of `S3.2`, and the owner already limits it per code with
`clientAccess`. The README states it in those words.

### 3.7 What does not change

- No new RPC, no wire change, no protocol bump.
- TLS rules: unchanged, `config.ts:57-64`.
- `/healthz`, `/artifacts/` signing and expiry, and `/rpc` authentication: unchanged except the
  Host and origin sets above.
- Certificate renewal: the certificate is read once at startup (`production-daemon.ts:139`). A
  renewed `tailscale cert` needs a daemon restart, as it does for the phone today.

## 4. `server.ts` versus new modules

Two open pull requests change `apps/daemon/src/server.ts` heavily (#691, approvals answered
elsewhere; #688, trusted git filters). Their hunks, read from `gh pr diff` on 2026-10-01, do not
touch the request listener (`server.ts:2765-2790`), `#acceptsHost` (`:5068-5072`) or
`#serveArtifact` (`:5449-5548`). This plan keeps `server.ts` to these edits:

| Edit in `server.ts` | Lines today | Slice |
| --- | --- | --- |
| `import` of the hook and the authority helper | top | 4 |
| `DaemonServerOptions.webApp?: LoadedWebApp` | beside `webAppUrl`, `:1418-1419` | 4 |
| one private field set in the constructor | near `:1878` | 4 |
| one hook line in the request listener, before the final 404 | `:2786-2788` | 4 |
| after `listen`, add the listener's own origins to the origin set | `:2885` | 5 |
| `#acceptsHost` body delegates to `listener-authorities.ts` | `:5068-5072` | 5 |

New modules, each with its own test file:

- `packages/protocol/src/web-bundle.ts`: manifest schema, path and extension rules.
- `apps/daemon/src/web-app-bundle.ts`: resolve the directory, load, check, report a state.
- `apps/daemon/src/web-app-http.ts`: request handling, headers, CSP, caching, the state page.
- `apps/daemon/src/listener-authorities.ts`: authorities and origins of this listener.
- `apps/web/src/rpc-url.ts`: rpc URL from location or env, so `main.tsx` (excluded from coverage,
  `apps/web/vite.config.ts:19`) stays a one-line call.
- `apps/web/web-bundle-manifest.ts`: the vite plugin that writes `domovoi-web.json` after the build.

Touched outside `server.ts`: `config.ts` (`DOMOVOI_WEB_DIR`), `production-daemon.ts` (load and pass
the bundle), `index.ts` (help text and the startup line), `service/configuration.ts`
(`webDirectory`), `apps/web/src/main.tsx`, `apps/web/vite.config.ts`, `apps/daemon/README.md`,
`apps/mobile/README.md` (tailnet section), `docs/clean-machine-setup.md`.

Ownership per `docs/working-rules.md`: `apps/daemon/src/**` and `packages/protocol/src/**` are
Codex's; `apps/web/**` and `scripts/**` are Claude Code's. Slices are cut along that line, protocol
first.

## 5. Tests

### 5.1 Without a real tailnet

All daemon tests use temporary directories (`removeScratchDirectories`, as in
`socket-origin.test.ts`) and `DomovoiDaemon` on `port: 0` with `statePath: ":memory:"`.

| Property | Test |
| --- | --- |
| manifest schema, path and extension rules | `packages/protocol/src/web-bundle.test.ts`: dot segments, `%2e`, backslash, NUL, absolute, `//`, reserved names, unknown extension, oversized maps |
| bundle refusal | `web-app-bundle.test.ts` on temp dirs: missing manifest (`absent`); protocol minor differs (`incompatible`); digest and size mismatch; listed file missing; symlink as leaf; symlink as an intermediate directory; FIFO as leaf; root inside the profile directory; group-writable root and file (POSIX only, `skipIf(win32)`); bounds exceeded. Root given as a symlink to a valid bundle is accepted |
| symlink swapped during load | inject the file-system seam to replace a leaf between `lstat` and `open`; assert refusal, not a followed link |
| request handling | `web-app-http.test.ts` against a bare `node:http` server on `127.0.0.1:0`: `GET /` serves `index.html`; `HEAD` has headers and no body; `POST` is 405; `/assets/` is 404; `/../domovoi-web.json`, `/%2e%2e/`, `/a%2fb`, `/%00`, absolute-form target all 404; `domovoi-web.json` is never served; unknown Host is 404; query string is not in any response or log |
| headers | exact CSP string per scheme, `nosniff`, `frame-ancestors 'none'`, `X-Frame-Options`, cache class per path, `ETag` and 304 |
| state page | each state's copy, 503, `no-store`, and no path in the body |
| coexistence | `DomovoiDaemon` with a bundle: `/healthz` unchanged, `/rpc` upgrade and hello unchanged, an authorized `/artifacts/` URL still serves with its sandbox CSP, unknown paths still `404 {"error":"not_found"}` |
| loopback origin | with a bundle, `http://127.0.0.1:<port>` opens `/rpc`; without one it is refused; `http://evil.example` and the existing rebinding case stay refused (extends `socket-origin.test.ts`) |
| tailnet name, without a tailnet | TLS listener on `127.0.0.1` with a certificate whose SAN is `DNS:studio.example.ts.net`, generated by `openssl` in a temp dir (`skipIf` no openssl, as `socket-origin.test.ts` does) or committed as test data next to `test-fixtures/local-owner-tls`. Client connects to `127.0.0.1` with `servername` and `Host: studio.example.ts.net:<port>`, trusting that certificate: app served; `/rpc` with `Origin: https://studio.example.ts.net:<port>` admitted; `/artifacts/` with that Host served (fails first, section 2.4); preview CSP `frame-ancestors` contains that origin; `Host: 127.0.0.2:<port>` refused |
| sandbox is load-bearing | every document-returning `/artifacts/` path has `sandbox` and no `allow-same-origin` |
| service setting | `service/configuration.test.ts`: `webDirectory` round-trips through `serializeServiceConfiguration` and `serviceEnvironment` |
| web rpc URL | `apps/web/src/rpc-url.test.ts`: `https:` gives `wss://host:port/rpc`, `http:` gives `ws:`, env override wins, dev default unchanged; keeps `apps/web` at its 100 percent floors |
| build writes the manifest | plugin test on a fixture `dist/`: every emitted file listed with the right digest, `domovoi-web.json` not listed, `protocolVersion` equals the protocol package's |
| `sw.js` caches nothing | test that `apps/web/public/sw.js` registers no `fetch` listener |

### 5.2 In a real browser on loopback

Source and unit tests cannot show that a browser accepts the CSP. Run before the tailnet check, the
way the 2026-09-17 checks ran (headless Brave over CDP, a daemon from the branch on an isolated
`DOMOVOI_PROFILE_DIR`, never `~/.domovoi`): open `http://127.0.0.1:<port>/`, read the console for CSP
violations, pair with a web code, open a project, open a preview in Design review and annotate it.
Repeat over TLS on loopback with a test certificate trusted for the run.

### 5.3 Only a real tailnet can prove (manual check for the owner)

1. From a second machine's browser and from the phone's Safari, open
   `https://<machine>.<tailnet>.ts.net:<port>/`. The certificate is trusted with no warning.
2. Pair with a web code shown on the machine. The page connects without any URL typed in.
3. Open a project, send a turn, answer a gate. Open a preview in Design review and annotate it.
4. Negative checks: `http://` to the port fails; the tailnet IP literal in the URL gets a
   certificate error; a page on another origin cannot open the socket.
5. Add to Home Screen on the phone, reopen, and confirm it pairs again (`sessionStorage` is per tab).
6. Record date, daemon sha, bundle version, browsers, and any CSP console output in the `S3.2`
   follow-up that ticks the line.

What this covers that nothing above can: MagicDNS resolution, the Tailscale-issued certificate
chain as each browser trusts it, tailnet ACL reachability, and mobile Safari's handling of the CSP,
the WebSocket and the service worker on that origin.

## 6. Slices

Each is one pull request, test first, with `pnpm typecheck`, `pnpm test`, `pnpm build` and
`pnpm lint` before review. Daemon slices carry a changeset; the plan does not.

1. **Bundle contract and loader** (Codex). `packages/protocol/src/web-bundle.ts` and test, its
   export, `apps/daemon/src/web-app-bundle.ts` and test, changeset. Pure modules: nothing serves
   yet and `server.ts` is untouched.
2. **Web build writes the manifest; rpc URL from location** (Claude Code). The vite plugin and its
   test, `apps/web/vite.config.ts`, `apps/web/src/rpc-url.ts` and test, `main.tsx`, the `sw.js` test,
   changeset. Measures the real bundle and proposes the loader's bounds.
3. **HTTP module** (Codex). `apps/daemon/src/web-app-http.ts` and test against a bare `node:http`
   server. Still no `server.ts` change.
4. **Wire it in** (Codex). `DOMOVOI_WEB_DIR` in `config.ts`, default resolution and loading in
   `production-daemon.ts`, the startup line and help in `index.ts`, `webDirectory` in
   `service/configuration.ts`, the `server.ts` option, field and hook, the loopback origin
   admission, coexistence tests, README rows, changeset. After this the app is served on loopback.
5. **Listener authorities: tailnet names, previews, artifacts** (Codex). `listener-authorities.ts`;
   `#acceptsHost` delegates to it; the listener's own origins join the origin set after `listen`,
   which updates preview `frame-ancestors`; the TLS test certificate tests; the sandbox test. The
   section 2.4 test is written first and must fail on `main`. After this the app works over the
   tailnet, and phone previews over the tailnet name may start working too.
6. **Pairing copy off loopback** (Claude Code), per Q5 (answered A): the served app offers code
   pairing only when its origin is not loopback.
7. **Packaging and documents** (Claude Code for `scripts/`, the daemon owner for README). A
   `domovoi-web-<version>.tar.gz` in `scripts/release-artifacts.mjs` with its line in `SHA256SUMS`;
   install steps in `docs/clean-machine-setup.md` and the tailnet section of `apps/mobile/README.md`;
   A14 restated for the loopback case.
8. **Checks** (owner and Claude Code). Section 5.2 run, then section 5.3 by the owner, then a
   follow-up that ticks the `S3.2` line citing the squash shas.

A default `webAppUrl` in `device.issueCode` (the served origin when the certificate names exactly
one host and `DOMOVOI_WEB_APP_URL` is unset, `server.ts:7353`) would let the pairing card offer the
browser link with no setting. It is small and reversible and can follow slice 5; it is not needed
for M1.

## 7. Owner answers

The owner answered all six on 2026-10-01 as Q286: A for each. The options are kept as asked, with
the answer under each.

- **Q1. One origin for the app and the previews?** (A) Same origin; the CSP sandbox on every
  artifact response keeps previews in an opaque origin, pinned by a test. (B) Serve the app on a
  second port, so previews never share its origin; costs a second listener, a second advertised
  address and a second origin in every allow-list.
  Answer: A, fetzy 2026-10-01, Q286. The sandbox test lands in slice 5.
- **Q2. When is the app served?** (A) Whenever a valid bundle is at `DOMOVOI_WEB_DIR` or the
  default path beside the install, with the state page at `/` otherwise; this is the 2026-09-17
  shape. (B) Only when `DOMOVOI_WEB_DIR` is set; `/` stays a 404 otherwise.
  Answer: A, fetzy 2026-10-01, Q286.
- **Q3. Serve on a plaintext loopback listener too?** (A) Yes, the same rule as the socket, with
  A14's loopback limit restated. (B) TLS listeners only; loopback keeps the vite dev server.
  Answer: A, fetzy 2026-10-01, Q286.
- **Q4. Replacing a bundle.** (A) Load once at start; a new bundle takes a daemon restart. (B)
  Reload when the manifest file changes, swapping the map atomically.
  Answer: A, fetzy 2026-10-01, Q286. B can follow when `S1.4` gives the web bundle its own update
  path.
- **Q5. Pasting the root credential into a page served to another machine.** (A) Off loopback the
  served app offers code pairing only. (B) Keep both paths everywhere.
  Answer: A, fetzy 2026-10-01, Q286. A daemon-side refusal of the root credential from non-loopback
  peers would also affect the CLI over the tailnet, so it stays a separate question.
- **Q6. Does the desktop app ship the bundle?** (A) Not in M1: the bundle is a release artifact the
  owner places, documented in clean-machine setup. (B) The desktop packs it beside its daemon
  runtime (`apps/desktop/electron-builder.yml` `extraResources`) so a desktop-installed service
  serves it with no step.
  Answer: A, fetzy 2026-10-01, Q286. B can follow with `S1.4`.
