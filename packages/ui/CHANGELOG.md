# @getdomovoi/ui

## 0.1.0

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
  composer. The chip names the session's tokens and provider-reported cost and
  opens rows for the last turn, the session, the context share and today's
  count. It still says "cost unavailable" for any turn the provider did not
  price.
- ad121ce: After pairing, a browser tab states what it can and cannot do, measured against this browser, before a refusal is hit inside the session.
- 7e8bcca: The workspace shell wires what the launcher, skeletons and empty states already can do: start a session on the machine the launcher names, pick a transfer target there and decide in the preflight, reach first-run setup from the launcher, draw loading in the shape of what is coming, and say which emptiness each empty state is. Status dots go through StatusDot everywhere, and a lint rule quotes the design system on it.

### Patch Changes

- d927d11: Place the caret after an accepted composer command. Choosing a command whose text the message box already held changed nothing, so the caret stayed where it was and the argument was typed in front of the command.
- 35d34d2: Return focus to the message box after a composer command is chosen with the pointer, so typing the command's argument continues in the message instead of going nowhere.
- 54424c9: Report a removed queued turn through a new onRemoveQueued callback. Removing one previously cleared the composer banner while the turn stayed queued wherever the parent had put it.
- 4a32392: Update production dependencies: the Claude, Kilo and OpenCode provider SDKs in the daemon; Electron 44.2.0 in the desktop; React 19.2.8, Lucide 1.42.0 and react-resizable-panels 4.12.4 in the shared ui and the clients. Development tooling moves with them (vitest 5, shadcn 4.21). The phone follows its Expo SDK: expo 57.0.22, reanimated 4.5.1 and worklets 0.10.1 as the SDK resolves them, jest held at 29 because jest-expo 57 expects it, and a deps:check that refuses drift from the installed SDK.
- 3eaa05e: On macOS the titlebar content starts past the window buttons by an inset derived from where the desktop placed them, so the mark no longer lands on the green button. Windows and Linux get no inset.
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
- 431a7a1: The launcher's provider picker lists only the harnesses that reported. One that is not
  installed no longer appears as a greyed item that can never be chosen; the readiness list
  beside the picker still states "Not installed" as a fact. A harness that needs a sign-in stays
  listed with its reason.
- bb72c15: Offer first-run setup from the launcher footer, so a machine that no command can help with yet has somewhere to go. It hides while a transfer target is being chosen.
- 5ae04b0: When every harness is missing, Start a session shows a search report instead of a status list: what the daemon looked for, the PATH it searched, and that finding nothing there is not proof nothing is installed. The daemon reports the searched PATH on the machine (machine.toolPath), and a missing harness reads Not found rather than Not installed everywhere.
- 6d6a5ca: Permission mode and session lookup tables are typed over their unions, so a new member fails to compile instead of falling through.
- bedf4af: Hold the machine sheet's opener above the pin and unpin swaps, so closing the sheet after a pin cycle returns focus to the rail control that opened it instead of to the document body.
- d22da12: Place focus deliberately when the dock is pinned or unpinned. Pinning unmounts the floating sheet rather than updating it, so its focus-return cleanup sent the keyboard back to whatever opened the sheet.
- 54424c9: Stop pinning an open machine sheet from throwing keyboard focus back to whatever opened it, and return focus when a pinned sheet closes.
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
- 0989268: The desktop's "Pause all" sent `system.emergencyStop`: it blocked every provider, aborted the
  workspace and killed every terminal, while its label promised a pause. `system.pauseAll` existed
  on the wire and in the client and nothing called it.
  
  The app bar button is now "Stop everything" and opens a menu with two items that each say what
  they do. "Pause everything" calls `system.pauseAll` and stops at the next turn boundary; nothing is
  killed. "Emergency stop" calls `system.emergencyStop` and says that processes are killed now and
  half-written files stay half-written. The command palette lists both commands under the same
  names; the old "Pause all" command that sent the kill is gone. The error banner reads "Emergency
  stop failed" for the stop it reports.
- 584e7d9: Derive runtime build versions from release metadata. Fleet facts, daemon and client greetings,
  and provider initialization report the running release instead of a fixed development version.
  Production startup refreshes the persisted local version without changing machine identity.
  Wire protocol compatibility and existing pairings are unchanged.
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
- 59b11f1: StatusDot carries its label to a screen reader only, so a dot's meaning is read aloud without being drawn twice.
- 10635fc: Surfaces say what exists: the phone's empty states print the pair command the machine really runs and no installer or `domovoi new`; the pairing credential is described as it is scoped; the fleet's UPDATE badge, which had no update path, is gone.
- 2793da2: The terminal pane names its state in text rather than leaving colour to carry it alone.
- e84ffb2: The light and dark flip animates: 200ms on `--ease-out` across background-color, border-color,
  color, fill, stroke and box-shadow, collapsed to 0.01ms under `prefers-reduced-motion`. It is
  transient, not standing: a `dv-theming` class is armed in the same call that changes the theme
  and removed after 240ms, so hover backgrounds keep the design system's instant step. The first
  paint and a repeat of the same theme do not animate.
- 41385c3: The thread sticks to the bottom only when it is already there. New output while the person
  is at the bottom scrolls to the end; scrolled up, the viewport holds still and a pill above
  the composer offers the ride back, reading "3 new" for output or "Waiting on you" when a gate
  arrived below. A gate no longer moves the viewport: the approval card's `scrollIntoView` is
  gone, and the pinned plan strip already announces a gate without hijacking scroll. Before,
  the desktop never followed at all and the only scroll it did was the one that moved the
  viewport under a person reading an earlier turn.
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
- 63457d9: Give the small-type floor tokens and use them. Sans prose bottoms out at --text-micro, with exactly two named roles below it: --text-eyebrow for uppercase section labels, carrying its own letter-spacing, and --text-mono-xs for machine output in dense rows. Forty raw 9px values and six raw 8px values had no token behind them and are now expressed as one of the three roles. Truncation notices leave the metadata row and name their limit beside the output they cut.
- 4a53519: Report every prompt trim in the delivery note under a sent message. Open
  annotations dropped for the prompt budget or the per-turn limit, and handoff
  thread items, annotations, and artifacts trimmed to fit the prompt, each get one
  short line after the skill lines in the daemon's documented drop order. The
  note's tooltip states the measured prompt size against the recorded budget.
- 118eae8: The approval receipt, the plan strip, the policy refusal card and the danger and info chips draw their tinted frame and header again. The info and danger colour families were used by name but never registered with the sheet, so the utilities produced no CSS and the header text took the on-solid contrast colour, which vanishes against the page.
- 6d56837: The machine sheet's scrim draws again (bg-overlay was never registered). A test now compiles the real sheet, scans every source the sheet names with the build's own scanner, and fails on any colour-carrying utility that resolves to no CSS.
- e5ba27e: The usage chip and its popover show tokens alone, with no dollar figure, until the wire says whether a session runs on a subscription or an API key. A provider reports a cost for subscription turns too, and that is money nobody is charged.
- 82a3a67: The usage chip has three states of one shape: tokens, a separator, then a price or a ring.
  With a reported cost it reads `42.1k · $0.38`. With no cost it reads `42.1k` alone and hides
  the separator; "cost unavailable" is gone from the chip, the session row and the today row.
  The popover gains a last row, "Provider window: not reported", saying the provider has not
  stated its limit so no dial is drawn. The ring for a subscription waits on the wire carrying
  the provider's window.
- 45f488e: Reconcile the colour tokens with the v2 design set and add the StatusDot, Chip and FloatingSurface primitives.
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
- Updated dependencies [1204d6c]
- Updated dependencies [2adb117]
- Updated dependencies [d4228ee]
- Updated dependencies [0fed2e6]
- Updated dependencies [3d67826]
- Updated dependencies [91b1e15]
- Updated dependencies [18f6543]
- Updated dependencies [9e1e9c5]
- Updated dependencies [c32065a]
- Updated dependencies [4359bcf]
- Updated dependencies [9d94da3]
- Updated dependencies [1204d6c]
- Updated dependencies [5ae04b0]
- Updated dependencies [b67435e]
- Updated dependencies [b5b1aa9]
- Updated dependencies [a5f0f7e]
- Updated dependencies [fe7968f]
- Updated dependencies [59b1a7a]
- Updated dependencies [0c88e11]
- Updated dependencies [e736472]
- Updated dependencies [66ade99]
- Updated dependencies [cdf5f87]
- Updated dependencies [3c2ae09]
- Updated dependencies [1c67fba]
- Updated dependencies [964c47d]
- Updated dependencies [e094929]
- Updated dependencies [20e7e91]
- Updated dependencies [9048458]
- Updated dependencies [5a33539]
- Updated dependencies [fb78eda]
- Updated dependencies [9387a5d]
- Updated dependencies [c3e566a]
- Updated dependencies [2b21f85]
- Updated dependencies [ef58e04]
- Updated dependencies [cad2971]
- Updated dependencies [8523d3d]
- Updated dependencies [584e7d9]
- Updated dependencies [31b48d4]
- Updated dependencies [36520ce]
- Updated dependencies [f9f2352]
- Updated dependencies [ee3fe90]
- Updated dependencies [ea2b5ab]
- Updated dependencies [284ad5e]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [7cf6870]
- Updated dependencies [ef0d241]
- Updated dependencies [b2e5888]
- Updated dependencies [d0a58b7]
- Updated dependencies [6832713]
- Updated dependencies [6832713]
  - @getdomovoi/protocol@0.1.0
