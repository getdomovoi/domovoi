# @getdomovoi/ui

## 0.1.0-alpha.0

### Minor Changes

- 077c912: Show the active session's token total and provider-reported cost in the app bar,
  with the same breakdown the session header already carries.
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
- 1204d6c: Pair a machine through one fleet.enroll call to the daemon, so no machine
  credential reaches the client. The fleet is read as lifecycle entries: pending
  and unenrolled rows render in place, the pairing-required and
  credential-store-unavailable health states get their own copy, Forget is
  offered with the daemon's revocation verdict repeated verbatim, and Use and
  Terminal on a remote machine are disabled because no client credential exists
  for it yet. The workspace hook holds the fleet, applies fleet.changed, and
  lists again on every reconnect. A fleet list the daemon withholds because its keychain
  exceeds the wire limit is shown as withheld, with the entry counts and the
  daemon-side keychain CLI as the remedy, never as an empty fleet.
- 6378492: Browser and desktop clients can keep each daemon's relay identity pin. The shared store runs the protocol's recovery and adoption over any storage that can compare and swap one key, one key per machine; the web keeps it in localStorage under a Web Lock named by the key. A storage that cannot read reports a failure, never an absent pin, so a pin waiting for recovery is not replaced by a fresh enrolment. Once a daemon has answered the hello, the client enrols the identity it publishes as trusted or recovers a distrusted pin from its signed successor, verified against the saved pin only. A refused relay.recovery leaves the saved pin unchanged.
- 4cacf7a: Show Codex OAuth 5-hour and weekly usage windows using provider-reported
  percentages and reset times. Providers that do not report quota windows keep
  the explicit unavailable state.
- 54424c9: Make the composer command list usable from the keyboard. Arrow keys walk the matches, Enter takes the highlighted command instead of sending the half-typed line, and Escape closes the list. The message box is now the combobox that owns the list and reports the active option.
- 0fed2e6: Give `device.rename` an optional `expectedLabel` precondition. When present, the
  daemon renames only a row whose label still reads that way, in one conditional
  update, and otherwise refuses with `deviceLabelMismatchErrorCode` (`-32017`) and
  a `device-label-mismatch` payload carrying the row as it stands. A rename without
  the field is unchanged. Undo in the paired devices table sends the label its own
  rename produced, so a rename from another client in between is kept: the row
  shows the current name, the Undo offer is dropped, and the device action alert
  says the name was changed elsewhere.
- 3d67826: Add `device.rename`, which changes the label on a paired device or machine
  credential row and nothing else. The request carries the device id and the new
  label only; the row keeps its id, binding, credential, and timestamps, so a
  rename can never move a machine identity or a credential. Labels are trimmed,
  bounded like a pairing label, and refuse control characters. The daemon authorizes
  the call like `device.revoke`, refusing a device credential, and records it in
  the audit log against the device id. The paired devices table renames in
  place, with Save and Cancel inside the field and Undo after a commit.
- b5b1aa9: Say what to do about a machine that cannot be used. A protocol mismatch names
  updating the machine as the fix rather than only reporting the mismatch, a fleet
  that has outgrown a machine's version is marked, and a session that cannot move
  back to the machine it came from explains that instead of reporting a diverged
  copy needing manual recovery.
- 54424c9: Give the approval gate its v2 drawing. Allow once stands alone at full weight with Always and Deny outlined beside it, Deny and explain is plain text, and agent and mode move to the header line. Every approval fact is still shown.
- 54424c9: Offer checkpoint restore from the history pane. The thread and the pane share one CheckpointRestore control for the confirmation copy, and one shell-owned guard for the in-flight state, so a restore started from either surface holds the other shut until it answers.
- f3252e5: History rows say what happened in one line, filters are named as the design does with Turns first, checkpoints are reachable as a view of history, and a checkpoint row asks for fork and restore separately. Session-start rows carry the turn meta and drop fork.
- bb72c15: Draw the launcher's sessions, machines and skills as entities rather than verbs: a state dot, the name, a machine-readable line beneath it, and the kind it is. Actions keep their icon and single line.
- bb72c15: Bind Cmd+Enter in the launcher to choosing where a thing runs. A machine starts a session there. A live session opens the transfer preflight and never performs the move, so the existing consent flow takes the decision.
- bb72c15: Let the launcher pick where a live session moves. Cmd+Enter on a session lists the machines it can move to, and choosing one opens the transfer preflight. The launcher never performs the move.
- c07f062: Loading placeholders draw in the shape of what is coming and shimmer, because a still block says nothing about whether anything is happening.
- b5b1aa9: Bind every paired credential to one exact client kind or machine identity. The
  authenticated actor now comes from that binding, not from identity fields a
  caller sends after connecting, so audit entries, approvals, plan edits, and
  transfer decisions cannot be attributed to a different client. Device activity
  is recorded only after an accepted hello.
  
  This is a breaking wire change and moves the shared protocol to 0.3.0. Older
  peers fail at the handshake instead of agreeing to talk and then failing inside
  a call. Transfer wire assertions are now named `initiatedByClient`, and the
  retired pre-contract transfer RPC family is removed.
  
  One migration handles both legacy shapes: credentials that could act as either
  a machine or a person, and client credentials that did not record a client
  kind. Any such pairing is revoked once and must be made again. The record keeps
  the two legacy shapes apart for auditing, and the paired-device list tells one
  upgrade story for both, so a person who skipped both migrations is not told the
  pairing broke twice. Authentication remains deliberately uniform so it does not
  reveal whether a presented credential ever existed.
  
  Daemon and device credentials are now fixed-width 256-bit base64url values. A
  configured daemon credential in the older weak shape is rejected at startup
  with an actionable error. A paired client credential grants ordinary client
  authority, including sending or steering work, answering approvals, and using
  terminals, so it must be protected as an account-equivalent secret.
- 6542cb3: Finish the unblocked V2 phone, tablet, and web interface parity work.
- 30c547b: Redraw the paired devices table around what holds each credential. A leading
  Kind column names a phone, tablet, browser, desktop, terminal, or machine from
  the credential binding, never from the label, and shows the machine id for
  machine bindings. Revoke is quiet until approached and states its consequence
  for that kind before the confirmation opens, as a tooltip where a pointer can
  hover and as standing text on coarse pointers. The confirmation names what a
  client device or a machine loses, in its own words. A rotated credential now
  lands under its row, masked with a fixed run of dots, with Copy as the primary
  action, a reveal control, a copy confirmation, and a fresh mask for every new
  receipt. Loading holds the table shape as a skeleton.
- 20e7e91: Add a `context-window-exceeded` provider failure with a `shorten-context` action.
  A turn that outgrows the model context window is not retryable, so it no longer
  falls through to the retryable unknown failure, and the client tells a person to
  shorten the turn or start from a checkpoint instead of offering a retry.
- 559648e: Reasoning effort can be set again from the desktop and web composer. An effort chip after the mode
  chip shows the current level and opens "EFFORT ON <harness>": one row per level the session's model
  reports, with the design's word and line where it names that level, the value sent in mono, and
  bars. A design line that calls a level the default shows only on the level the model reports as its
  default. A model that reports no levels, or whose list has not been read, shows no chip. A pick goes to
  the daemon through `session.setRuntime` and applies from the next turn. When a model change cannot
  carry the effort, it moves to the new model's default and the effort menu says so until a level is
  picked. The unused Think chip and its helpers are removed.
- 5aafe95: Give settings their own shell. A persistent navigation lists Fleet and machines,
  Skills, Providers, Appearance and window, Permissions and rules, External editor,
  Notifications, and the audit log, and each pane now owns its own component.
  Permissions and rules lists the standing approval rules for the open project with
  the client that created each one. Notifications adds a per-kind switch for
  completions, failures, and approvals, stored with the other client preferences and
  never sent to the execution machine.
- 31b48d4: Add a skill from a folder on the execution machine after a review. `skill.installPreview` returns
  the parsed manifest, the declared capabilities, the content and source digests, the signature and
  trust state, the file list, and the install targets per scope. `skill.install` copies the folder
  into the `user` or `project` Domovoi skill root only when its digest still matches the preview,
  refuses a blocked skill, a link that leaves the folder, and an existing name with different files,
  stages the copy inside the root and renames it into place, and audits the result. The Skills
  surface gains an Add skill review step with the scope choice, and `domovoid skill add` prints the
  same review and installs with `--yes`.
- 0fa2731: A skill re-review leads with what the revision can now do; an unrecorded baseline is called a first review, and the re-review asks about the change rather than the digest.
- 36520ce: Verify skill signatures against a local trust file. A `SKILL.md.sig` whose Ed25519 signature
  over the content digest verifies against a key in `~/.domovoi/skill-trusted-keys.json` now yields
  a trusted state; a key the file does not list stays unverified, and a failing signature or content
  changed since signing is blocked. `domovoid skill keygen`, `sign`, and `trust` create a signing
  key, sign a skill, and add a public key to the trust file. The delivery record on a sent turn
  carries the trust state each delivered skill had, and the skill browser names an untrusted key.
- b5b1aa9: Settle a session two machines claim. When a target turns out to already hold the
  session, the source freezes instead of thawing, so the two copies cannot both be
  written. Conflicts record how they were found, either a target that was observed
  to hold the session or a recovery that was later contradicted, rather than
  recording one as the other.
  
  The way out is deliberately one way. A machine can give up its claim and let the
  other keep the session; it cannot take the session back, because that needs the
  other machine's agreement and not a local click. Releasing leaves the worktree in
  place and readable, and nothing removes it automatically.
  
  A released session is recorded as released rather than as a completed move, so it
  never reports that a transfer succeeded when what happened is that this machine
  gave up.
- b5b1aa9: Agree what a move carries before it happens. A transfer is previewed first, and
  the move is refused unless it carries the contract version and intent digest the
  preview returned, so a session that changed after the preview cannot be moved on
  a stale description of itself. When that happens the dialog previews again rather
  than leaving a digest that can never be accepted.
  
  The dialog lists what the daemon reports the move will carry, instead of a list
  maintained beside it that had drifted into promising things the contract never
  moved.
- b5b1aa9: Give a frozen session a way out. A move that stops leaves the session read-only,
  and until now nothing in the product could release it, so recovery meant sending
  a request by hand. Sessions that are moving, moved, released, or in conflict each
  explain their own state, and where the daemon offers a recovery the notice
  carries it behind a confirmation that states the trade before it is made.
  
  A move that does not finish also says which stage it reached and what answers it,
  instead of reporting every unfinished move with one sentence.
- e937e67: Bound every wait on a daemon or another machine with one shared deadline. The
  browser client now requires connect and request budgets, so a socket that never
  opens or a hello that never answers fails as a typed timeout at the connect
  budget instead of waiting forever, and a request can carry a caller's deadline
  which the client's own budget can only tighten. Reconnect attempts each get the
  full connect budget and a timed-out attempt is torn down before the next one.
  Claiming a pairing code, greeting the new machine, and storing its credential
  share one pairing deadline, as do the transport candidates dialed to reach
  another machine. `DomovoiRequestOptions.timeoutMs` is replaced by `deadline`.
- fb78eda: Show today's usage across every session on the connected daemon in the app
  bar, where the desktop handoff places it: provider-reported cost when every
  turn reported one, otherwise the token total, with the session and turn
  counts and any turn without a cost in a tooltip. The readout refreshes when
  any session starts or finishes a turn, on reconnect, and at local midnight,
  and today is the viewer's local calendar day.
- fe7bf5c: The app bar no longer carries a session usage summary or a today readout.
  v2 has one usage surface, the chip in the composer, and the app bar's two
  were v1 leftovers.
- e535558: The dock gains v2's Checkpoints tab: the session's checkpoints newest first, each with Fork and Revert (Reset on the session start), loaded from the history's checkpoints category. Tabs sit in v2's order. The Checkpoints command and the "see checkpoints" affordances open the tab instead of History narrowed to one filter. The checkpoint dialogs move to `checkpoint-actions.tsx` and take a trigger label.
- f693dc8: The dock no longer carries a cost-and-context footer. v2 has one usage
  surface, the chip in the composer, which already shows the context share.
- 951fa87: The dock's tab list is v2's: Plan, Preview, Changes, Terminal, History,
  Checkpoints. The v1 Session tab is gone; the app bar already names the
  machine and project. Comments are no longer a tab: they sit under the
  preview frame, counted, as the design draws them. The collapsed rail shows
  one icon per tab in the same order.
- cbadf1a: The permission mode moves from the thread header to v2's chip in the
  composer beside the model, opening "Mode for the next turn" with the three
  modes and an Auto row that is live only in Build. Think sits beside it as a
  plain chip. The header's runtime controls are gone.
- 9158900: Choose the model from v2's chip in the composer. The chip opens one flat,
  searchable list of every model each harness on the machine reports,
  narrowed by harness, with a harness that cannot run here listed dimmed with
  the reason. "Ask the agents again" runs discovery. Switching still asks
  whether to change this session or fork one. The header keeps reasoning,
  mode and Auto for now.
- 2cda832: Edit the working plan from the strip above the composer, the way v2 draws
  it. Edit opens the same step editor the Plan preview uses, inside the
  expanded strip, and submits against the structure revision that was on
  screen. The queued notice names the step the edit changes. Edit is dimmed
  with a reason for a read-only viewer. Discard and Plan preview on the strip
  now reach the daemon and the dock.
- e4783bf: Add v2's Rules tab to the dock: the project's standing rules with their
  scope and use count, a one-click Revoke through `approvalRule.revoke`, and
  the daemon's own hard-gate categories under "Never covered by a rule". The
  dock's tab list is now the full v2 seven.
- 3a84912: The sessions drawer is v2's column beside the thread, reachable from any
  surface, with collapsible groups that carry their counts, the machine named
  beside each session's state, and each row's own menu: stop the agent, fork
  from a checkpoint, move to another machine, archive. Picking a session keeps
  the column open; only its button closes it.
- 1f50a69: Move session usage out of the thread header into v2's usage chip beside the
  composer. The chip names token counts only: the context the next turn runs in,
  or the session's total when the provider reports no context. It opens rows for
  the last turn, the session, the context share and today's count. It shows no
  cost until the wire says whether a session runs on a subscription or an API key.
- ad121ce: After pairing, a browser tab states what it can and cannot do, measured against this browser, before a refusal is hit inside the session.
- 7e8bcca: The workspace shell wires what the launcher, skeletons and empty states already can do: start a session on the machine the launcher names, pick a transfer target there and decide in the preflight, reach first-run setup from the launcher, draw loading in the shape of what is coming, and say which emptiness each empty state is. Status dots go through StatusDot everywhere, and a lint rule quotes the design system on it.

### Patch Changes

- 0a999df: Settings gains About this build: the daemon's version and source commit, that this build is not signed and does not update itself, and the release page where new versions come from. The desktop opens that one fixed address in the browser; a browser tab links it.
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
- 17a71e2: Archiving says what it does. The confirmation lists what is removed (the worktree directory, the agent and its terminals) and what is kept (the branch, the final checkpoint, the thread), and its actions are Archive and remove the worktree or Keep the session. An archived session stays listed under QUIET, its row menu says why fork, unarchive and delete are absent, and the head of its thread says the worktree was removed and the branch and checkpoint are kept.
- c08fb6b: The Changes tab heads its file list as evidence per file, asks Revert this file or Keep it, and on the desktop opens the worktree in the chosen editor from the foot of the list.
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
- a67f32c: Desktop and web correctness. Attaching to another machine no longer drops the changes that arrived while the client was being admitted: the hello snapshot is applied once, before the buffered changes, and not again after them, on connect and on reconnect. Pause everything now says so when the daemon refuses the pause or cannot be reached, and keeps the local hold. Settings, Skills, Machines and the Audit log load when first opened instead of at launch, which takes about 76 KB off the web startup JavaScript.
- ba325c7: A `null` frame from the daemon no longer throws inside the desktop and web client's message handler. Like a number or an array, it is reported as a message the client could not classify.
- d927d11: Place the caret after an accepted composer command. Choosing a command whose text the message box already held changed nothing, so the caret stayed where it was and the argument was typed in front of the command.
- 35d34d2: Return focus to the message box after a composer command is chosen with the pointer, so typing the command's argument continues in the message instead of going nowhere.
- 54424c9: Removing a queued turn from the composer now removes it from the queue the parent holds, through `onQueuedChange`, rather than only clearing the composer banner while the turn stayed queued.
- dffe022: Mark the point where a provider compacted its context. A system thread row can now carry a context-compaction notice, and clients draw that row as a boundary in the transcript rather than as a general system banner. The copy states both halves of what happened: the provider stopped reading the turns above it, and Domovoi still holds them. A snapshot written before the notice existed keeps parsing, and every other system row keeps its existing styling and detail line.
- 711bee5: Settings opens with Daemon on this machine: whether this app, the installed login service or another window holds it, what quitting does, and what installing the service writes on this platform. Install and Remove are drawn locked with the command that does the job beside them.
- b7f7c95: The switch to or from the login service is now held by the daemon itself. `system.serviceHandoffFence` (loopback, daemon credential only) answers the same refusal as the window's check, or, when nothing runs, no dispatch is in flight and no gate waits, admits no new turn until the connection that took it closes. The desktop takes it right before it stops the daemon inside the app or removes the service, so a turn that starts after the first check makes the switch wait instead of being stopped.
  
  Staging the shipped runtime refuses an app version that is not one release version, a `~/.domovoi` or `~/.domovoi/runtime` that is a link, a shipped part that is not a regular file, and a link that leads outside the shipped runtime, all before any byte is copied. Links inside the runtime are copied as they are. An earlier copy of the same version is moved aside and put back if the new copy cannot be renamed into place.
  
  After a failed install or removal the desktop reads the service back and reports it, along with the daemon it reaches afterwards, including one this app did not start. Settings no longer says nothing was installed or removed unless the read-back shows it.
- 279349c: The desktop can install the daemon as a login service from Settings and remove it again. The app copies the runtime it ships under the profile, asks the daemon's own installer to register the service pointing at that copy, and only then stops its in-app daemon and attaches to the service. The switch refuses while a turn runs or a gate waits and names the sessions; a runtime the app does not ship is reported without touching anything.
  
  Install and Remove both wait while a turn runs or a gate waits. The desktop main process checks this too, before anything is stopped: it reads the workspace from its own daemon (`readLocalServiceHandoffRefusal` in `@getdomovoi/daemon`) and applies the same check the window uses (`serviceHandoffRefusal` in `@getdomovoi/protocol`). A workspace it cannot read also makes the switch wait. While the service takes over the profile or gives it back, a window reconnect waits for the handoff instead of starting a daemon inside the app. The runtime copy is made in a fresh directory and renamed into place, so no file from an earlier copy of the same version survives. Settings says when the service was installed but this window could not reach it, when the daemon inside the app stopped and did not start again, and what to run when a removal leaves the profile owner unresolved. A daemon running outside the app is drawn as the installed service, with Remove available, only when the desktop reads the service as installed from the service manager.
- 4a32392: Update production dependencies: the Claude, Kilo and OpenCode provider SDKs in the daemon; Electron 44.2.0 in the desktop; React 19.2.8, Lucide 1.42.0 and react-resizable-panels 4.12.4 in the shared ui and the clients. Development tooling moves with them (vitest 5, shadcn 4.21). The phone follows its Expo SDK: expo 57.0.22, reanimated 4.5.1 and worklets 0.10.1 as the SDK resolves them, jest held at 29 because jest-expo 57 expects it, and a deps:check that refuses drift from the installed SDK.
- 3eaa05e: On macOS the titlebar content starts past the window buttons by an inset derived from where the desktop placed them, so the mark no longer lands on the green button. Windows and Linux get no inset.
- 4ac11d0: Put the artifact dock on the background its accent was chosen against, so the
  lit tab reads as lit. The panel sat one step lighter than the design, which cut
  the contrast of the only cue that says which tab you are on by a third.
- 950753d: Keep a pinned artifact dock open across a reload. The shell collapses the dock
  when a window is too narrow to hold it beside the thread, and it read that
  width from the first resize observation, which arrives before the shell has
  been laid out and reports zero. An unmeasured shell now decides nothing, so a
  pin survives a refresh on any window wide enough to honour it.
- b13b3b8: The Checkpoints tab can take a checkpoint, with an optional label, without going through the command palette. It is disabled while a turn runs and absent while watching.
- a37ad78: Each empty state in the audit log, session evidence and skill browser says which emptiness it is: nothing recorded, or nothing matching the filter.
- 251df6d: Update Lucide icons, including the check mark in health and session evidence indicators.
- ca22e9e: Reserve time for fallback routes inside one overall fleet dial deadline. Each eligible route gets
  a share of the remaining time for connection and authenticated hello, so a silent first endpoint
  cannot consume every later route's allowance. Cancel abandoned attempts, reject late results, and
  retain typed timeout refusals naming a sanitized address instead of arbitrary transport error text.
- 5c17e88: Render FloatingSurface in a portal so an ancestor cannot clip it; the mode list's first rows are reachable again.
- 3a2bf89: Align the colour tokens with the Claude Design Foundations page and give the phone generator the
  facts it was missing.
  
  `packages/ui/src/styles.css` takes Foundations as drawn. The light neutrals move from the cool
  285 hue to the warm 90 hue Foundations uses, the light semantic ramps darken to the contrast the
  page states, and `--warn-fill` with `--warn-fill-fg` join both themes. Dark changes in four
  places only: `--faint`, the two new tokens, and the `--shadow-lg` alpha.
  
  `scripts/mobile-tokens.mjs` now emits three things React Native needed and could not derive:
  `withAlpha` with the fourteen alpha steps the two designs actually use, per-theme shadow objects
  for the md, lg and xl steps, and the list of tokens that fall outside sRGB. `AlphaStep` is a
  union of the enumerated steps, so an unlisted step fails typecheck while runtime stays forgiving.
  
  `--faint` is recorded as a bounded exception in `packages/ui/src/accessibility.test.tsx`. Both
  themes hold AA Large rather than AA, the assertion pins that band on both sides, and a token that
  drifts below 3:1 or quietly reaches full AA fails. Anything using `--faint` for essential text
  must use `--muted-foreground` instead.
- 9d94da3: Add retained rule revocation, persisted use counts and renderable hard-gate categories for the Rules tab.
  
  The wire protocol moves to 0.7.0. Update clients and daemons together: a peer on another minor version is refused at `system.hello` with `-32012`.
- 64e9c45: Offer the ride back whenever a thread sits away from its bottom. A streaming
  reply grows one row rather than adding rows, so the unseen count can stay at
  zero while the thread keeps moving, and the pill used to stay hidden. The
  count is still the label when there is one.
- 431a7a1: The launcher's provider picker lists only the harnesses that reported. One that is not
  installed no longer appears as a greyed item that can never be chosen; the readiness list
  beside the picker still states "Not found" as a fact. A harness that needs a sign-in stays
  listed with its reason.
- bb72c15: Offer first-run setup from the launcher footer, so a machine that no command can help with yet has somewhere to go. It hides while a transfer target is being chosen.
- 5ae04b0: When every harness is missing, Start a session shows a search report instead of a status list: what the daemon looked for, the PATH it searched, and that finding nothing there is not proof nothing is installed. The daemon reports the searched PATH on the machine (machine.toolPath), and a missing harness reads Not found rather than Not installed everywhere.
- 6d6a5ca: Permission mode and session lookup tables are typed over their unions, so a new member fails to compile instead of falling through.
- bedf4af: Hold the machine sheet's opener above the pin and unpin swaps, so closing the sheet after a pin cycle returns focus to the rail control that opened it instead of to the document body.
- d22da12: Place focus deliberately when the dock is pinned or unpinned. Pinning unmounts the floating sheet rather than updating it, so its focus-return cleanup sent the keyboard back to whatever opened the sheet.
- 54424c9: Stop pinning an open machine sheet from throwing keyboard focus back to whatever opened it, and return focus when a pinned sheet closes.
- b4d857c: Machines names the daemon whose paired devices it lists, and says each daemon keeps its own list.
- 6f3379c: Ship Instrument Sans and JetBrains Mono inside the phone bundle and register them
  before the first frame, with each text style naming its loaded face. The phone's
  colours, radii, and font names are now generated from `packages/ui/src/styles.css`,
  which gains the design system's desk, overlay, danger-on, and info ramp tokens.
- 59b1a7a: `modelDisplayName(modelId, harnessId)` derives a model's short name from its id: drop every
  token the harness name already says, then replace hyphens with spaces. `claude-sonnet-4.6` under
  `claude-code` reads `sonnet 4.6`; `gpt-5.3-codex` under `codex` reads `gpt 5.3`. A model that
  arrives from `runtime.discover` needs no second name written for it.
  
  The desktop and web model chip now reads `<harness> · <short name>`, and each row in the model
  list shows the short name with the full id in mono beside it, because the id is what the audit
  log and the provider's error say. A harness that did not report is absent from the filter row and
  the list rather than greyed; one the snapshot called missing appears once discovery hears models
  from it. The count line reads how many harnesses reported.
- 9e8ee80: The sessions drawer leads with NEEDS YOU, then RUNNING, then QUIET. A session holding an
  approval sits under NEEDS YOU even while its turn is still in flight; its row still says the
  machine is working. Before, RUNNING led and a gated running session sat under it with a note
  that read "waiting on you", so the group label and the row disagreed.
- aeb4cba: Answer a send straight away instead of after the round trip. The composer used to hold the typed words, disabled, until the daemon replied, and the request budget is 120 seconds, so that was the worst case silent window. The queue path already cleared the box on the press, which left the interaction where less had happened looking like the faster one.
  
  The composer now empties on the press and the message appears beside it as a sending note until the daemon answers. The note is local and is never a thread item, so the daemon stays the only owner of thread state and no local row can stand beside the real one. A refused send puts the words back, unless the person has already typed something newer, which is kept instead.
- 45e152d: Settings gains Phone and tablet: a pairing card that shows the daemon's own pairing code for a phone, tablet or browser, with its QR, address and 180 second countdown, and says why no code can be shown when the daemon answers on loopback only or reports no certificate. The shared list of what a paired device can do now carries six lines, including that gates reach a device only while its app is open, and the terminal line is the short one.
- 8f9ff38: The command palette searches sessions on every admitted machine, asking each one directly for titles and summaries, and says what each machine answered. A machine that does not answer is shown as not searched, never as no results, and can be left out. Picking a row on another machine switches the window to it and opens the session.
- 0989268: The desktop's "Pause all" sent `system.emergencyStop`: it blocked every provider, aborted the
  workspace and killed every terminal, while its label promised a pause. `system.pauseAll` existed
  on the wire and in the client and nothing called it.
  
  The app bar button is now "Stop everything" and opens a menu with two items that each say what
  they do. "Pause everything" calls `system.pauseAll` and stops at the next turn boundary; nothing is
  killed. "Emergency stop" calls `system.emergencyStop` and says that processes are killed now and
  half-written files stay half-written. The command palette lists both commands under the same
  names; the old "Pause all" command that sent the kill is gone. The error banner reads "Emergency
  stop failed" for the stop it reports.
- 1644a81: Answering a plan no longer closes a pinned artifact sheet. An overlay sheet
  still steps aside, because it covers the thread the reply lands in.
- 1c5e749: Let a prose plan be accepted from the plan panel
  
  A provider that writes its plan as prose produces a plan document and no steps,
  so the card that carries the decision row never rendered and the panel offered
  no way to answer. The plan panel now carries the same decision row for a prose
  plan, and says that selecting a line comments on it.
- 7bea6a9: Report a touched file path exactly as the provider named it. A leading or trailing space is a legal character in a path name, so the previous trim could name a file the provider never did and could fold two distinct paths into one, making the file count wrong. Whitespace alone is still rejected.
  
  Show a refused plan reply. Accepting a plan written as prose now surfaces the failure next to the button instead of returning it to its resting label in silence, and the branch no longer invites a line comment it cannot take.
- f0b708d: When the desktop cannot open the browser for the release page, About this build says so and gives the address as selectable text.
- 1dd9ee7: A standing approval rule now covers only what the approved request could reach. A file-tool
  rule matched the tool anywhere in the worktree, so one "Always in this project" on an Edit approved
  later edits to `package.json`, test files and runner configuration; and a rule for any other
  provider tool matched on its bare name, so one WebFetch rule approved every later fetch, including
  one that carries data out, and one MCP rule approved every call to that tool.
  
  File-tool requests now resolve to a record scoped to the target file (`coverage: "tool-and-file"`,
  `scope: "file"`, `path`), so a rule covers that tool on that file. Rules made for the whole
  worktree stay listed and no longer match; Settings says so. Requests for provider tools that are
  neither a shell command nor a file tool, such as WebFetch, WebSearch and MCP tools, stay unresolved,
  so no standing rule can be made for them and each one asks.
  
  A file-tool request aimed at the worktree root itself names no file and now stays unresolved. It
  used to fail validation while resolving, so the request got no card and the provider waited for an
  answer that never came. Resolving a request no longer throws at all: one it cannot fingerprint is
  unresolved, which still raises a card and makes no standing rule. Claude's Read, Glob, Grep and Task
  requests stay unresolved inside and outside the worktree, so each one asks and none can become a
  standing rule.
  
  A file-tool target is read the way the filesystem reads it: each link is followed before the `..`
  after it applies, a dangling link leads where it points, and a relative path starts at the request's
  directory. A rule for an inside file no longer matches a path that a link carries outside. The
  Claude adapter passes the file name exactly as the provider will use it, untrimmed and with `..`
  kept. A `package.json` that is not a regular file, or that is too large or too slow to read, leaves
  a script run unresolved instead of holding the request.
  
  A provider tool is identified by the tool that runs, not by fields in its input: an MCP request
  whose input carries `command: "Edit"` and a `file_path` stays unresolved instead of taking the
  Edit rule's digest, a Claude file tool is always named by its tool, and a Bash request never
  sends a file path. Approving a file-tool card reads its target again first, the way a changed
  package script already was: if the file the edit reaches changed while the card waited, for
  example because a directory on its path became a link out of the worktree, the edit is not
  released and the card is updated for review. A card updated this way keeps its hard gate. The
  refusal for a file-tool card reads "The file target changed; review the updated approval before
  allowing it"; a shell or script card keeps "The resolved command changed". The check runs when the
  card is answered, not when the provider writes, so a target swapped in between still reaches the
  provider. The path each waiting file-tool card was raised for is held in memory and dropped once
  the card leaves, whether it was answered, archived, cleared by a provider disconnect, session close
  or emergency stop, or expired.
  
  A file-tool target that is a file with more than one hard link stays unresolved: its other names
  share its bytes and may lie outside the worktree, so no standing rule applies to it and its card
  offers no Always. Domovoi never releases an edit to such a file: moving one of its other names
  changes nothing Domovoi reads at the file, so Allow once is refused with "This file has other names
  Domovoi cannot check, so Domovoi will not release the edit.", both for a file that had another name
  when its card was raised and for one that gained a name while the card waited (that card is also
  rewritten under its next revision). A file that does not exist yet is unaffected. An
  existing target that is not a regular file (a directory, FIFO, socket or device) stays unresolved
  the same way, read with lstat only, so a FIFO is never opened; a regular file replaced by one while
  its card waits is refused when the card is answered.
- 584e7d9: Derive runtime build versions from release metadata. Fleet facts, daemon and client greetings,
  and provider initialization report the running release instead of a fixed development version.
  Production startup refreshes the persisted local version without changing machine identity.
  Wire protocol compatibility and existing pairings are unchanged.
- 14c51c9: Keep the unsent draft when the person switches sessions. The shell keys the thread on the active session, so a switch remounts it. That reset is correct for the pending send, the error alerts and the transfer receipt, and it stays. It was not correct for the half-written turn, which was thrown away with everything else.
  
  A bounded per-session draft store now holds the prompt, the staged attachments, the selected skills and the open prompt editor outside the component, so a switch and a switch back returns what was typed. Drafts stay separate per session, an empty draft is stored as no draft at all, and the store keeps at most twenty sessions, dropping the least recently written, so a long session list cannot grow it without end. Sending clears the draft, because the cleared prompt writes an empty one.
- 54424c9: Fix three defects in the sessions drawer. Choosing a session from another surface now opens its thread instead of activating it behind the surface that is still on screen. The trigger closes the drawer instead of reopening it. The open session is named with a Current mark and aria-current rather than by background tint alone.
- 67a2c58: Move the shadcn CLI out of the shared UI production dependency graph.
- 03d4e4d: Refresh the skill catalog only when the machine facts or the project's id, path, or branch change,
  cancel the requests a superseded refresh left in flight, and dial fleet inventories through a pool
  of four that asks online machines first and stops when the refresh is cancelled. A daemon's late
  answer to a cancelled or expired request is dropped instead of being reported as a protocol error.
- cf5823d: `workspace-shell.tsx` is split into one module per surface: `thread.tsx`, `artifact-dock.tsx`,
  `launcher-dialog.tsx`, `history-panel.tsx`, `app-bar.tsx`, `workspace-selectors.ts` and
  `restore-focus.ts`. Every public name is re-exported from `workspace-shell.tsx`, so nothing
  importing it changes. No behaviour change.
- ee3fe90: Add separate, kind-bound remote client grants and Fleet client admission. A machine pairing remains daemon-to-daemon authority, not permission for a desktop or browser to control the target.
  
  Operators issue a separate client credential on the target with `domovoid pair --client desktop --label "My desktop"`, then choose Authorize this client in Fleet. Use, Terminal and inventory reads require the target identity and client receipt to verify. Desktop main verifies each enrolled route through the home daemon and grants only that exact socket origin. Update both daemons and the client before using these additive calls. The wire remains 0.5.0, existing pairings remain valid and no re-pair is required.
  
  Client credentials stay only in app memory. Closing the app or removing local access does not revoke the remote grant; revoke the device in the target's Devices list. Remote Desktop preview frames remain unavailable until they have a separate verified path. This does not enable a hosted relay or expose the daemon's machine keychain to the client.
  
  Desktop serves its bundle from an explicit app origin so response CSP is enforced. Existing development profiles may need appearance, layout and first-run preferences selected again because old file-origin browser storage is not migrated. The daemon profile and its canonical sessions are unchanged.
  
  If `DOMOVOI_ALLOWED_ORIGINS` is explicitly configured, add the exact `domovoi-app://desktop` origin and restart that daemon. The default configuration already includes it; custom lists are not silently widened.
- 9383fb7: Desktop and web show a dismissible notice when the connected daemon moved unreadable stored state aside at startup. It names the kept file and says whether paired devices were kept.
- 59b11f1: StatusDot carries its label to a screen reader only, so a dot's meaning is read aloud without being drawn twice.
- 10635fc: Surfaces say what exists: the phone's empty states print the pair command the machine really runs and no installer or `domovoi new`; the pairing credential is described as it is scoped; the fleet's UPDATE badge, which had no update path, is gone.
- ac569da: Stop the working bar's sweep when the viewer asks for reduced motion. The bar parks at the head of its track and the label beside it carries the turn state, matching how the loading skeleton already answers the same preference.
- 2793da2: The terminal pane names its state in text rather than leaving colour to carry it alone.
- e84ffb2: The light and dark flip animates: 200ms on `--ease-out` across background-color, border-color,
  color, fill, stroke and box-shadow, collapsed to 0.01ms under `prefers-reduced-motion`. It is
  transient, not standing: a `dv-theming` class is armed in the same call that changes the theme
  and removed after 240ms, so hover backgrounds keep the design system's instant step. The first
  paint and a repeat of the same theme do not animate.
- 4d21256: Name the files a turn touched in the thread. A finished run of tool calls now
  carries a chip per file with the lines it added and removed, and a chip that
  opens the full review. Counts appear only where the provider reported a diff,
  and the review chip states the true total even when the row lists fewer files.
- 41385c3: The thread sticks to the bottom only when it is already there. New output while the person
  is at the bottom scrolls to the end; scrolled up, the viewport holds still and a pill above
  the composer offers the ride back, reading "3 new" for output or "Waiting on you" when a gate
  arrived below. A gate no longer moves the viewport: the approval card's `scrollIntoView` is
  gone, and the pinned plan strip already announces a gate without hijacking scroll. Before,
  the desktop never followed at all and the only scroll it did was the one that moved the
  viewport under a person reading an earlier turn.
- 2c7ed5f: Keep the end of a streaming reply in view. The thread followed the number of rows, so a reply that streamed into a single row grew below the fold and the reader had to scroll by hand. At the bottom the thread now follows the scroll height instead. A reader who has scrolled up is still left alone, and growth inside a message they can already see is not counted as new.
- 8a99cd0: Read the viewport at most twice per frame while scrolling. A scroll gesture fires many events per frame, and both the thread follow hook and the floating surface measured layout on every one of them: three forced reads per event in `useThreadFollow`, and an anchor measurement plus a state update in `FloatingSurface`, the latter on a capture phase window listener that fires for every scrolling pane on the page.
  
  Each now reads inline on the first event of a frame, drops the rest, and takes one trailing read on the next frame so the resting position is never missed. The follow pill and the surface position still answer the first event without delay, so there is no added latency at the start of a gesture. Tests pin the read count for a burst and pin the trailing read that lands the final position.
- 21275b7: Open a thread with a scrolling start line instead of a fixed banner
  
  The session header repeated the session title, the absolute worktree path and
  the file and test counts above every turn and never scrolled away. v2 names the
  session in the command palette pill and opens the conversation with one mono
  rule carrying the repository, branch, worktree name and start time. The worktree
  action keeps the editor the operator chose and is reached from the command
  palette, and a read-only session still says so above the composer.
- 3879201: Show the working row while a turn runs before its first tool call
  
  A running turn drew nothing in the thread until the agent called a tool, so a
  long first pause looked like a stall. The thread now renders the activity row in
  its working state, with the pulse bar, until a tool row takes over the signal.
- 9b60965: Carry how far a tool call moved each file, so the thread can name a touched
  file and its added and removed line counts. A count derived from the worktree
  would describe the tree now rather than that turn, and would drift once a
  later turn lands. An entry stays a bare path when the provider reported no
  diff, and an older snapshot that lists paths only still loads.
- 01ce5da: Report the files a turn touched on the activity row
  
  A tool thread item can now carry the paths that call touched. The activity row
  reads those paths to show how many tools ran, how many distinct files they
  touched, and which tool is still running. Counts come from reported paths only;
  nothing is inferred from a command title. Older snapshots without the field
  still load.
- 7cf6870: Validate direct transport kinds as a discriminated contract before selecting an endpoint.
  Local, WSL and SSH routes require loopback; LAN and tailnet require non-loopback TLS endpoints.
  Only SSH accepts a configuration flag, and it must be explicit. Reserved relay records cannot
  be enabled through the legacy availability flag. Endpoint bounds and credential-protection
  rules are shared with enrollment. A loopback advertise host is now classified as local.
  The client dialer uses the same eligibility rule and returns safe typed refusals for invalid
  descriptors, without copying endpoint contents or schema diagnostics into the error.
  
  Previously accepted contradictory cached descriptors fail closed. Ship this change with the
  damaged fleet-row quarantine so those records remain visible and recoverable through fresh
  enrollment rather than being silently relabelled.
- 322d3e9: Travel the working bar and stop the chip opening an empty list
  
  The running bar faded in place, which reads the same as a render that has
  stopped. It now sweeps the track as the design set specifies. The chip also no
  longer offers to expand before the first tool call, when there are no steps to
  show.
- 63457d9: Give the small-type floor tokens and use them. Sans prose bottoms out at --text-micro, with exactly two named roles below it: --text-eyebrow for uppercase section labels, carrying its own letter-spacing, and --text-mono-xs for machine output in dense rows. Forty raw 9px values and six raw 8px values had no token behind them and are now expressed as one of the three roles. Truncation notices leave the metadata row and name their limit beside the output they cut.
- 4a53519: Report every prompt trim in the delivery note under a sent message. Open
  annotations dropped for the prompt budget or the per-turn limit, and handoff
  thread items, annotations, and artifacts trimmed to fit the prompt, each get one
  short line after the skill lines in the daemon's documented drop order. The
  note's tooltip states the measured prompt size against the recorded budget.
- badc888: Hide plan wrapper tags in a streaming assistant reply. A provider that returns a plan wraps it in
  standalone marker lines, and the daemon removes them only when the turn completes. The thread now
  removes complete and partially streamed markers as the reply arrives, and separates surrounding
  prose from the plan with a blank line so the two do not merge into one Markdown block.
- 118eae8: The approval receipt, the plan strip, the policy refusal card and the danger and info chips draw their tinted frame and header again. The info and danger colour families were used by name but never registered with the sheet, so the utilities produced no CSS and the header text took the on-solid contrast colour, which vanishes against the page.
- 6d56837: The machine sheet's scrim draws again (bg-overlay was never registered). A test now compiles the real sheet, scans every source the sheet names with the build's own scanner, and fails on any colour-carrying utility that resolves to no CSS.
- e5ba27e: The usage chip and its popover show tokens alone, with no dollar figure, until the wire says whether a session runs on a subscription or an API key. A provider reports a cost for subscription turns too, and that is money nobody is charged.
- 358113a: Color every line of a unified diff, so a reader sees which way a change went
  without counting markers. Additions and removals carry the same treatment the
  split view already used. The per-file expansion and the worktree diff share
  one renderer.
- b05db6b: Name the context on the composer usage chip instead of the session's running token tally. The chip now reads the context the next turn runs in, which is the number that decides whether the work continues. A provider that reports no context window leaves the chip on the session tally rather than blank.
- 82a3a67: The usage chip has three states of one shape: tokens, a separator, then a price or a ring.
  With a reported cost it reads `42.1k · $0.38`. With no cost it reads `42.1k` alone and hides
  the separator; "cost unavailable" is gone from the chip, the session row and the today row.
  The popover gains a last row, "Provider window: not reported", saying the provider has not
  stated its limit so no dial is drawn. The ring for a subscription waits on the wire carrying
  the provider's window.
- 4cacf7a: Draw the provider window ring on the usage chip
  
  When a provider reports its rolling usage windows, the chip now carries a ring
  beside the token count instead of the count alone. Two windows run at once, so
  the ring shows the tighter of the two, and its label names which window it
  drew and when that window resets. The ring turns to the warning colour at 85
  percent. A provider that reports no window still draws no ring, because an
  inferred limit would be invented precision.
- 45f488e: Reconcile the colour tokens with the v2 design set and add the StatusDot, Chip and FloatingSurface primitives.
- 7d6f7f3: A device paired to watch only now sees every waiting approval in full, with no decision controls, on desktop, web, phone and tablet. The note under the gate says a device paired with full access answers it.
- 6736af1: A browser tab pairs with the code the machine shows in Settings under Phone and tablet, redeemed through device.redeemCode with no daemon credential. The connect page names the address it dials, says how the tab is trusted, draws the daemon's outcome (accepted, refused, protocol mismatch, device limit, no answer) and reads a code from the address bar once. The daemon credential stays reachable one link down. The sessions column in a browser says it reaches this machine only and that the credential ends with the tab.
- 0b81940: A running turn's activity row now reads "Working" and holds the calls it has
  already made, instead of counting them as though the turn had finished and
  drawing a second bare row beside them.
- 6832713: Discover WSL distributions from Windows and open work inside them through the
  daemon that runs there. `domovoid wsl list` asks `wsl.exe` for every
  distribution, its WSL version and state, and whether a Domovoi daemon has
  published an endpoint inside it, reporting the loopback endpoint WSL forwards
  and never the credential. `domovoid open` on a `\\wsl$` or `\\wsl.localhost`
  path asks that distribution's own `wslpath` where the path lives and sends
  `project.open` to the daemon inside it; a stopped distribution, a WSL 1
  distribution, a distribution with no daemon, and a Windows drive the
  distribution mounts are each refused with the remedy, without assuming where
  drives are mounted. A daemon refuses `project.open` on a WSL share path, so
  no repository work runs through `\\wsl$`. A daemon inside a distribution
  reports the distribution and WSL version in its fleet facts, and the Fleet
  surface names it as the distribution with a WSL mark.
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
