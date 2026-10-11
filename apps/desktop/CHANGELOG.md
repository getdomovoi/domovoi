# @getdomovoi/desktop

## 0.1.0-alpha.0

### Minor Changes

- 63db84a: Desktop first-run setup follows the v2 onboarding design. It starts at "Keep Domovoi running after you quit", which installs the login service through the same desktop bridge as Settings, with Not now to skip it; its attach step names the address of the daemon the window reached, or loopback when none is known; and it says what failed and what still works when the install fails. The permission-mode step is gone; new sessions start in Build manual. Agents show as one card each: a CLI that needs signing in offers its own sign-in command to copy, and a missing CLI gets install guidance, never an installer. "One machine is enough for now" ends setup even when no agent is ready, and setup that was completed or skipped does not open again on the next launch; Settings > First-run setup opens it again.
- 9dc6a6f: Desktop now builds its daemon through the shared production factory instead
  of a hand-assembled server with a random per-launch token. The daemon keeps a
  persisted credential and machine identity across launches, so paired devices
  keep working after Desktop restarts, and the renderer connects to the URL and
  token of the daemon that was actually started rather than a fixed address. The
  launch smoke no longer requests daemon credentials and fails if a daemon state
  directory appears during the packaging test.
- 6378492: The desktop keeps each daemon's relay identity pin in a private main-process file under userData, replaced whole and synced to disk on every swap; the renderer reads one machine's pin by key and asks the main process to compare and swap it over the bridge, and never sees the path. A damaged file or one written by a newer desktop is refused, not emptied.
- 07f3801: The desktop app's runtime now carries the `domovoi` CLI beside the daemon, each with a launcher in `daemon-runtime/bin` that runs it with the Node program the app ships. These are what the app links into `~/.local/bin`, and what a printed command names by full path where no link exists.
- 3ff73e4: Settings > Daemon on this machine gains Terminal commands: Link the commands puts `domovoid` and `domovoi` in `~/.local/bin` as links to the copies inside the app, and Remove the links, offered whenever either command is linked, takes them away again. Where linking is not offered (a linked or non-directory `~/.local/bin`, an app running from a disk image or a temporary copy, Windows), it says why, and it shows a refusal for any entry it did not make. Every command the desktop prints for this machine (the service commands, the profile recovery, the key commands, the pairing command and the refused-daemon screen) names what runs: the short name when linked and `~/.local/bin` is on the app's PATH, the link's path otherwise, and the launcher inside the app by its full path when nothing is linked. An app running from a disk image, a temporary copy or an AppImage names no launcher, because that path will not exist once the app quits: commands print as written, and the row points to Install for the login service. A disk image is an app under `/Volumes` on a read-only mount, as a downloaded disk image is; an app on an external drive under `/Volumes`, which is writable, links as usual. A disk image mounted writable is not told apart from such a drive. The app sets a random past modification time on each link it makes, on the link itself, and records the link (its path, target, device, inode and that time) in a private `command-links.json` in its userData, and treats a link as its own, linked or stale, only while it matches that record, so a link made in its place does not match even where the file system reuses the inode, as ext4 does; any other entry, a link shaped like a Domovoi launcher into a checkout included, is never replaced or removed. Right before every removal and every link it makes, `~/.local` and `~/.local/bin` must still be the real directories it read, by device and inode, and an entry it removes must still be the link it read, with the same inode and target. Ruled Q411 A, as round 8 of #577 did for the runtime copy, the instant between that check and the unlink or symlink stays open, since Node has no call relative to an open directory: another process of the same user could have one entry of that name removed, or one link made, in a directory it swaps in there.
- 00ed8f0: The desktop bridge gains `tailnetReach(action)` for `status`, `on` and `off`.
  The preload passes the main process's answer on only when it holds known keys,
  booleans and bounded strings; `parseTailnetReachReport` and
  `parseTailnetReachOutcome` in `@getdomovoi/ui` parse its exact shape. The client
  gains `tailnetStatus()` for the daemon's `tailnet.status`.
- 2792b93: The desktop main process can turn TailnetReach on and off over the
  `domovoi:tailnet-reach` channel. On, it reads `tailscale status --json`, runs
  `tailscale cert` for this machine's own name into `<profile>/tls/<name>.crt` and
  `.key`, and restarts the daemon once so it also answers on the tailnet address:
  the in-app daemon through the settings it saves in the app's data directory, the
  login service through its update. Off, it deletes only the files it wrote and
  restarts the daemon on 127.0.0.1 only. It sets those files aside in a private
  pending directory first and deletes them only once the saved record is gone,
  so a turn-off that cannot move a file or delete the record puts the files back
  and leaves the switch on with both files and the record, naming the file or
  the record that could not be deleted. It refuses while a
  turn runs or a gate waits, and never replaces a file it did not write.
  
  While the switch is on, the desktop runs
  `tailscale cert --min-validity 720h` every 12 hours, the first time a minute
  after it loads. It replaces only its own files and restarts the daemon only when
  Tailscale returned a different certificate. A failure keeps the current
  certificate, is tried again after an hour, and is reported with the switch's
  state. A hand-set `DOMOVOI_HOST` beyond loopback keeps the saved settings out of
  the in-app daemon, which starts without the tailnet listener; the switch says
  why and does not turn on.
  
  A certificate and key Tailscale hands back are used only when the certificate
  reads as X.509, has not expired, names this machine and the key belongs to it.
  After the restart, the change counts only once the daemon's `tailnet.status`
  says it serves that certificate on the tailnet, or holds it while the tailnet
  address is not up yet. When the daemon refused it, or could not be asked, the
  previous certificate, key and record go back and the daemon restarts on them.
  
  Turning on again and renewing set the files in use aside in a private pending
  directory first. Any failure before the restart succeeds, a thrown error
  included, puts those files back, and the record when turning on, and starts the
  daemon as it was if the restart had begun; the pending directory is removed only once nothing in it is still needed.
  When the files cannot be put back, they stay in that directory and the switch's
  state says where, until someone moves them. A directory like that found when
  the app starts is reported apart, since it may be from a change that did not
  finish. When a turn-off has deleted the record but cannot delete the files it
  set aside, the switch is off and its state names that directory at once, while
  it still holds them, whether or not Tailscale can answer; these directories
  are named with every state. When the restart then fails as well, the answer
  carries that directory too and says the setting was removed, the certificate
  and key in that directory could not be deleted, and the daemon did not restart,
  with the restart's own message. When the in-app daemon's tailnet listener comes from
  `DOMOVOI_TAILNET_ADDRESS` set by hand in the app's environment, the switch's
  state says so, because turning the switch off cannot clear it.
  
  The switch marks each certificate and key it writes with a modification time
  of its own choosing and records each file's device, inode and that time. It
  replaces or deletes a file only while the file still carries them; turning off
  otherwise deletes nothing, stays on and says which file to move away. A pending
  directory is marked when the switch makes it, and the sweep at load removes
  only marked directories that hold nothing but what the switch writes there,
  file by file. `<profile>/tls`, the certificate and the key are never used
  through a link, and the saved record is read only as a regular file of at most
  4 KiB that is not a link, so nothing placed there can hold startup. A process
  running as the same user can still forge the record and the marks.

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
- 2af355e: The approval card reads the origin, containment and plan facts the daemon sends. It says You
  started this turn from this desktop (or this browser) only when the turn came from the
  connection this client holds now, and otherwise names the kind of client that started it. It
  draws Outside project with what decided it (the path the request names, or the directory it runs
  in) and draws nothing when the daemon could not decide. When a plan step waits on the gate, the
  meta line leads with step n of N.
  
  The latest decision receipt is followed by Review the changed files and Move this session to
  another machine, which open the changes sheet and the machine menu's move. The thread can also
  pass a route to the dock, which draws See the checkpoints or See the rule under the receipt and
  See what a rule can never cover on a policy refusal.
- e790869: The Authorize this client dialog no longer tells the person to run `domovoid pair --client <kind>` and paste its output as the client credential. That command prints a one-time pairing code, which the field does not take. The dialog now says a client credential comes from a device.pair request made with the machine's own daemon credential.
- 118b8db: The desktop package ships a daemon runtime beside the app: Node 24.21.0, pinned by its published sha256 per platform and trimmed to the program, and the daemon with its production dependencies. The app copies it under the profile when it installs the login service. Packaging proves the shipped daemon runs by asking it for its version under the shipped Node. A shipped runtime that is missing or does not load stops startup with Domovoi could not start, naming its path and what is missing.
- 711bee5: Settings opens with Daemon on this machine: whether this app, the installed login service or another window holds it, what quitting does, and what installing the service writes on this platform. Install and Remove are drawn locked with the command that does the job beside them.
- b7f7c95: The switch to or from the login service is now held by the daemon itself. `system.serviceHandoffFence` (loopback, daemon credential only) answers the same refusal as the window's check, or, when nothing runs, no dispatch is in flight and no gate waits, admits no new turn until the connection that took it closes. The desktop takes it right before it stops the daemon inside the app or removes the service, so a turn that starts after the first check makes the switch wait instead of being stopped.
  
  Staging the shipped runtime refuses an app version that is not one release version, a `~/.domovoi` or `~/.domovoi/runtime` that is a link, a shipped part that is not a regular file, and a link that leads outside the shipped runtime, all before any byte is copied. Links inside the runtime are copied as they are. An earlier copy of the same version is moved aside and put back if the new copy cannot be renamed into place.
  
  After a failed install or removal the desktop reads the service back and reports it, along with the daemon it reaches afterwards, including one this app did not start. Settings no longer says nothing was installed or removed unless the read-back shows it.
- 279349c: The desktop can install the daemon as a login service from Settings and remove it again. The app copies the runtime it ships under the profile, asks the daemon's own installer to register the service pointing at that copy, and only then stops its in-app daemon and attaches to the service. The switch refuses while a turn runs or a gate waits and names the sessions; a runtime the app does not ship is reported without touching anything.
  
  Install and Remove both wait while a turn runs or a gate waits. The desktop main process checks this too, before anything is stopped: it reads the workspace from its own daemon (`readLocalServiceHandoffRefusal` in `@getdomovoi/daemon`) and applies the same check the window uses (`serviceHandoffRefusal` in `@getdomovoi/protocol`). A workspace it cannot read also makes the switch wait. While the service takes over the profile or gives it back, a window reconnect waits for the handoff instead of starting a daemon inside the app. The runtime copy is made in a fresh directory and renamed into place, so no file from an earlier copy of the same version survives. Settings says when the service was installed but this window could not reach it, when the daemon inside the app stopped and did not start again, and what to run when a removal leaves the profile owner unresolved. A daemon running outside the app is drawn as the installed service, with Remove available, only when the desktop reads the service as installed from the service manager.
- 4a32392: Update production dependencies: the Claude, Kilo and OpenCode provider SDKs in the daemon; Electron 44.2.0 in the desktop; React 19.2.8, Lucide 1.42.0 and react-resizable-panels 4.12.4 in the shared ui and the clients. Development tooling moves with them (vitest 5, shadcn 4.21). The phone follows its Expo SDK: expo 57.0.22, reanimated 4.5.1 and worklets 0.10.1 as the SDK resolves them, jest held at 29 because jest-expo 57 expects it, and a deps:check that refuses drift from the installed SDK.
- 9a015e9: Update production dependencies. The daemon moves to Claude Agent SDK 0.3.281, Anthropic SDK 0.128.0,
  Agent Client Protocol SDK 1.5.0, Kilo SDK 7.7.9, OpenCode SDK 1.18.32, MCP SDK 1.30.1 and yaml
  2.9.1. Claude Agent SDK 0.3.281 is built against Claude Code 2.1.281, so the daemon now refuses an
  older `claude` with "Update Claude Code to 2.1.281 or newer". The floor was 2.1.263. The keyring
  binding moves to 2.1.0, zod to 4.6.5 and vite to 8.3.0. The shared ui and the web and desktop
  clients move to Lucide 1.47.0 and tailwind-merge 3.7.0, and stay on React 19.2.8 and
  react-resizable-panels 4.12.4: the newer two would put startup JavaScript over its budget. The
  phone takes Expo 57.0.24 and stays on the React, safe-area and SVG versions that SDK bundles.
- c634abf: The CLI the app ships beside the daemon keeps only its own dependencies, not a second copy of the
  daemon or the packages only that copy needs. `domovoi daemon install` through the linked `domovoi`
  runs the runtime's own daemon, which copies the runtime out of the app before registering it.
- ee3fe90: Refuse Fleet routes whose normalized hostname cannot name one exact CSP source.
  URL-valid semicolons and commas, including percent-encoded forms, could previously
  authorize a different hostname when Chromium parsed the worker policy. These routes
  now fail before a ticket is issued, rather than escaping or broadening the policy.
  
  Use a normal DNS hostname or IPv4 route when admission reports that no client route
  is available. No protocol change or re-pairing is required. Existing exact origins,
  ports and URL-normalized internationalized names retain their behavior.
- 27f81b2: The desktop approval card is drawn as the Desktop v2 design draws it. It heads Waiting on your
  decision with a pulsing dot, names the agent and mode on the meta line, and adds hard gate there
  for a hard gate in place of the badge. The command is larger, the decisions are taller, and the
  facts sit under the decisions in three columns behind What does this touch?. The facts start
  open, so every fact is on screen until a person folds them, and they open again when the daemon
  revises the gate. A watching client can still open and fold them, and so can someone writing a
  denial note. The web card keeps its own header with every fact open. A refused decision, such
  as a checkpoint the daemon could not take, shows in the card with a danger dot.
  
  Decision receipts are toned as designed: an allow reads green and a denial red, each with a dot,
  and the body reads the checkpoint first and the rule second. A rule receipt now says later runs
  under the rule do not take a checkpoint, since only a person's allow takes one.
  
  The policy refusal card says there is nothing to approve, puts the rule it broke in its own block
  with who set it and where it applies, and lists the daemon's remedy under What you can do
  instead.
- d7fea95: `captureInheritedCredentials` takes an optional second argument: values a caller already took out of the process environment and held. They are pinned to the profile exactly as values read from the environment are, and a held value wins over one still there. The desktop app's first module now takes `DOMOVOI_AUTH_TOKEN`, `DOMOVOI_CREDENTIAL_PATH` and `DOMOVOI_RELAY_CREDENTIAL_FILE` out of its environment with its own code, holds them, and hands them to the daemon it loads from its shipped runtime. Limit: the profile they are pinned to is read when the daemon loads, not when the app starts.
- cb09b27: Ship license notices with every desktop build. `THIRD_PARTY_NOTICES.txt` in the resources
  directory names each bundled package with its declared license and the license and notice files it
  publishes, including the OFL-1.1 text of the two renderer fonts. macOS builds now also carry
  Electron's `LICENSE.electron.txt` and `LICENSES.chromium.html`, which Linux and Windows builds
  already kept beside the executable. Packaging stops when Electron's notice files are missing, and
  the license audit now covers the desktop app's graph and Electron as well as the npm packages.
- a0ffc77: Each publish of the shipped runtime writes a fresh directory, `<profile>/runtime/<version>/<id>`, and never moves, replaces or deletes an earlier copy. Preparing writes nothing, not even the profile or its runtime directory; those and the copy are made at publish, under the service-operation lease. Each publish leaves its private staging directory, empty, outside every profile. Copies earlier services used are left in place.
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
- 3279b1a: The desktop installs the login service for the profile its own daemon runs, and passes that profile to install, update and removal, which check the saved service against it again under the service-operation lease. That refusal reads as the same approved line.
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
- d5b85e3: The effort menu uses the Desktop V2 words and lines for the levels each harness reports.
  Claude Code's scale is now its effort levels low, medium, high and max, in place of think,
  think-hard and ultrathink, which the daemon never reported. Codex reads None, Minimal, Low,
  Medium, High and Extra high (xhigh). The level the daemon reports as the model's default
  carries a Model default tag in the menu; the chip still shows only the level's word. A level
  Domovoi has no word for shows the value it sends, tagged No word yet, with a line that says so.
  The note after a model change moved the effort is drawn in neutral colours instead of amber.
  OpenCode and Kilo Code still report one level, medium or none, and send no effort value with a
  turn, so their menu shows that level rather than Model's own.
- 3545df6: Update Electron from 44.2.0 to 44.4.5. This brings backported upstream fixes, including security
  fixes, that Electron shipped since 44.2.0: Chromium 152.0.7977.130 and backported fixes from
  ANGLE, Chromium, Dawn, PDFium, Skia and V8. It also moves the embedded Node.js from 24.20.0 to
  24.21.0.
- 1f4950d: The "Could not read this session" state shown when a provider stops no longer says "nothing was written, nothing was lost". A provider can write files before it stops. The line now shows only where a caller states the failure only read.
- f3a2be9: Load less code before the first screen. The command palette and the launcher now load the first
  time one opens, and at idle once the shell has painted, like the Settings, Skills, Machines and
  Audit log surfaces. The QR code library loads with Settings, where the pairing card draws it,
  instead of with the shell. Nothing they show or do changes. Once the idle fetch has brought a
  dialog's code, opening it draws it at once. Opening one before its code has arrived shows a
  dialog of the same size and title with loading bars, which closes the way the dialog itself
  does, with Escape or a click outside. A closed one stays closed when the code lands; an open one
  is replaced by the dialog. The project switch confirmation still loads with the shell, so the
  sessions, worktrees and running work a switch stops show as soon as the daemon asks. The web
  startup script graph drops from 1,284,380 to 1,234,894 bytes and the desktop renderer's from
  1,275,722 to 1,224,440 bytes.
- 50510c7: Desktop no longer reports every in-app daemon startup failure as an invalid profile. `acquireLocalDaemon` names three causes the owner can act on: `port-in-use` when another program holds the daemon's port, `state-locked` when another process holds the profile's state database (SQLite busy or locked), and `identity-mismatch` when the stored workspace belongs to another machine identity. Other failures keep `profile-invalid`. Every startup failure is now written to the error sink with its redacted cause, so Desktop's log keeps it. A port already in use now refuses at once instead of waiting out the startup deadline, because the WebSocket server's copy of the listen error no longer throws before `start()` can reject, and stopping a daemon whose listener never started no longer fails, so the profile lease is released and the next attempt in the same process can start. A Desktop owner record left `stopping` by a Desktop that quit before its daemon finished stopping is retired when the next launch holds the profile lease, so that launch starts instead of being refused as unreachable. After the daemon is listening, a later error from its WebSocket server is written to the error sink instead of being dropped.
- 35a0cc6: Run the person's own installed `claude` for Claude Code sessions. The daemon finds `claude` on the
  tool PATH, the executable provider readiness already reports, and passes that path to the Claude
  Agent SDK instead of letting the SDK start its own bundled agent binary. Without `claude`
  installed, model discovery and new or resumed Claude Code sessions fail with "Claude Code is not
  installed" and the SDK is never called.
  
  The desktop app no longer packages the SDK's per-platform `@anthropic-ai/claude-agent-sdk-*`
  packages, so it carries no copy of the agent binary and packaging never re-signs one. It still
  bundles the SDK's JavaScript library, which the daemon imports.
- 42ab37c: Copy on the pairing card's Web browser tab now copies the word code alone, which the browser's connect page accepts. It used to copy the phone app's domovoi-pair payload, which the connect page refused. Phone and tablet still copy the payload.
- 324d830: The pairing card's Web browser tab no longer draws a QR. A phone camera scanning it opened the phone's own pairing, which greets as a phone, so it spent the web code and left an extra paired device. When the daemon's owner has set the web app address, the card names that address to open in the browser on that device, then type the code. Without one, it says to open Domovoi in the browser on that device and type the code. Phone and tablet QRs still hold the domovoi-pair payload.
- 45e152d: Settings gains Phone and tablet: a pairing card that shows the daemon's own pairing code for a phone, tablet or browser, with its QR, address and 180 second countdown, and says why no code can be shown when the daemon answers on loopback only or reports no certificate. The shared list of what a paired device can do now carries six lines, including that gates reach a device only while its app is open, and the terminal line is the short one.
- 4f3c3b5: Quitting the desktop while a service handoff is stopping its own daemon now waits for that stop,
  so an emergency stop's state save is not cut off. On SIGINT or SIGTERM the daemon is stopped even
  when its endpoint file cannot be removed, and each failure is written to stderr.
- adc3302: `THIRD_PARTY_NOTICES.txt` now names `tailwindcss` and `shadcn` with their MIT license text.
  `@tailwindcss/vite` copies their CSS into the renderer stylesheet through the `@import` rules in
  the UI stylesheet: Tailwind's preflight and generated utilities, and shadcn's `tailwind.css`. Both
  are development dependencies of the UI, so the notices, which read production graphs, left them
  out. The license audit now covers them too.
- 1a246bd: The desktop now removes daemon runtime copies no login service uses. Each install or update publishes the runtime into a fresh `<profile>/runtime/<version>/<id>`, about 150 MB, and until now nothing removed the earlier ones or the copy a failed change left. Once an install or update has confirmed its new service, the desktop asks the daemon (`removeUnusedDaemonRuntimes`) to remove the copies under that profile that neither the service definition nor the one before the change names.
  
  The removal runs under the service-operation lease and reads the definition again there. It removes nothing when the lease is busy, when the definition no longer names the copy this change published, when the previous definition named something other than a published copy, or when a definition or the saved configuration cannot be read. Only `<version>/<id>` directories reached through real directories are candidates; links are never followed or removed. Paths are compared by file identity, and each candidate is renamed to a private name and removed only if it is still the directory that was checked. `readDaemonServiceRuntimeCopy` reads which copy the service runs, and throws rather than read a failed query as no service. A copy a failed change leaves stays until the next confirmed one. Nothing new is shown in the app.
- 7e84a65: The daemon exports `serviceProfileMismatch`, which compares the profile a caller's environment names with the one the saved login service configuration names (or the default profile an install writes). The desktop refuses to install, remove or update the login service when the two differ, because its turn check and fence reach only its own daemon; it says which profiles they are. Update the service now takes the daemon's fence before it copies the runtime under the profile, so no turn starts on a copy that is being replaced.
- 55ecb69: `installDaemonService` and `updateDaemonService` take a `staged` runtime: its files are checked first, and its `publish` step runs only under the service-operation lease, after every profile check and before the handoff or any manager action. The desktop prepares an inert copy in a hidden directory under the profile, hands it over, and discards any copy the service call did not publish, so a refused change leaves every file as it was. While it copies and publishes, the desktop requires the profile's runtime directory to stay the directory it checked, by device, inode and real path, and writes nothing more when it changed.
- 900eadd: The daemon reads which runtime version the login service runs, from the service's own definition. When the desktop cannot talk to the daemon that owns the profile and a login service is installed, the refusal names that version, or says the service is older when the definition does not name one.
- 6d9029d: Settings offers Update the service when the login service runs an older Domovoi than this app. The desktop updates the service in place with the daemon's own update, refuses while a turn runs or a gate waits, and shows the daemon's words when the update does not finish.
- 58acac7: Update the service now takes the daemon's handoff fence right before the service restarts, as install and remove do, so no turn starts after the check. It reports success only when the daemon this window reaches is one started outside any app and the service reads back installed and running; otherwise it says `Updated, but this window could not reach the daemon` with `The daemon this window reached is not the running service.`
- 97e8d38: A packaged app imports its daemon only when the daemon's dist and node_modules resolve inside its own resources and every file in dist matches the sha256 digests packaging recorded in app.asar. Otherwise startup stops with Domovoi could not start, naming the file. The held credentials are handed over only after that check.
- 7be3c16: The Skills tab's "Inventories from your other machines" now draws one row per other machine, with its platform, architecture and daemon version and what its inventory says: how many skills it reported, unreachable, or no inventory returned. It used to draw one unnamed row for every skill on every machine, this one included. The per-skill comparison stays on the selected skill.
- 605d2d7: The desktop copies the shipped runtime into a private staging directory outside every profile and moves it into the profile with one rename when the service call publishes it, so a path swapped during the copy cannot redirect it into another profile.
- c250637: The desktop copies the shipped runtime under the selected profile, `<profile>/runtime/<version>` (`~/.domovoi/runtime/<version>` for the default profile), so a service change that is then refused replaces at most its own profile's copy. A refused install or removal of a login service whose profile is not known reads as a refusal. `readDaemonServiceRuntimeVersion` reads the version from that layout under any profile.
- 6e252b0: When the only staging place on the profile's volume fails the check that no
  other account can change it, the app's refusal says so instead of saying the
  profile is on a different volume. It names the directory and the check: group
  or others can write it, another account owns it, a macOS access control entry
  lets another account change it, or who can change it could not be confirmed.
  On Windows, where access rules are not read, it says the directory could not be
  confirmed inside the user profile. It lists any directories made before the
  refusal. Every other staging refusal keeps the different-volume sentence.
- cb96947: When the system temporary directory is on another volume than the profile's runtime directory, the desktop stages the runtime under `<app data>/runtime-staging`, only when that is a real directory on the runtime's volume, outside every profile (the selected one, a directory named `.domovoi`, or one holding `profile-lease.sqlite`) and outside any repository. The system temporary directory must pass the same check. Otherwise it refuses, writing nothing: `The profile directory <path> is on a different volume from this app's temporary and data directories, so the runtime could not be copied without writing inside a profile. Nothing was changed.`
- ee3fe90: Add separate, kind-bound remote client grants and Fleet client admission. A machine pairing remains daemon-to-daemon authority, not permission for a desktop or browser to control the target.
  
  Authorize this client in Fleet takes a separate client credential for the target, one a device.pair request made with the target daemon's own credential returns. No Domovoi command or screen hands out that raw credential yet: `domovoid pair` prints a one-time pairing code, which the dialog does not take. Use, Terminal and inventory reads require the target identity and client receipt to verify. Desktop main verifies each enrolled route through the home daemon and grants only that exact socket origin. Update both daemons and the client before using these additive calls. The wire remains 0.5.0, existing pairings remain valid and no re-pair is required.
  
  Client credentials stay only in app memory. Closing the app or removing local access does not revoke the remote grant; revoke the device in the target's Devices list. Remote Desktop preview frames remain unavailable until they have a separate verified path. This does not enable a hosted relay or expose the daemon's machine keychain to the client.
  
  Desktop serves its bundle from an explicit app origin so response CSP is enforced. Existing development profiles may need appearance, layout and first-run preferences selected again because old file-origin browser storage is not migrated. The daemon profile and its canonical sessions are unchanged.
  
  If `DOMOVOI_ALLOWED_ORIGINS` is explicitly configured, add the exact `domovoi-app://desktop` origin and restart that daemon. The default configuration already includes it; custom lists are not silently widened.
- 43f512c: Update the desktop to Electron 44.1.0 with newer Chromium and Node runtimes.
- 7caede1: The desktop answers the tailnet switch's status within 15 seconds: the
  tailscale status timeout of 10 seconds plus 5. When reading the saved record,
  finding the tailscale command or anything else in the read has not finished by
  then, a stalled check now reports not known instead of no tailnet: the read is
  refused with "The desktop did not answer.", as the card's own deadline does, so
  the card keeps its last known report or says Not known, and does not lock the
  switch. Automatic reads, "Check again" and the read after a change are all
  bounded this way. A turn-off reads the status after it once the switch is
  released, under the same deadline. When that read does not answer in time, the
  turn-off is still answered as done, not as failed, and the switch can change
  again: the card says Not known and "Turned off. The desktop did not answer when
  asked what the switch reads now.", offers "Check again", and still names
  certificate files the turn-off set aside and could not delete, until a read
  answers. When that read fails before the deadline, the turn-off is answered as
  done the same way, and the card says "Turned off. Reading what the switch
  reads now failed:" followed by the read's own words. A deletion or restart
  that fails is still reported as the turn-off failing. Since the switch is
  released before that read, the card runs one change at a time, including the
  status read after it, and refuses another as busy while one is in progress,
  without changing what the running one shows. The pairing card's "Get it from Tailscale" and "Try again" are disabled
  while the switch is turning on or off, as the switch itself is. Status reads asked for between the same two changes share one: a read
  asked for while another is under way, before or after that one's deadline,
  waits on it under its own deadline instead of starting another. A read asked
  for once a change has started or ended starts its own. A read refused at its
  deadline stays refused. The deadline cancels nothing: finding the tailscale
  command, reading files and the tailscale process run on until they settle, and
  the process keeps its existing 10 second timeout. The desktop bridge passes a
  refusal from the main process to the card without Electron's "Error invoking
  remote method" prefix.
- 76f3709: A turn-on of the tailnet switch, including "Renew now", reads the status after
  it once the switch is released, under the same 15 second deadline as a
  turn-off. A turn-on is done once the certificate is stored, the record written,
  the daemon restarted and confirmed on the tailnet, and renewal scheduled. A
  stalled read of the certificate's expiry after that no longer keeps the switch
  busy, so turning off and renewal are no longer refused as busy until the read
  settles. When that read does not answer in time, the turn-on is answered as
  done, not as failed: the card says Not known and "Turned on. The desktop did
  not answer when asked what the switch reads now.", keeps the switch disabled,
  and offers "Check again" until a read answers. When that read fails before the
  deadline, the card says "Turned on. Reading what the switch reads now failed:"
  followed by the read's own words. A refusal, a failed store, a failed restart
  and anything that throws before the change is done are still reported as the
  turn-on failing, with the same rollback as before. The card refuses a turn-on
  answer that names undeleted certificate files, which only a turn-off leaves.
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
- Updated dependencies [9a015e9]
- Updated dependencies [a5fde27]
- Updated dependencies [4aa3ef7]
- Updated dependencies [ccc14a7]
- Updated dependencies [cdf92bc]
- Updated dependencies [704c709]
- Updated dependencies [08d39f0]
  - @getdomovoi/credential-store@0.1.0-alpha.0
