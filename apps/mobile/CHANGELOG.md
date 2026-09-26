# @getdomovoi/mobile

## 0.1.0-alpha.0

### Minor Changes

- 2e30deb: Render agent replies as markdown in the phone's session thread.
- 28a8a68: The phone's gate offers the third decision, "Always allow this here", which allows the command now and stops asking for it in this project; absent on a hard gate, where the daemon refuses a standing rule.
- 1469846: A comment on a render can be made from the phone: pick an element in the render, write, and it is sent as a reference to that element.
- cac2e63: The phone attaches up to two images to a message: a photo or screenshot from the library, or one taken now, each held to 1.5 MB and 2048 px before it leaves the phone, with the size line stating where the bytes go.
- fe7968f: Pairing by camera. The protocol gains `pairingPayloadSchema` and its
  encoder and decoder: the text a pairing QR carries, a daemon address (TLS,
  or plaintext on loopback only) and a client credential. The phone gains
  `expo-camera` and a Scan a pairing code screen that reads it, names the
  machine, asks once and connects; a refused camera pastes the same text.
- d5e7550: The phone pins the working plan: a strip above the thread names the step in progress, tapping it lifts the whole plan as a sheet over the thread, and Unpin collapses it back into the thread.
- c50c37d: The phone's working plan says when it was revised, lets a person rewrite one step in place, and says the edit applies at the next turn boundary.
- 37b3fa0: The phone fetches a preview's render from the machine with a signed grant and shows it in a frame, with the other variants of the same render as tabs.
- 2f47e5d: The phone keeps the daemon's relay identity pin in SecureStore and exposes it to the protocol's
  recovery and adoption functions. The compare runs under one queue per backing store shared by
  every handle, every write is confirmed by read-back, and an unconfirmed write is reported as
  unconfirmed; the writable store is constructed only in the app process.
  Once the daemon has answered the greeting (never on a snapshot pushed before it) the phone enrols the daemon's published relay
  identity as its trusted pin, or recovers a distrusted pin from the daemon's signed successor
  verified against the saved pin only.
  Pins are kept per machine, so pairing with a different daemon starts without one.
- b26506d: Group the phone's sessions under Needs you, Running and Quiet, needs-you first, with a count in each heading and a "need you" count in the header.
- f71e0a3: A session can be started from the phone as another like the one on screen: same machine, repository, provider and model, words from the person, Plan by default with the mode changeable.
- eedb10c: The phone draws text from a generated type ramp and enforces its own type floor in every screen and the tab bar, so no phone text falls under the size the design system sets for it.
- 6542cb3: Finish the unblocked V2 phone, tablet, and web interface parity work.

### Patch Changes

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
- 1dd9ee7: The approval card offers Always only for a request the daemon resolved. A request it could not
  resolve, such as a Claude Read, Glob, Grep or Task, a WebFetch or MCP call, a read outside the
  worktree or an edit aimed at the worktree root, cannot become a standing rule and the daemon refuses
  one, so the desktop and web card, the phone approval screen and the tablet card no longer show the
  button there. The desktop and web card also no longer offer Always on a hard gate, which the daemon
  refuses too; the phone and tablet already did not. Allow once and Deny are unchanged.
- 1dd9ee7: An Allow now answers the approval card the person saw. When a file-tool card's target changed
  while it waited, the daemon updated only the card's execution record, which no card shows, so a
  second Allow could approve a different file, or make a standing rule for it, without that file ever
  being on screen.
  
  Approval cards carry a `revision`, a non-negative integer that the daemon raises each time it
  rewrites a card. A card saved before this reads as revision 0. `approval.resolve` takes the
  `revision` the client showed: it is required for `allow-once` and `always-project` and optional for
  `deny` and `deny-explain`. The daemon refuses an Allow whose revision is not the card's current one,
  with "The file target changed; review the updated approval before allowing it" on a file-tool card
  and "The resolved command changed; review the updated approval before allowing it" on any other.
  The desktop and web card, the phone approval and denial screens and the tablet card send the
  revision of the card they show. The protocol version stays 0.8.0.
  
  A file-tool card's Affects line names the file the edit reaches, read the way execution resolution
  reads it: "The file src/index.ts in the session worktree.", or, when the file is outside the
  worktree, "The file /path, outside the session worktree." with ", through a link at <path>" when a
  link inside the worktree leads there. A path that names a credential file, or that a link carries to
  one, shows as [REDACTED], and the card is a hard gate: it offers no Always, and no standing rule or
  Build auto answers it. Other text passes through the durable secret redaction; a card whose path
  that redaction changes is a hard gate too, as a secret anywhere else in a card makes it. Control characters in the path are
  escaped and a path past 512 characters is shortened in the middle. The line is set when the card is
  raised and read again when the card is answered: if the file changed, the card is rewritten with the
  new line under the next revision, broadcast, and the Allow is refused. Every Allow on a file-tool
  card is read again this way, including a card the daemon could not resolve (a file with another
  hard link, say), and a change in its target, Affects line, sensitivity or execution record rewrites
  the card and refuses the Allow. An unresolved card still offers no Always.
  
  A blocked or unresolved record reads the same whatever is at the file, so the daemon also reads the
  file itself when the card is raised, with lstat alone and without opening it: the kind of entry
  (regular file, directory, FIFO, socket, device, link or nothing), its device, inode and link count,
  and the path it really leads to. On Allow it reads the file the same way, and any difference is a
  change whatever the record says: a file swapped for a directory, a FIFO, a link, another hard link
  or another file, or removed, rewrites the card and refuses the Allow. A file with nothing at it
  then and now is unchanged. A file that cannot be read on Allow, at its path, in a directory on the
  way to where it leads, or there, counts as changed even when the reading kept with the card could
  not be read either, since two such readings match whatever lies beneath: the card is rewritten and
  the Allow refused, and each Allow is refused while the file stays unreadable. The path Claude Code
  blocked on is kept with the card in memory, so the
  file resolves on Allow as it did when the card was raised. A file-tool name with whitespace around
  it is that tool: the card, its record and what the card hides use the trimmed name.
  
  A card whose Affects line shows [REDACTED] carries `{ state: "unresolved", reason:
  "sensitive-content" }` as its execution record in every copy the daemon saves or sends
  (`workspace.get`, `workspace.changed`, the saved store), so no client receives the path the line
  hides. The daemon keeps the real record in memory only, for the reading on Allow, and forgets it
  when the card leaves.
  
  A card's directory is the directory the request runs in. A path Claude Code blocked on is sent
  beside the request as `blockedPath` and is never the card's directory; before this the Claude
  adapter sent it as the request's directory, so a blocked credential path reached every client and
  the saved store. A directory that names a credential store, or one the durable redaction changes,
  shows as "[REDACTED] in the session worktree" or "[REDACTED], outside the session worktree", the
  card is a hard gate, and a resolved execution record, which names the directory, is replaced as
  above and kept in memory for the reading on Allow.
  
  A card's operation and command lines hide each path the card hides: a credential file, a file
  whose path the redaction changes, a hidden directory, and a path Claude Code blocked on that names
  a credential file or that the redaction changes (such a card is a hard gate too). The exact path is
  replaced with [REDACTED] wherever it stands whole, as written, from the request's directory, where
  it really leads, and relative to the worktree, and the rest of the agent's text stays. The path
  relative to the request's directory counts too, from that directory as given and as it really
  lies, so `.env` or `../src/.env` for a hidden `src/.env` is replaced. Each relative form is
  replaced with "/" or "\" and with or without a leading "./". A name that
  only starts with the path, such as `.env.example` beside a hidden `.env`, is kept. The lines reach
  `workspace.get`, `workspace.changed`, the saved store, the approval receipt and the error log in
  that form. A file hidden only when the card is read again is hidden in the card's text from that
  revision on. A package script whose command line hides a path is read again on Allow from the
  command as the provider sent it, kept in memory until the card leaves.
- 2f29554: Claude Code sessions now refuse, with a message that says what to install, the two installs the
  Claude Agent SDK cannot run. On Windows the SDK starts `claude` without a shell, so the npm `claude`
  shim and `claude.cmd` failed with a raw spawn error; the daemon now takes only the native
  `claude.exe` and otherwise names the shim it found. And nothing tied the installed Claude Code to
  the SDK, which passes the flags of the version it was built against (`claudeCodeVersion` 2.1.263
  for SDK 0.3.263); an older `claude` is now refused with "Update Claude Code to 2.1.263 or newer".
  
  Provider readiness carries the same text in a new optional `problem` field. The desktop and web
  clients show it in Settings and first run, label the provider "Cannot start", and keep it out of
  the launcher. The phone skips such a provider when it starts a fresh session and
  says the problem when no other provider is ready.
  
  The version is read without blocking the daemon's event loop, before a session starts or models
  are listed, and once per executable and modification time. A bare `claude` that a probe with no
  PATH ran on Windows is not called a shim, since Windows starts `claude.exe` for it.
  A `claude` the operating system cannot start at all, such as a `claude.exe` that is not a Windows
  program, leaves the version unknown instead of failing the session start or the model list with
  a raw spawn error.
- dffe022: Mark the point where a provider compacted its context. A system thread row can now carry a context-compaction notice, and clients draw that row as a boundary in the transcript rather than as a general system banner. The copy states both halves of what happened: the provider stopped reading the turns above it, and Domovoi still holds them. A snapshot written before the notice existed keeps parsing, and every other system row keeps its existing styling and detail line.
- 7229239: Pin js-yaml 4.x to 4.3.2 or newer. GHSA-2883-xcg3-v3hh names both 4.3.2 and 3.15.2 as patched, so the 3.x consumer keeps its own patched version rather than being forced across a major.
- 64e9c45: Offer the ride back whenever a thread sits away from its bottom. A streaming
  reply grows one row rather than adding rows, so the unseen count can stay at
  zero while the thread keeps moving, and the pill used to stay hidden. The
  count is still the label when there is one.
- 6f3379c: Ship Instrument Sans and JetBrains Mono inside the phone bundle and register them
  before the first frame, with each text style naming its loaded face. The phone's
  colours, radii, and font names are now generated from `packages/ui/src/styles.css`,
  which gains the design system's desk, overlay, danger-on, and info ramp tokens.
- 3e396ce: A failed render fetch on the phone now says what is still true and offers to try again: the
  artifact is on the machine, the comments below are live, only the picture is missing. A fresh
  session reads as ready rather than empty: "Nothing has run yet. The session exists, the worktree
  is cut, and the agent has not been given a turn. Your first message is what starts it."
- a5f0f7e: The phone's thread follows a reply only when the person is already at the bottom. Scrolled up
  to read an earlier turn, the viewport holds still while new output lands, and a pill above the
  composer offers the ride back: "3 new" with a primary dot, or "Waiting on you" on the warning
  ramp with a pulsing dot when a decision arrived below. 44px tall for a thumb. Before, every
  growth of the thread scrolled to the end regardless of where the person was.
  
  `threadFollowState` and `threadFollowPillText` live in `@getdomovoi/protocol` so every surface
  with a thread derives the same three states.
- ccc9dd1: Show the socket's own error or close reason when pairing fails.
- f9a8a99: The phone's Stop everything keeps pausing and killing apart: Pause everything stops at the next turn boundary through system.pauseAll, and Emergency stop is its own control that asks again and says what it destroys.
- 55492e9: Unpinning one session's plan no longer unpins every other session's.
- 9cb178a: A decision receipt in the phone thread names who decided, the credential, the checkpoint and how long the decision took; an explanation stays with the decision.
- d738bee: When the daemon connection drops while a session, an approval or an artifact is open, the
  phone says so on that screen: the banner that already appears on the lists now appears there
  too, saying what is drawn is the last state the phone was sent. The composer refuses to send
  while the socket is not open and says the session is still on the machine. A decision that
  did not come back confirmed keeps the gate on screen with the reason where the buttons are.
  The phone claims only what it can prove: a frame that never left is "Not sent … The gate is
  still waiting"; a frame that left with no answer is "The daemon went away before it confirmed.
  The gate may or may not have been answered; when the connection returns, this screen shows
  which." Before, the rejection was unhandled and the screen showed nothing.
- f2ed466: The sessions header names the machine whose sessions these are and scopes the running count
  to it: `macbook-pro-m3 · none running · 2 reachable · 1 offline`. Before it read
  `3 machines · none running`, a claim about three machines from the data of one; a machine that
  did not answer was rounded into "none running". No results and not searched are different
  answers.
- d7139a4: The phone thread follows a reply that lands, and the composer clears the keyboard by the top inset it sits under.
- 2af814b: Phone and tablet correctness. The app keeps one daemon connection: a wake or Retry while a dial is still connecting no longer opens a second one, and a replaced connection can no longer apply deltas twice or turn the live one into watching. A frame the app cannot read (invalid JSON, a snapshot, delta or fleet that fails the schema, or a hello answer that is not a snapshot) is reported in the connection banner instead of dropped. A render error shows a recoverable screen instead of closing the app.
  
  Pairing keeps the kind the code was issued for. A tablet code greets as a tablet, a code for a desktop, web browser or the command line is refused with what to show instead. A credential with no stored kind, one saved before this change or a token typed into Settings, greets as a phone and, if the daemon refuses that credential, tries once as a tablet and keeps the kind that works. A pairing refusal now names a protocol mismatch (and that the code was not used) or a full device list, instead of calling every code spent.
  
  A watching device says a waiting decision waits on a full-access device, on the tablet session list and the phone's jump pill. The tablet thread shows a policy refusal's rule, who set it, where it applies and the remedy, as the phone does. The tablet shows the connection banner, including the out of date notice. A watching tablet is offered no review controls, and a review that fails to post keeps its draft and says why.
- c04e75f: Give the phone's Fleet tab the facts it can stand behind. Every machine row now
  says how it is reached, a machine that has stopped answering says when it was
  last heard from, a daemon running inside WSL names its distribution, and the
  title says how many machines answer and how many do not. The card for the daemon
  this phone is connected to carries its session and tool counts, read from the
  workspace snapshot it already holds; no other row gets them, because `fleet.list`
  carries no counts for another machine. The phone also takes the daemon's
  `fleet.changed` push, so a list on screen stops describing the moment the tab was
  opened. Waking a machine and pairing one from the phone are still not offered,
  because neither has a protocol call behind it.
- 7300598: When the daemon refuses a decision with a message that ends "The approval is still waiting.", the phone quotes that message and no longer adds its own "The gate is still waiting." after it. Other refusals keep the phone's line.
- b768055: The phone says that gates reach it only while Domovoi is open on it. The line appears in three places: above the sessions list, in a new card shown after pairing, and under a Notifications row in Settings. The row is dimmed, cannot be tapped and reads "Not yet". The card names the machine, the route and the device id the machine assigned. It stays on screen until Open Sessions is tapped. A tablet shows the same card centred and names the tablet.
- 4d07793: The phone's RPC client is typed against the protocol: each call's params are checked when the app compiles, and each answer is read by its method's result schema and the JSON-RPC response schema before anything waiting on it runs. An answer that fails is reported as an out of date app instead of being used. The phone no longer sends a client field on approval.resolve, which that method does not take. Thread rows that did not change are not drawn or parsed again on a keystroke. The app now builds under the repository's strict TypeScript settings. The review screen no surface reached is removed.
- 4301c04: Add a platform key custody probe for P-256, and repair the Reanimated pin that stopped an iOS prebuild.
- 5a33539: Carry a `protocol-mismatch` payload on every `protocolVersionMismatchErrorCode`
  (`-32012`) refusal: the refusing daemon's protocol version, the client's, and the
  `protocolCompatibility` result between them, validated by `protocolMismatchSchema`.
  `system.hello` and `device.claim` send it with their sentence unchanged. The fleet
  dialer reads the peer's version from the payload and falls back to the sentence
  only for a daemon that predates it, and the phone names both versions from the
  payload with the same fallback.
- 584e7d9: Derive runtime build versions from release metadata. Fleet facts, daemon and client greetings,
  and provider initialization report the running release instead of a fixed development version.
  Production startup refreshes the persisted local version without changing machine identity.
  Wire protocol compatibility and existing pairings are unchanged.
- 10635fc: Surfaces say what exists: the phone's empty states print the pair command the machine really runs and no installer or `domovoi new`; the pairing credential is described as it is scoped; the fleet's UPDATE badge, which had no update path, is gone.
- 7d6f7f3: A device paired to watch only now sees every waiting approval in full, with no decision controls, on desktop, web, phone and tablet. The note under the gate says a device paired with full access answers it.
- Updated dependencies [1dd9ee7]
- Updated dependencies [5ee1825]
- Updated dependencies [08e4f00]
- Updated dependencies [1204d6c]
- Updated dependencies [2adb117]
- Updated dependencies [2f29554]
- Updated dependencies [4cacf7a]
- Updated dependencies [dffe022]
- Updated dependencies [ab18590]
- Updated dependencies [711bee5]
- Updated dependencies [b7f7c95]
- Updated dependencies [279349c]
- Updated dependencies [d4228ee]
- Updated dependencies [0fed2e6]
- Updated dependencies [3d67826]
- Updated dependencies [91b1e15]
- Updated dependencies [18f6543]
- Updated dependencies [9e1e9c5]
- Updated dependencies [c32065a]
- Updated dependencies [4359bcf]
- Updated dependencies [9d94da3]
- Updated dependencies [c3229d9]
- Updated dependencies [6b0e4fd]
- Updated dependencies [64e9c45]
- Updated dependencies [1204d6c]
- Updated dependencies [5ae04b0]
- Updated dependencies [b67435e]
- Updated dependencies [b5b1aa9]
- Updated dependencies [a5f0f7e]
- Updated dependencies [fe7968f]
- Updated dependencies [59b1a7a]
- Updated dependencies [d5bdbe6]
- Updated dependencies [0c88e11]
- Updated dependencies [e6fa2ec]
- Updated dependencies [e736472]
- Updated dependencies [66ade99]
- Updated dependencies [cdf5f87]
- Updated dependencies [45e152d]
- Updated dependencies [3c2ae09]
- Updated dependencies [1c67fba]
- Updated dependencies [964c47d]
- Updated dependencies [7bea6a9]
- Updated dependencies [e094929]
- Updated dependencies [20e7e91]
- Updated dependencies [9048458]
- Updated dependencies [5a33539]
- Updated dependencies [fb78eda]
- Updated dependencies [9387a5d]
- Updated dependencies [c3e566a]
- Updated dependencies [2b21f85]
- Updated dependencies [ef58e04]
- Updated dependencies [9c12124]
- Updated dependencies [cad2971]
- Updated dependencies [8523d3d]
- Updated dependencies [d5a77a5]
- Updated dependencies [1dd9ee7]
- Updated dependencies [584e7d9]
- Updated dependencies [fdc96ec]
- Updated dependencies [0b59f4f]
- Updated dependencies [31b48d4]
- Updated dependencies [36520ce]
- Updated dependencies [f9f2352]
- Updated dependencies [ee3fe90]
- Updated dependencies [7e30caa]
- Updated dependencies [ea2b5ab]
- Updated dependencies [284ad5e]
- Updated dependencies [9266302]
- Updated dependencies [9b60965]
- Updated dependencies [01ce5da]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [7cf6870]
- Updated dependencies [ef0d241]
- Updated dependencies [b2e5888]
- Updated dependencies [33c937f]
- Updated dependencies [fa621d6]
- Updated dependencies [d0a58b7]
- Updated dependencies [6832713]
- Updated dependencies [6832713]
  - @getdomovoi/protocol@0.1.0-alpha.0
