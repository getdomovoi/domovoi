# @getdomovoi/desktop

## 0.1.0-alpha.0

### Minor Changes

- 9dc6a6f: Desktop now builds its daemon through the shared production factory instead
  of a hand-assembled server with a random per-launch token. The daemon keeps a
  persisted credential and machine identity across launches, so paired devices
  keep working after Desktop restarts, and the renderer connects to the URL and
  token of the daemon that was actually started rather than a fixed address. The
  launch smoke no longer requests daemon credentials and fails if a daemon state
  directory appears during the packaging test.
- 6378492: The desktop keeps each daemon's relay identity pin in a private main-process file under userData, replaced whole and synced to disk on every swap; the renderer reads one machine's pin by key and asks the main process to compare and swap it over the bridge, and never sees the path. A damaged file or one written by a newer desktop is refused, not emptied.

### Patch Changes

- 0a999df: Settings gains About this build: the daemon's version and source commit, that this build is not signed and does not update itself, and the release page where new versions come from. The desktop opens that one fixed address in the browser; a browser tab links it.
- 3703350: Generate the app icons and the splash from the mark instead of shipping a hand-made tile.
  
  The shipped tile carried an amber radial glow and the full mark at roughly 40 percent of the
  tile. `scripts/brand-icons.mjs` now renders every asset from
  `design/assets/mark-reduced.svg` and `design/assets/mark.svg` with a local Chromium that cannot
  reach the network. Colours come from `apps/mobile/src/theme/tokens.generated.js`, so the artwork
  and the phone read one palette.
  
  iOS, Android, splash and favicon follow the root file "Domovoi App Icon.dc.html" in Claude Design
  project a3b4404e-4d0c-451e-8dd2-203116a76c06, read 2026-09-25, candidate "ink", the file's
  default. The icon is the reduced mark at 60 percent of the tile in `--primary` on `--card`, a
  full-bleed square with no baked radius because the OS applies its own mask, and no alpha. The
  Android adaptive foreground is the glyph on transparency, inset for the mask, with the ground as
  a flat colour in the config. The splash is the full mark at 76pt in `--primary` on `--background`
  for each theme, with no wordmark. The favicon is the reduced mark at 48px on the same ground.
  
  macOS does not mask app icons, and the App Icon file does not cover it. The desktop build for
  macOS therefore uses the brand handoff's macOS rule: the same ink tile as a squircle with a 22
  percent radius on Apple's 824 of 1024 grid. Windows and Linux keep the full-bleed square. The web
  app icons are generated from the same script with the same ink ground.
  
  The mobile app had no icon or splash configured before this change.
- 711bee5: Settings opens with Daemon on this machine: whether this app, the installed login service or another window holds it, what quitting does, and what installing the service writes on this platform. Install and Remove are drawn locked with the command that does the job beside them.
- b7f7c95: The switch to or from the login service is now held by the daemon itself. `system.serviceHandoffFence` (loopback, daemon credential only) answers the same refusal as the window's check, or, when nothing runs, no dispatch is in flight and no gate waits, admits no new turn until the connection that took it closes. The desktop takes it right before it stops the daemon inside the app or removes the service, so a turn that starts after the first check makes the switch wait instead of being stopped.
  
  Staging the shipped runtime refuses an app version that is not one release version, a `~/.domovoi` or `~/.domovoi/runtime` that is a link, a shipped part that is not a regular file, and a link that leads outside the shipped runtime, all before any byte is copied. Links inside the runtime are copied as they are. An earlier copy of the same version is moved aside and put back if the new copy cannot be renamed into place.
  
  After a failed install or removal the desktop reads the service back and reports it, along with the daemon it reaches afterwards, including one this app did not start. Settings no longer says nothing was installed or removed unless the read-back shows it.
- 279349c: The desktop can install the daemon as a login service from Settings and remove it again. The app copies the runtime it ships under the profile, asks the daemon's own installer to register the service pointing at that copy, and only then stops its in-app daemon and attaches to the service. The switch refuses while a turn runs or a gate waits and names the sessions; a runtime the app does not ship is reported without touching anything.
  
  Install and Remove both wait while a turn runs or a gate waits. The desktop main process checks this too, before anything is stopped: it reads the workspace from its own daemon (`readLocalServiceHandoffRefusal` in `@getdomovoi/daemon`) and applies the same check the window uses (`serviceHandoffRefusal` in `@getdomovoi/protocol`). A workspace it cannot read also makes the switch wait. While the service takes over the profile or gives it back, a window reconnect waits for the handoff instead of starting a daemon inside the app. The runtime copy is made in a fresh directory and renamed into place, so no file from an earlier copy of the same version survives. Settings says when the service was installed but this window could not reach it, when the daemon inside the app stopped and did not start again, and what to run when a removal leaves the profile owner unresolved. A daemon running outside the app is drawn as the installed service, with Remove available, only when the desktop reads the service as installed from the service manager.
- 4a32392: Update production dependencies: the Claude, Kilo and OpenCode provider SDKs in the daemon; Electron 44.2.0 in the desktop; React 19.2.8, Lucide 1.42.0 and react-resizable-panels 4.12.4 in the shared ui and the clients. Development tooling moves with them (vitest 5, shadcn 4.21). The phone follows its Expo SDK: expo 57.0.22, reanimated 4.5.1 and worklets 0.10.1 as the SDK resolves them, jest held at 29 because jest-expo 57 expects it, and a deps:check that refuses drift from the installed SDK.
- ee3fe90: Refuse Fleet routes whose normalized hostname cannot name one exact CSP source.
  URL-valid semicolons and commas, including percent-encoded forms, could previously
  authorize a different hostname when Chromium parsed the worker policy. These routes
  now fail before a ticket is issued, rather than escaping or broadening the policy.
  
  Use a normal DNS hostname or IPv4 route when admission reports that no client route
  is available. No protocol change or re-pairing is required. Existing exact origins,
  ports and URL-normalized internationalized names retain their behavior.
- cb09b27: Ship license notices with every desktop build. `THIRD_PARTY_NOTICES.txt` in the resources
  directory names each bundled package with its declared license and the license and notice files it
  publishes, including the OFL-1.1 text of the two renderer fonts. macOS builds now also carry
  Electron's `LICENSE.electron.txt` and `LICENSES.chromium.html`, which Linux and Windows builds
  already kept beside the executable. Packaging stops when Electron's notice files are missing, and
  the license audit now covers the desktop app's graph and Electron as well as the npm packages.
- 92ca11f: Desktop quit no longer reports a bounded daemon release as a clean shutdown.
  When the ten second release bound wins the race, the lifecycle now reports a
  `DesktopDaemonReleaseTimeoutError` naming the pending release and the bound it
  outlived, so the failure reaches the main-process error sink. Quitting still
  proceeds without waiting for a release that will not settle, and a release that
  settles inside the bound reports nothing.
- 04307c2: Desktop builds no longer copy the renderer's packages into `app.asar` as unused `node_modules`.
  The UI, React and React DOM are development dependencies of the desktop app: vite already inlines
  them and every package they use into the renderer bundle, and the main process and the preload load
  none of them. The package list electron-builder's pnpm collector gives for the app drops from 304
  to 150, with `lucide-react` and `@xterm/xterm` among those removed. `THIRD_PARTY_NOTICES.txt`
  still names every package the renderer bundle contains, including the OFL-1.1 text of the two
  renderer fonts, because the notices read the UI's own graph.
- 3eaa05e: On macOS the titlebar content starts past the window buttons by an inset derived from where the desktop placed them, so the mark no longer lands on the green button. Windows and Linux get no inset.
- 796f353: Let the development renderer load under its own content security policy.
  
  The renderer policy ends `script-src 'self'`, which blocks every inline script.
  Vite serves the react-refresh preamble as an inline module script, so the
  development page failed with "@vitejs/plugin-react can't detect preamble", left
  `#root` empty, and showed the window's background colour and nothing else.
  
  Before the document is asked for, the main process now reads the development
  page, hashes the inline scripts it actually carries, and names those hashes in
  `script-src`. There is no `'unsafe-inline'` and no pinned preamble text, so a
  change to the plugin's preamble changes the hash rather than breaking the load.
  
  The packaged application is unchanged. It serves its own HTML through the
  `domovoi-app` protocol, that HTML carries no inline script, and the policy stays
  `script-src 'self'` there.
- 796f353: Tell the development daemon which origin its renderer is served from.
  
  The daemon's default trusted origin list names the packaged app and port 5178.
  Vite serves the desktop renderer on its own port, so the renderer's first
  WebSocket was refused and the window reported "Cannot reach ws://127.0.0.1:.../rpc".
  
  The desktop already resolves its renderer target before the first acquisition,
  so it now derives `DOMOVOI_ALLOWED_ORIGINS` from that target when the target is
  a development URL. It names one origin, the one the renderer is actually served
  from, whatever port Vite took. A packaged app is untouched, and an operator who
  set the list keeps it.
- a5fde27: `publishFileDurably(staging, path)` renames a flushed staging file into place and flushes its directory, so the rename survives power loss on POSIX. The desktop's relay pin file publishes through it.
- 3545df6: Update Electron from 44.2.0 to 44.4.5. This brings backported upstream fixes, including security
  fixes, that Electron shipped since 44.2.0: Chromium 152.0.7977.130 and backported fixes from
  ANGLE, Chromium, Dawn, PDFium, Skia and V8. It also moves the embedded Node.js from 24.20.0 to
  24.21.0.
- 50510c7: Desktop no longer reports every in-app daemon startup failure as an invalid profile. `acquireLocalDaemon` names three causes the owner can act on: `port-in-use` when another program holds the daemon's port, `state-locked` when another process holds the profile's state database (SQLite busy or locked), and `identity-mismatch` when the stored workspace belongs to another machine identity. Other failures keep `profile-invalid`. Every startup failure is now written to the error sink with its redacted cause, so Desktop's log keeps it. A port already in use now refuses at once instead of waiting out the startup deadline, because the WebSocket server's copy of the listen error no longer throws before `start()` can reject, and stopping a daemon whose listener never started no longer fails, so the profile lease is released and the next attempt in the same process can start. A Desktop owner record left `stopping` by a Desktop that quit before its daemon finished stopping is retired when the next launch holds the profile lease, so that launch starts instead of being refused as unreachable. After the daemon is listening, a later error from its WebSocket server is written to the error sink instead of being dropped.
- 35a0cc6: Run the person's own installed `claude` for Claude Code sessions. The daemon finds `claude` on the
  tool PATH, the executable provider readiness already reports, and passes that path to the Claude
  Agent SDK instead of letting the SDK start its own bundled agent binary. Without `claude`
  installed, model discovery and new or resumed Claude Code sessions fail with "Claude Code is not
  installed" and the SDK is never called.
  
  The desktop app no longer packages the SDK's per-platform `@anthropic-ai/claude-agent-sdk-*`
  packages, so it carries no copy of the agent binary and packaging never re-signs one. It still
  bundles the SDK's JavaScript library, which the daemon imports.
- 45e152d: Settings gains Phone and tablet: a pairing card that shows the daemon's own pairing code for a phone, tablet or browser, with its QR, address and 180 second countdown, and says why no code can be shown when the daemon answers on loopback only or reports no certificate. The shared list of what a paired device can do now carries six lines, including that gates reach a device only while its app is open, and the terminal line is the short one.
- ee3fe90: Add separate, kind-bound remote client grants and Fleet client admission. A machine pairing remains daemon-to-daemon authority, not permission for a desktop or browser to control the target.
  
  Operators issue a separate client credential on the target with `domovoid pair --client desktop --label "My desktop"`, then choose Authorize this client in Fleet. Use, Terminal and inventory reads require the target identity and client receipt to verify. Desktop main verifies each enrolled route through the home daemon and grants only that exact socket origin. Update both daemons and the client before using these additive calls. The wire remains 0.5.0, existing pairings remain valid and no re-pair is required.
  
  Client credentials stay only in app memory. Closing the app or removing local access does not revoke the remote grant; revoke the device in the target's Devices list. Remote Desktop preview frames remain unavailable until they have a separate verified path. This does not enable a hosted relay or expose the daemon's machine keychain to the client.
  
  Desktop serves its bundle from an explicit app origin so response CSP is enforced. Existing development profiles may need appearance, layout and first-run preferences selected again because old file-origin browser storage is not migrated. The daemon profile and its canonical sessions are unchanged.
  
  If `DOMOVOI_ALLOWED_ORIGINS` is explicitly configured, add the exact `domovoi-app://desktop` origin and restart that daemon. The default configuration already includes it; custom lists are not silently widened.
- 43f512c: Update the desktop to Electron 44.1.0 with newer Chromium and Node runtimes.
- 8a77b07: Stop two tests failing on a loaded CI worker.
  
  `annotation-visual-context.test.ts` waited for a crop file through 100 event-loop
  turns. Turns cost microseconds and the write costs a disk, so a busy Ubuntu
  worker exhausted them and the test reported a timeout on a crop that was on its
  way. It now waits through `waitForDaemon`, the measured budget the rest of the
  daemon observations use.
  
  The desktop signing tests ran under `node --test`, which forks a child and reads
  its results back over a serialized protocol. Twice that stream was reported
  corrupt, as "Unable to deserialize cloned data due to invalid or unsupported
  version", after every assertion in the file had already passed. The file now runs
  in process, where `node:test` needs no child and no protocol between them, and a
  failing assertion still exits non-zero.
  
  The corruption itself is unreproduced here: it needs the Node 22 that CI uses,
  and this machine runs Node 26. This removes the channel rather than claiming a
  diagnosis of it.
- Updated dependencies [f7c19b5]
- Updated dependencies [d9add3d]
- Updated dependencies [d7dacad]
- Updated dependencies [1dd9ee7]
- Updated dependencies [5ee1825]
- Updated dependencies [07e8696]
- Updated dependencies [08e4f00]
- Updated dependencies [d76b0e0]
- Updated dependencies [19a5fe5]
- Updated dependencies [76172f8]
- Updated dependencies [dcb26a7]
- Updated dependencies [f9cf76b]
- Updated dependencies [1204d6c]
- Updated dependencies [7888b2c]
- Updated dependencies [5b2daa7]
- Updated dependencies [0ec38aa]
- Updated dependencies [b2f72a9]
- Updated dependencies [0160350]
- Updated dependencies [75f2f28]
- Updated dependencies [e9d4e37]
- Updated dependencies [002c74a]
- Updated dependencies [800de19]
- Updated dependencies [1dd9ee7]
- Updated dependencies [1524651]
- Updated dependencies [4884900]
- Updated dependencies [5ffc29f]
- Updated dependencies [1bc7464]
- Updated dependencies [3d92b6f]
- Updated dependencies [d02514f]
- Updated dependencies [4f57611]
- Updated dependencies [8ab80dc]
- Updated dependencies [48dc434]
- Updated dependencies [51de722]
- Updated dependencies [2f29554]
- Updated dependencies [5a14da7]
- Updated dependencies [0cc804a]
- Updated dependencies [31eb8b1]
- Updated dependencies [95810a1]
- Updated dependencies [097e00d]
- Updated dependencies [4a8b80a]
- Updated dependencies [0b293f4]
- Updated dependencies [9dbde2e]
- Updated dependencies [f0d3c74]
- Updated dependencies [c943176]
- Updated dependencies [b772543]
- Updated dependencies [e37020a]
- Updated dependencies [4cacf7a]
- Updated dependencies [a6d18ac]
- Updated dependencies [0bc3530]
- Updated dependencies [aa0c05d]
- Updated dependencies [f303874]
- Updated dependencies [961e74e]
- Updated dependencies [ab18590]
- Updated dependencies [19a5fe5]
- Updated dependencies [707e0ab]
- Updated dependencies [bb0bdf5]
- Updated dependencies [6b22745]
- Updated dependencies [f058294]
- Updated dependencies [9828935]
- Updated dependencies [c746eab]
- Updated dependencies [6f52997]
- Updated dependencies [19a5fe5]
- Updated dependencies [9dc6a6f]
- Updated dependencies [d72874e]
- Updated dependencies [fce431f]
- Updated dependencies [051e889]
- Updated dependencies [0080f60]
- Updated dependencies [14527f0]
- Updated dependencies [962980a]
- Updated dependencies [a4200fb]
- Updated dependencies [b7f7c95]
- Updated dependencies [279349c]
- Updated dependencies [77c2829]
- Updated dependencies [d4228ee]
- Updated dependencies [19a5fe5]
- Updated dependencies [cbf620b]
- Updated dependencies [2cd8a1b]
- Updated dependencies [ef91479]
- Updated dependencies [fb78eda]
- Updated dependencies [51a7431]
- Updated dependencies [4a32392]
- Updated dependencies [0fed2e6]
- Updated dependencies [3d67826]
- Updated dependencies [df4716f]
- Updated dependencies [a5fde27]
- Updated dependencies [5fea2c8]
- Updated dependencies [91b1e15]
- Updated dependencies [0d60644]
- Updated dependencies [65da87b]
- Updated dependencies [18f6543]
- Updated dependencies [ca22e9e]
- Updated dependencies [9e1e9c5]
- Updated dependencies [4359bcf]
- Updated dependencies [4bf0e8e]
- Updated dependencies [eb8040e]
- Updated dependencies [6b30c51]
- Updated dependencies [9d94da3]
- Updated dependencies [12f0a90]
- Updated dependencies [4712ef9]
- Updated dependencies [972e6c7]
- Updated dependencies [5da6a5a]
- Updated dependencies [96c757b]
- Updated dependencies [d47bfc6]
- Updated dependencies [c3229d9]
- Updated dependencies [6b0e4fd]
- Updated dependencies [7815f0a]
- Updated dependencies [4aa3ef7]
- Updated dependencies [ccc14a7]
- Updated dependencies [1204d6c]
- Updated dependencies [5ae04b0]
- Updated dependencies [b67435e]
- Updated dependencies [aba51b2]
- Updated dependencies [50510c7]
- Updated dependencies [3e2c556]
- Updated dependencies [e199de4]
- Updated dependencies [ccc14a7]
- Updated dependencies [b5b1aa9]
- Updated dependencies [7bc1d86]
- Updated dependencies [0a7be6d]
- Updated dependencies [d5bdbe6]
- Updated dependencies [0c88e11]
- Updated dependencies [e6fa2ec]
- Updated dependencies [9901dd5]
- Updated dependencies [95d5434]
- Updated dependencies [966f5c3]
- Updated dependencies [a848818]
- Updated dependencies [4fb3d7c]
- Updated dependencies [263a67e]
- Updated dependencies [36fc9d0]
- Updated dependencies [69cbaee]
- Updated dependencies [767c388]
- Updated dependencies [66ade99]
- Updated dependencies [35a0cc6]
- Updated dependencies [3c2ae09]
- Updated dependencies [1c67fba]
- Updated dependencies [964c47d]
- Updated dependencies [1fadaa1]
- Updated dependencies [71efbdd]
- Updated dependencies [5a33539]
- Updated dependencies [ea4a201]
- Updated dependencies [adc3f35]
- Updated dependencies [ed11c45]
- Updated dependencies [9387a5d]
- Updated dependencies [f9955d6]
- Updated dependencies [28efb31]
- Updated dependencies [80c8318]
- Updated dependencies [2a0d03a]
- Updated dependencies [130500f]
- Updated dependencies [946f8ee]
- Updated dependencies [7cd200e]
- Updated dependencies [997661b]
- Updated dependencies [ef58e04]
- Updated dependencies [7a069eb]
- Updated dependencies [9c12124]
- Updated dependencies [8e18a9b]
- Updated dependencies [9cac913]
- Updated dependencies [8e3a45f]
- Updated dependencies [1dd9ee7]
- Updated dependencies [584e7d9]
- Updated dependencies [e08eda3]
- Updated dependencies [2cdba11]
- Updated dependencies [fdc96ec]
- Updated dependencies [0b59f4f]
- Updated dependencies [788f63d]
- Updated dependencies [234d8fe]
- Updated dependencies [6ab8dad]
- Updated dependencies [704c709]
- Updated dependencies [90a3111]
- Updated dependencies [6b30c51]
- Updated dependencies [f15b01b]
- Updated dependencies [31b48d4]
- Updated dependencies [36520ce]
- Updated dependencies [2c9ffc1]
- Updated dependencies [f9f2352]
- Updated dependencies [ee3fe90]
- Updated dependencies [7e30caa]
- Updated dependencies [67e712e]
- Updated dependencies [41a8edf]
- Updated dependencies [bdb1d89]
- Updated dependencies [284ad5e]
- Updated dependencies [7afb1e2]
- Updated dependencies [84d90d5]
- Updated dependencies [52f75d0]
- Updated dependencies [eef6cea]
- Updated dependencies [3fdab3d]
- Updated dependencies [06e19f1]
- Updated dependencies [9266302]
- Updated dependencies [bdac41e]
- Updated dependencies [87b573b]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [7cf6870]
- Updated dependencies [ef0d241]
- Updated dependencies [b2e5888]
- Updated dependencies [8a77b07]
- Updated dependencies [33c937f]
- Updated dependencies [4ddf93f]
- Updated dependencies [d0a58b7]
- Updated dependencies [6832713]
- Updated dependencies [6832713]
- Updated dependencies [12ca8d6]
- Updated dependencies [12ca8d6]
- Updated dependencies [232ffe8]
  - @getdomovoi/daemon@0.1.0-alpha.0
  - @getdomovoi/credential-store@0.1.0-alpha.0
