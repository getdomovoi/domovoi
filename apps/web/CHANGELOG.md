# @getdomovoi/web

## 0.1.0-alpha.0

### Minor Changes

- 22b46b6: Give the browser client the host capabilities the desktop already has, and stop the browser holding
  the daemon's root bearer.
  
  `WorkspaceShell` takes a `platform` port beside the desktop `windowBridge`. The browser build
  implements it against the browser's own APIs. Workspace notifications now reach a browser client, so
  the Notifications pane stops being three switches with nothing behind them. The pane names this
  client's delivery permission and install state, offers the permission request where the browser has
  not been asked, and disables the per-kind switches with the reason in view where the browser will
  not raise them at all. Copy worktree path is available to a browser and reports a clipboard refusal
  instead of doing nothing. Opening a project explains, in the launcher, why a browser has no folder
  picker: a File System Access handle names a folder on the device holding the browser, not one on the
  execution machine. Every refusal is typed and takes its copy from one table, so a capability the
  browser cannot honour always says what stopped it.
  
  The web client no longer stores the credential pasted at the connect prompt. That credential is the
  daemon's root bearer: it authenticates every client and cannot be withdrawn on its own. It is now
  spent once on `device.pair`, and only the client-bound device credential that comes back is kept for
  the tab. A paired client can revoke that device without disturbing any other client, and the daemon
  already closes a revoked device's socket. A bearer parked in session storage by an earlier build is
  dropped at startup. The root bearer still passes through the browser once, and a device credential
  has no expiry, so this is not yet a short-lived credential.
- 6542cb3: Finish the unblocked V2 phone, tablet, and web interface parity work.
- ad121ce: After pairing, a browser tab states what it can and cannot do, measured against this browser, before a refusal is hit inside the session.

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
- 6378492: Browser and desktop clients can keep each daemon's relay identity pin. The shared store runs the protocol's recovery and adoption over any storage that can compare and swap one key, one key per machine; the web keeps it in localStorage under a Web Lock named by the key. A storage that cannot read reports a failure, never an absent pin, so a pin waiting for recovery is not replaced by a fresh enrolment. Once a daemon has answered the hello, the client enrols the identity it publishes as trusted or recovers a distrusted pin from its signed successor, verified against the saved pin only. A refused relay.recovery leaves the saved pin unchanged.
- 4af9799: The composer reads whether the session's model takes images. When its harness reports that it
  takes none, image chips turn red, a notice says how many images cannot go to the model with Remove
  and Change model, send stays off, and the attach menu locks images while text files still attach. When the harness
  has not said, nothing locks and a line says it is not known.
  
  `/checkpoint` takes a checkpoint from the composer, with an optional label, during a turn as well
  as between turns.
  
  Attachment chips are pills with a badge per kind and say where each item is read from, with a
  `+N more` after three. The prompt editor shows the same chips and removes from the same draft.
  
  The preview variant chosen with Build on this, which rides every send of the session, is shown as
  a chip in the composer and the prompt editor, and Unpick on the chip clears it.
  
  The model menu groups models by harness and tags a model that takes no image input. The usage
  popover says why it draws a ring or no dial.
  
  A queued message with images for a model that takes none is held whole instead of being sent to
  be refused, and a send that failed keeps its attachments, so queueing it again sends them too.
- 4a32392: Update production dependencies: the Claude, Kilo and OpenCode provider SDKs in the daemon; Electron 44.2.0 in the desktop; React 19.2.8, Lucide 1.42.0 and react-resizable-panels 4.12.4 in the shared ui and the clients. Development tooling moves with them (vitest 5, shadcn 4.21). The phone follows its Expo SDK: expo 57.0.22, reanimated 4.5.1 and worklets 0.10.1 as the SDK resolves them, jest held at 29 because jest-expo 57 expects it, and a deps:check that refuses drift from the installed SDK.
- 9a015e9: Update production dependencies. The daemon moves to Claude Agent SDK 0.3.281, Anthropic SDK 0.128.0,
  Agent Client Protocol SDK 1.5.0, Kilo SDK 7.7.9, OpenCode SDK 1.18.32, MCP SDK 1.30.1 and yaml
  2.9.1. Claude Agent SDK 0.3.281 is built against Claude Code 2.1.281, so the daemon now refuses an
  older `claude` with "Update Claude Code to 2.1.281 or newer". The floor was 2.1.263. The keyring
  binding moves to 2.1.0, zod to 4.6.5 and vite to 8.3.0. The shared ui and the web and desktop
  clients move to Lucide 1.47.0 and tailwind-merge 3.7.0, and stay on React 19.2.8 and
  react-resizable-panels 4.12.4: the newer two would put startup JavaScript over its budget. The
  phone takes Expo 57.0.24 and stays on the React, safe-area and SVG versions that SDK bundles.
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
- 8337571: The workspace dock's Terminal tab no longer sends a terminal request from a phone or tablet tab
  that the daemon refuses for that credential. A phone or tablet credential may use terminal.list,
  terminal.watch and terminal.unwatch only. The daemon answered terminal.create with an
  authentication error, and the client then closed its connection, so the tab dropped. In a phone
  or tablet tab the Terminal tab now reads the session's shell through terminal.watch, and one line
  says why opening, typing, resizing and taking the shell are off and names the desktop app as the
  place to do it. Desktop and web tabs are unchanged.
- d5b85e3: The effort menu uses the Desktop V2 words and lines for the levels each harness reports.
  Claude Code's scale is now its effort levels low, medium, high and max, in place of think,
  think-hard and ultrathink, which the daemon never reported. Codex reads None, Minimal, Low,
  Medium, High and Extra high (xhigh). The level the daemon reports as the model's default
  carries a Model default tag in the menu; the chip still shows only the level's word. A level
  Domovoi has no word for shows the value it sends, tagged No word yet, with a line that says so.
  The note after a model change moved the effort is drawn in neutral colours instead of amber.
  OpenCode and Kilo Code still report one level, medium or none, and send no effort value with a
  turn, so their menu shows that level rather than Model's own.
- 1f4950d: The "Could not read this session" state shown when a provider stops no longer says "nothing was written, nothing was lost". A provider can write files before it stops. The line now shows only where a caller states the failure only read.
- 3216729: A phone or tablet browser tab no longer sends, on its own, a request the daemon refuses for that
  credential. The daemon answers such a request with an authentication error and the client then
  closes its connection, so every phone or tablet tab with a project open dropped. The tab now lists
  the project's skills (skill.list) without reading the machine's skill inventory (skill.inventory),
  and Settings asks for neither update status (update.status) nor key status
  (provider.secret.list). About this build says the daemon answers update status only over
  loopback to its owner's credential, and Direct API keys says key status is off in a phone or
  tablet tab and names the desktop app. The move dialog no longer asks the daemon for a preview
  (session.transferPreview) as it opens in a phone or tablet tab; it says moving a session is off
  there and offers no Move session. Skills in a phone or tablet tab lists the catalog but disables
  Install, Trust, Revoke and View SKILL.md, and says why, as it does for the machine comparison. A
  queued message with chosen skills is released once the skill list for the current project and
  branch has answered, so a branch change no longer releases it against the old list. Desktop and
  full-access web tabs are otherwise unchanged.
- 92aa4a1: A phone or tablet tab no longer drops when a button sends a request the daemon refuses for a
  phone or tablet credential. The daemon answers such a request with an authentication error, and
  the client then closes its connection. In a phone or tablet tab, Take a checkpoint, Revert and
  Reset on the Checkpoints tab, Restore worktree on the History tab, Revoke on the Rules tab,
  Archive session in a session's menu, Export this query in the audit log, the provider's Try again,
  and Settle this or Release this session on a contested move are disabled, each surface with one
  line that says why and names the desktop app as the place to do it. The Changes tab draws no
  file Revert there and says why, the thread's checkpoint chips draw no Restore worktree, and the
  command palette offers no Take a checkpoint. The shell's handlers for those requests refuse too,
  so /revert in the composer answers with the reason. Desktop and web tabs are unchanged.
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
- 621cd28: The browser limits dialog inside a session names the route the session is on now. When a reconnect changes the route, or the daemon is lost, the open dialog's rows change with the machine chip. They read "the route" when the route is unresolved or unproved.
  
  The command palette opened over the limits closes them. When it closes, focus goes back to the control that first opened the limits, not to the document body.
  
  An Escape pressed just after the palette hands over to the limits, or just after the palette opens over them, now reaches the dialog that has focus. A dialog that is still closing no longer takes it.
- a2f0ba6: Machines no longer sends a request from a browser tab that the daemon refuses for that tab's
  credential. The daemon answers such a request with an authentication error, and the client then
  closes its connection, so the tab dropped. In any browser tab, Pair a machine and Forget
  are off: fleet.enroll and fleet.forget need the daemon's own credential. In a phone or tablet
  tab, Authorize this client and Terminal are off too: fleet.clientRoute and terminal.create are
  not open to a phone or tablet credential. Each locked control says why and names the desktop app
  as the place to do it. The machine menu the sessions drawer opens no longer offers Pair a machine
  in a browser tab either. The desktop app is unchanged.
- e97cfe0: Let paired browser tabs confirm self-sign-out and clear their credential only after a validated success.
- c097707: The preview's variant foot says what the agent builds on. Nothing is chosen until Build on this;
  Unpick clears it. While a variant is chosen, every message sent in that session carries it to the
  agent as the build basis, and a choice that no longer names one of the session's previews is not
  sent. A choice saved by an earlier build, when it reached no message, is dropped.
  
  Picking an element in the dock drafts the comment in a card under the page, with Post the comment
  and Cancel. Comment rows are numbered, say whether the anchor holds or is no longer found in the
  page, and offer Mark resolved.
  
  A design group over 24 variants shows its chips a page at a time, with Earlier variants and Later
  variants, so every variant can be opened.
- 5923ab0: The queue release no longer sends a queued message with images to a session whose model's harness
  reports no image input, including a session that is not on screen and a turn that ends in the same
  update as the model's answer. The message stays queued and held with the composer's notice. A
  message with images waits for the release's own catalog read before it goes; a model that has not
  said whether it takes images, or a read that fails, does not hold it. Text-only messages are
  unaffected.
- da3239c: A new message no longer overtakes a queued message that is waiting to leave on an idle session,
  while the release waits for the skill catalog or for its own catalog read for images. Send stays
  off until the queued message has left, a line beside Send says the queued message sends first, and
  the new draft stays in the composer. A held message does not hold new messages back, and
  unqueueing the waiting message turns Send back on. The plan's carry on waits the same way and says
  why. A queued skill choice whose catalog read failed is held, with a line pointing to Skills to
  retry, instead of waiting for good.
- 797a45d: The machine chip names the route the client dialed: loopback, tailnet (a ts.net
  name or a Tailscale address only), direct over TLS or plaintext, never local. The browser limits page
  reads the route by the same rule, so IPv6 loopback reads loopback and a LAN host
  is not called the tailnet. The theme toggle stays live while watching. Drawer
  rows draw the machine, the state and how long it has held (running 12m, failed
  1h ago, idle 2d), with the running time from the turn start the daemon sends. The web opens the sessions column by default at wide widths.
- 7be3c16: The Skills tab's "Inventories from your other machines" now draws one row per other machine, with its platform, architecture and daemon version and what its inventory says: how many skills it reported, unreachable, or no inventory returned. It used to draw one unnamed row for every skill on every machine, this one included. The per-skill comparison stays on the selected skill.
- 027edc1: Load less code before the first screen. The relay pin's recovery code, with the curve and hash
  libraries under it, now loads only when a distrusted pin is recovered; enrolling or keeping a
  trusted pin never loads it, and a recovery whose code fails to load leaves the saved pin as it
  was. Desktop first-run setup now loads when it opens, on the first launch or from Settings, and
  the web never loads it. Until its code arrives a full-window frame with the setup's name and
  loading bars stands in, and closing it with Escape skips setup as Skip for now does, so the skip
  holds when the code lands. If the code cannot be fetched, open setup says it did not load and
  offers Try again and Skip for now, and the workspace stays as it was. The Settings components no
  longer load with the shell. The web startup script graph drops from 1,287,162 to 1,226,209 bytes
  and the desktop renderer's from 1,276,792 to 1,213,914 bytes.
- 2e203e6: Every instruction to remove a paired client now says Unpair, the word its row on Machines shows,
  and says where that control is: in the desktop app on that machine, under Machines. This covers
  `domovoid pair` output, the Authorize this client dialog, the alert after removing local access,
  the browser pairing cards, the phone's pairing refusals, and `domovoi pair` refusals. Machine
  bindings keep Revoke.
- dace76d: The web build writes `domovoi-web.json` beside the built app: every emitted file with its SHA-256 and size, the workspace version and the protocol version, checked with the schema the daemon loads it with, so a build the daemon would refuse fails at build time. A built page takes its rpc URL from its own location, `wss://<host>/rpc` on https and `ws://<host>/rpc` on http; `VITE_DOMOVOI_RPC_URL` still wins and the dev server keeps `ws://127.0.0.1:47831/rpc`. A page whose origin is not `localhost`, `127.0.0.1` or `[::1]` offers code pairing only: it does not show the daemon credential prompt and refuses a pasted daemon credential before it opens a connection. This is the page's rule; the daemon still accepts its credential from any client it admits.
- 7d8f3e8: A browser tab pairs with the machine's web code again. The connect page greeted the daemon before it sent the code, the daemon refused a greeting from a tab with no credential, and every code was shown as refused while it stayed unspent. The code is now sent alone on a socket that has not greeted, as the phone app sends it, and the socket closes after the reply. The daemon credential path still pairs through a greeting. A refused greeting is no longer shown as a refused code: the page shows the daemon's own words instead. A browser that greets as a phone or tablet no longer keeps a credential a web code bound to web, which the daemon would refuse at the session: it keeps nothing and says which code it needs. The connect page asks that browser for that code by name, a phone code or a tablet code, in its prompt, its field label and its malformed-code card; a desktop browser still asks for the web code.
- 781d45c: The web connect page says where it came from. A page the daemon served shares the daemon's origin, so the first trust fact reads "This page came from the daemon at <host>". A page from any other origin names that host and still says the tab talks only to the daemon. The trust facts sit in the drawn bordered card, and the accepted line leads with the route (loopback, tailnet, direct or plaintext).
  
  Inside the session, the command palette lists "What a browser tab can and cannot do". The limits open as a dialog over the live session, and Back or Escape closes it with the session as it was. Its rows name the route the machine chip shows, loopback or the tailnet only when proved, and the route otherwise. On a phone each limit's reason takes its own line.
  
  The pre-session bar draws the reduced 22px mark. The limits page and the daemon credential prompt no longer draw a second mark tile under it.
  
  After an unconfirmed sign-out, the alert names the controls that check it: Sign this device out, or the connection bar's Retry now.
- 6736af1: A browser tab pairs with the code the machine shows in Settings under Phone and tablet, redeemed through device.redeemCode with no daemon credential. The connect page names the address it dials, says how the tab is trusted, draws the daemon's outcome (accepted, refused, protocol mismatch, device limit, no answer) and reads a code from the address bar once. The daemon credential stays reachable one link down. The sessions column in a browser says it reaches this machine only and that the credential ends with the tab.
- 1bc5ee6: When a browser tab redeems a code for another kind of device, the card no longer says to unpair the extra device under Machines. It names the device the daemon enrolled under this tab's label and says to revoke it in the desktop app on that machine, under Machines, because only the machine's own desktop app can revoke a device.
- bdc2058: The browser limits row "Attach a local file" now says "always a payload" instead of "not yet". The web composer already sends an image or file from the device with the message, because there is no shared filesystem. The row also states the limits the composer enforces: a PNG or JPEG image up to 1.5 MB and 2048 pixels on each side, or a text file up to 256 KB, two per message.
- 60c873e: The connect page's "What a browser tab can and cannot do" link now opens the limits before the tab is paired, with Back to pairing to return. The typed code and any outcome card are kept, and limits read this way are not shown again between pairing and the session.
- c1dc4ba: Opening the browser limits moves focus to their heading, and the way back returns focus to the link that opened them instead of the document body. If pairing finished while the limits were open, so that link is gone, focus goes to the same link on the outcome card. Opened from the accepted pairing card, where the tab is already paired, the button reads Back rather than Back to pairing.
- e0b9a89: When a browser tab's pairing request gets no answer because the connection failed, closed or timed out, the card now offers Try again, which sends the same code again, instead of Type a new code. If the daemon did spend the code the first time, its usual refusal follows. The card says the browser paired if the machine lists it under Machines.
  
  Only a connection failure is retried. If the daemon answered but this tab cannot keep the credential, or the reply cannot be read (including a malformed reply envelope carrying the request's id, which used to wait out the deadline and offer Try again), the code may already be spent: the card says so, offers no retry, and names the device this browser was enrolled as, to revoke in the desktop app on that machine under Machines. Only the machine's own desktop app can revoke a device.
- 2956d86: The pages a browser tab shows before its session (the connect page, the daemon credential prompt and the browser limits) now draw the Web v2 bar: the mark, Domovoi, the page's label and a theme toggle. The theme chosen there is kept where the workspace reads it, so the session opens in the same theme. While the theme follows the system, the toggle follows a change in the system's appearance too. Inside the session the web keeps the desktop bar.
- 1d67a9c: A browser tab no longer offers Rename, Rotate and Unpair (or Revoke, on a machine row) on Machines.
  The daemon takes those only with its own credential and closes a connection that sends them with a
  device credential, which is all a browser tab holds. Each row now says so in place of its
  consequence line, and names the desktop app on that machine as the place to do it.
  
  A browser tab that greets as a phone or tablet no longer asks for the paired-device list, which the
  daemon refuses for a phone or tablet credential the same way. Machines says so where the list would
  be.
- 8da82c3: A protocol refusal while pairing a browser tab now names the side that is older, from the daemon's own compatibility answer. When the daemon is ahead, the card says the page is older and offers Reload this page. When the daemon is behind, it says to update Domovoi on that machine, then show a new code and type it, and offers Type a new code: the daemon checks the version before spending a code, so this code was not used, but the update restarts the daemon and drops it. When the daemon does not say, the card says the versions differ and offers nothing. Before, every protocol refusal said the page was older. Every other refusal still offers Type a new code.
- Updated dependencies [0a999df]
- Updated dependencies [cfb0efc]
- Updated dependencies [077c912]
- Updated dependencies [1dd9ee7]
- Updated dependencies [309562f]
- Updated dependencies [4e3c30e]
- Updated dependencies [2af355e]
- Updated dependencies [1dd9ee7]
- Updated dependencies [5ee1825]
- Updated dependencies [38bffa1]
- Updated dependencies [6b2324b]
- Updated dependencies [df3452f]
- Updated dependencies [17a71e2]
- Updated dependencies [08e4f00]
- Updated dependencies [67375a4]
- Updated dependencies [e790869]
- Updated dependencies [1204d6c]
- Updated dependencies [22b46b6]
- Updated dependencies [07d44bc]
- Updated dependencies [c08fb6b]
- Updated dependencies [2adb117]
- Updated dependencies [2f29554]
- Updated dependencies [1630ca0]
- Updated dependencies [a67f32c]
- Updated dependencies [1204d6c]
- Updated dependencies [ba325c7]
- Updated dependencies [6378492]
- Updated dependencies [4cacf7a]
- Updated dependencies [d927d11]
- Updated dependencies [54424c9]
- Updated dependencies [35d34d2]
- Updated dependencies [1fd8cfe]
- Updated dependencies [572a691]
- Updated dependencies [c7d0175]
- Updated dependencies [54424c9]
- Updated dependencies [4af9799]
- Updated dependencies [dffe022]
- Updated dependencies [b526378]
- Updated dependencies [ab18590]
- Updated dependencies [711bee5]
- Updated dependencies [b7f7c95]
- Updated dependencies [279349c]
- Updated dependencies [d4228ee]
- Updated dependencies [4a32392]
- Updated dependencies [9a015e9]
- Updated dependencies [63db84a]
- Updated dependencies [27f81b2]
- Updated dependencies [3eaa05e]
- Updated dependencies [0fed2e6]
- Updated dependencies [3d67826]
- Updated dependencies [4ac11d0]
- Updated dependencies [950753d]
- Updated dependencies [98ee2c0]
- Updated dependencies [b13b3b8]
- Updated dependencies [4cd4316]
- Updated dependencies [8337571]
- Updated dependencies [ffbec14]
- Updated dependencies [68833ac]
- Updated dependencies [718a807]
- Updated dependencies [d5b85e3]
- Updated dependencies [a37ad78]
- Updated dependencies [f5c27d8]
- Updated dependencies [91b1e15]
- Updated dependencies [a894fcb]
- Updated dependencies [1f4950d]
- Updated dependencies [bd7d00f]
- Updated dependencies [251df6d]
- Updated dependencies [18f6543]
- Updated dependencies [aa0bb15]
- Updated dependencies [1e9925d]
- Updated dependencies [a153e6d]
- Updated dependencies [5f104a3]
- Updated dependencies [c9fb87f]
- Updated dependencies [3408017]
- Updated dependencies [b5b1aa9]
- Updated dependencies [9db320a]
- Updated dependencies [ca22e9e]
- Updated dependencies [9e1e9c5]
- Updated dependencies [5c17e88]
- Updated dependencies [3a2bf89]
- Updated dependencies [c32065a]
- Updated dependencies [86abf95]
- Updated dependencies [a6a1e91]
- Updated dependencies [54424c9]
- Updated dependencies [bddb434]
- Updated dependencies [eac804f]
- Updated dependencies [4359bcf]
- Updated dependencies [8871313]
- Updated dependencies [3216729]
- Updated dependencies [92aa4a1]
- Updated dependencies [24a344d]
- Updated dependencies [569e83f]
- Updated dependencies [f7b3ef3]
- Updated dependencies [d3e5aef]
- Updated dependencies [2f6b60f]
- Updated dependencies [54424c9]
- Updated dependencies [f3252e5]
- Updated dependencies [6000eba]
- Updated dependencies [9d94da3]
- Updated dependencies [b8c55c2]
- Updated dependencies [16c242a]
- Updated dependencies [c3229d9]
- Updated dependencies [6b0e4fd]
- Updated dependencies [8ea383c]
- Updated dependencies [64e9c45]
- Updated dependencies [1204d6c]
- Updated dependencies [f1491ca]
- Updated dependencies [431a7a1]
- Updated dependencies [bb72c15]
- Updated dependencies [bb72c15]
- Updated dependencies [001377c]
- Updated dependencies [bb72c15]
- Updated dependencies [5ae04b0]
- Updated dependencies [bb72c15]
- Updated dependencies [f3a2be9]
- Updated dependencies [621cd28]
- Updated dependencies [3ff73e4]
- Updated dependencies [b67435e]
- Updated dependencies [c07f062]
- Updated dependencies [81c488a]
- Updated dependencies [fb801eb]
- Updated dependencies [6d6a5ca]
- Updated dependencies [ed8084e]
- Updated dependencies [640ae51]
- Updated dependencies [064969c]
- Updated dependencies [b5b1aa9]
- Updated dependencies [bedf4af]
- Updated dependencies [d22da12]
- Updated dependencies [54424c9]
- Updated dependencies [a2f0ba6]
- Updated dependencies [b4d857c]
- Updated dependencies [1a82d9d]
- Updated dependencies [6f3379c]
- Updated dependencies [a5f0f7e]
- Updated dependencies [fe7968f]
- Updated dependencies [6542cb3]
- Updated dependencies [7659301]
- Updated dependencies [59b1a7a]
- Updated dependencies [d5bdbe6]
- Updated dependencies [111d414]
- Updated dependencies [914d73b]
- Updated dependencies [9f8c26a]
- Updated dependencies [9e8ee80]
- Updated dependencies [15af535]
- Updated dependencies [0c88e11]
- Updated dependencies [324d701]
- Updated dependencies [e6fa2ec]
- Updated dependencies [808e077]
- Updated dependencies [e97cfe0]
- Updated dependencies [777efeb]
- Updated dependencies [e736472]
- Updated dependencies [aeb4cba]
- Updated dependencies [66ade99]
- Updated dependencies [e68d767]
- Updated dependencies [0781f6e]
- Updated dependencies [30c547b]
- Updated dependencies [cdf5f87]
- Updated dependencies [8e6e3f2]
- Updated dependencies [42ab37c]
- Updated dependencies [324d830]
- Updated dependencies [45e152d]
- Updated dependencies [02a1b58]
- Updated dependencies [3c2ae09]
- Updated dependencies [98166d2]
- Updated dependencies [2c91512]
- Updated dependencies [8f9ff38]
- Updated dependencies [ac87bef]
- Updated dependencies [30e6093]
- Updated dependencies [0989268]
- Updated dependencies [e268b8f]
- Updated dependencies [1c67fba]
- Updated dependencies [8ec7951]
- Updated dependencies [964c47d]
- Updated dependencies [8984f21]
- Updated dependencies [973430f]
- Updated dependencies [1644a81]
- Updated dependencies [1c5e749]
- Updated dependencies [7bea6a9]
- Updated dependencies [5992436]
- Updated dependencies [19aad21]
- Updated dependencies [c097707]
- Updated dependencies [7f901e8]
- Updated dependencies [e094929]
- Updated dependencies [20e7e91]
- Updated dependencies [9048458]
- Updated dependencies [5a33539]
- Updated dependencies [fb78eda]
- Updated dependencies [5391773]
- Updated dependencies [9387a5d]
- Updated dependencies [c3e566a]
- Updated dependencies [5923ab0]
- Updated dependencies [da3239c]
- Updated dependencies [2b21f85]
- Updated dependencies [559648e]
- Updated dependencies [8522648]
- Updated dependencies [b2e05be]
- Updated dependencies [ef58e04]
- Updated dependencies [9c12124]
- Updated dependencies [48dabb3]
- Updated dependencies [599680a]
- Updated dependencies [69b3c62]
- Updated dependencies [cad2971]
- Updated dependencies [8523d3d]
- Updated dependencies [f0b708d]
- Updated dependencies [1f9539b]
- Updated dependencies [d5a77a5]
- Updated dependencies [2f4a95a]
- Updated dependencies [3ccf0f3]
- Updated dependencies [fc40225]
- Updated dependencies [f94caa0]
- Updated dependencies [a5a510e]
- Updated dependencies [e29f975]
- Updated dependencies [797a45d]
- Updated dependencies [1dd9ee7]
- Updated dependencies [584e7d9]
- Updated dependencies [66a1846]
- Updated dependencies [a1db293]
- Updated dependencies [95f25a8]
- Updated dependencies [6d9029d]
- Updated dependencies [186c82c]
- Updated dependencies [14c51c9]
- Updated dependencies [fdc96ec]
- Updated dependencies [08d34e9]
- Updated dependencies [0b59f4f]
- Updated dependencies [54424c9]
- Updated dependencies [3ce028f]
- Updated dependencies [5aafe95]
- Updated dependencies [055df4f]
- Updated dependencies [67a2c58]
- Updated dependencies [154db88]
- Updated dependencies [31b48d4]
- Updated dependencies [03d4e4d]
- Updated dependencies [0fa2731]
- Updated dependencies [36520ce]
- Updated dependencies [caea81e]
- Updated dependencies [7be3c16]
- Updated dependencies [665d819]
- Updated dependencies [44569b1]
- Updated dependencies [d9ad958]
- Updated dependencies [6ddadb7]
- Updated dependencies [e583a5a]
- Updated dependencies [f9f2352]
- Updated dependencies [cf5823d]
- Updated dependencies [ee3fe90]
- Updated dependencies [027edc1]
- Updated dependencies [9383fb7]
- Updated dependencies [7e30caa]
- Updated dependencies [59b11f1]
- Updated dependencies [191f4fe]
- Updated dependencies [ea2b5ab]
- Updated dependencies [30c31f5]
- Updated dependencies [10635fc]
- Updated dependencies [ac569da]
- Updated dependencies [284ad5e]
- Updated dependencies [6edf0be]
- Updated dependencies [00ed8f0]
- Updated dependencies [801ea64]
- Updated dependencies [7caede1]
- Updated dependencies [728416e]
- Updated dependencies [76f3709]
- Updated dependencies [cc198a2]
- Updated dependencies [9266302]
- Updated dependencies [d936b09]
- Updated dependencies [2793da2]
- Updated dependencies [e84ffb2]
- Updated dependencies [b6aa62d]
- Updated dependencies [4d21256]
- Updated dependencies [41385c3]
- Updated dependencies [2c7ed5f]
- Updated dependencies [ea57213]
- Updated dependencies [8a99cd0]
- Updated dependencies [21275b7]
- Updated dependencies [be9c873]
- Updated dependencies [3879201]
- Updated dependencies [efa49da]
- Updated dependencies [9b60965]
- Updated dependencies [01ce5da]
- Updated dependencies [1ed1cdf]
- Updated dependencies [cb8b27a]
- Updated dependencies [a9b686c]
- Updated dependencies [e72dd56]
- Updated dependencies [28f044c]
- Updated dependencies [c9930be]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [7cf6870]
- Updated dependencies [bb73c79]
- Updated dependencies [09bab9a]
- Updated dependencies [322d3e9]
- Updated dependencies [ef0d241]
- Updated dependencies [b2e5888]
- Updated dependencies [63457d9]
- Updated dependencies [e937e67]
- Updated dependencies [4a53519]
- Updated dependencies [badc888]
- Updated dependencies [118eae8]
- Updated dependencies [6d56837]
- Updated dependencies [e5ba27e]
- Updated dependencies [fb78eda]
- Updated dependencies [358113a]
- Updated dependencies [2e203e6]
- Updated dependencies [1e9f572]
- Updated dependencies [b05db6b]
- Updated dependencies [30760c1]
- Updated dependencies [82a3a67]
- Updated dependencies [4cacf7a]
- Updated dependencies [5484562]
- Updated dependencies [33c937f]
- Updated dependencies [fe7bf5c]
- Updated dependencies [e535558]
- Updated dependencies [f693dc8]
- Updated dependencies [951fa87]
- Updated dependencies [cbadf1a]
- Updated dependencies [9158900]
- Updated dependencies [2cda832]
- Updated dependencies [e4783bf]
- Updated dependencies [3a84912]
- Updated dependencies [45f488e]
- Updated dependencies [1f50a69]
- Updated dependencies [b30b27e]
- Updated dependencies [7d6f7f3]
- Updated dependencies [ad121ce]
- Updated dependencies [b90c8de]
- Updated dependencies [7d8f3e8]
- Updated dependencies [781d45c]
- Updated dependencies [6736af1]
- Updated dependencies [60c873e]
- Updated dependencies [c1dc4ba]
- Updated dependencies [e0b9a89]
- Updated dependencies [2956d86]
- Updated dependencies [1d67a9c]
- Updated dependencies [b85f9f7]
- Updated dependencies [0b81940]
- Updated dependencies [fe208cb]
- Updated dependencies [fa621d6]
- Updated dependencies [d0a58b7]
- Updated dependencies [7e8bcca]
- Updated dependencies [b7d151e]
- Updated dependencies [6832713]
- Updated dependencies [6832713]
  - @getdomovoi/ui@0.1.0-alpha.0
  - @getdomovoi/protocol@0.1.0-alpha.0
