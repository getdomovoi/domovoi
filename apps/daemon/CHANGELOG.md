# @getdomovoi/daemon

## 0.1.0-alpha.0

### Minor Changes

- 5ee1825: A person's allow now takes a checkpoint before the agent hears the decision. Allow once and
  always allow in this project take one; a denial and a standing rule or Auto allowing a command
  take none. The agent is still mid-turn, so the checkpoint is a snapshot: a commit built in a
  temporary index and kept under `refs/domovoi/checkpoints/`, with HEAD, the branch, the index and
  every file left as they were. The receipt names that checkpoint's commit. If the checkpoint cannot be taken, the
  command does not run, the gate stays open and the person is told to decide again. When a
  submodule has changed tracked files or untracked files, the checkpoint could not hold them, so the
  allow is refused the same way and the message says so. A session with
  no worktree records the checkpoint as unavailable.
  
  The receipt also says how long the allowed command ran, as `ranForMs`, once the agent reports the
  command's item complete. Gates now carry the provider's `itemId` so the daemon can match that
  completion. When the turn ends or the daemon restarts before the item completes, the receipt has
  no run time. Session history carries `ranForMs` on approval entries.
- 08e4f00: A session names the branch its worktree is on (`branch`, `domovoi/<session id>`) from creation
  and fork, and an archived session says how many files that branch changed that the source
  checkout never received (`unmergedFiles`, read at archive before the worktree is removed: files
  differing between the merge base with the source's HEAD and the branch, so a branch merged
  before archive says 0). Both feed the archived notice, "Branch <b> and its final checkpoint are
  kept" and "N files never merged". Sessions from an older daemon carry neither field.
- 1204d6c: Enroll fleet peers through a source-daemon-owned, authenticated exchange and refresh their reported facts with bounded heartbeats. Keep machine credentials in the OS keychain, publish pending cross-store operations honestly, and distinguish confirmed from unconfirmed remote revocation when forgetting a peer.
  
  The wire protocol moves to 0.4.0. Replace device.saveCredential and device.machineCredential with fleet.enroll and fleet.forget; fleet.list now returns the machine, pending, and unenrolled entry union. Older peers must update, but existing bound credentials and valid 0.3 workspace state are preserved without another forced pairing cycle. Enrollment does not grant a client credential for remote Use or Terminal.
  
  Keep legacy recovery rows visible beyond the 128-machine admission limit, bound wire snapshots to 512 entries, and report overflow without truncation. Local fleet-keychain recovery commands list IDs without credential bytes and remove a named local key only after the operator confirms Domovoi is stopped; remote revocation remains a separate action.
  
  Fix canonical transfer serialization of undefined optional fields, so real working-plan edits survive a machine transfer with the repository and history.
- 800de19: Add bounded update metadata discovery and signature verification.
- 1524651: Add explicit TLS tailnet advertisements and source-local configured SSH-forward routes. Services retain both settings. Machine authentication, route deadlines and forget masking still apply; removing SSH configuration removes that fallback after restart. Domovoi does not start SSH tunnels or add WSL or relay transports.
  
  Loopback advertisements now reflect whether the listener uses TLS. Peers cannot enable a source-local route through their own SSH or loopback advertisements, including TLS loopback URLs.
- 1bc7464: Add DOMOVOI_PROFILE_DIR for isolated daemon state without changing provider HOME. Save the selected profile in per-user service registration while retaining the shared service-operation lock.
- 4cacf7a: Show Codex OAuth 5-hour and weekly usage windows using provider-reported
  percentages and reset times. Providers that do not report quota windows keep
  the explicit unavailable state.
- 707e0ab: Persist current context occupancy reported by Claude, Codex, and ACP providers,
  and expose it only while its provider runtime and thread remain active.
- bb0bdf5: Classify a turn that outgrows the model context window as
  `context-window-exceeded` rather than a retryable rate limit or unknown failure,
  and keep a usage limit written with the words spelled out classified as a rate
  limit.
- 6b22745: Remove the `@getdomovoi/daemon/internal` entry point. It exported only two types that the main
  entry already exports, and no npm release carried it, so `@getdomovoi/daemon` is now the
  package's only entry point.
- 9dc6a6f: Replace the public raw daemon constructor with `createProductionDaemon`. The
  factory always installs a durable root credential and machine identity,
  provider discovery, the peer-credential store, persistent state, and configured
  transport protection, so shipped entry points cannot omit production
  dependencies that tests inject.
  
  This is a breaking embedding API change. Consumers must await the factory and
  use its returned handle.
- d72874e: Give the provider prompt composer one total budget and a documented drop order.
  `providerPromptBudgetCodeUnits` lowers the 262,144 UTF-16 code unit default and is
  validated with the other daemon options. Over budget, the composer drops project-default
  skills, open annotations, then handoff history, annotations, and artifacts one item at a
  time, stops as soon as the prompt fits, records every drop on the sent turn's
  `providerPromptDelivery`, and refuses the turn when the request, working plan, and handoff
  summary cannot fit.
- fce431f: Surface provider rate limits, expired authentication, exhausted quota, and missing
  model access as their own classified failures. The Claude adapter kept a bounded,
  redacted tail of provider stderr and preserves the reported error text, so these
  conditions no longer reach a client as unknown or retry.
- 0080f60: Bind relay admission to the active paired bearer and its authenticated static key.
  Keep enrolment on direct connections and carry admitted RPC through the existing
  dispatcher. The endpoint adapter does not implement relay registration, dialing
  or secret-key provisioning.
- 962980a: `@getdomovoi/daemon` exports the service installer for the desktop: `installDaemonService({
  runtime: { nodePath, daemonEntryPath }, environment? })`, `readDaemonServiceStatus()` and
  `removeDaemonService()`, with their result types. The caller names the Node executable and the
  daemon entry it ships; the service (launchd agent, systemd user unit or Windows logon task) runs
  those. A missing, relative or non-file runtime path is refused with
  `DaemonServiceRuntimeMissingError` before the profile is claimed or any file is written.
  
  `installDaemonService` also takes `releaseInAppDaemon`, called once the runtime, platform and
  configuration checks pass and the service-operation lease is held, and before the profile is
  claimed, so a refused install never stops the desktop's in-app daemon. A rejected release stops the
  install with nothing claimed or written. The profile is checked first: it must be free, or owned by a
  desktop owner, the in-app daemon the handoff stops; any other owner refuses with
  `ProfileAlreadyOwnedError` before the handoff. If another daemon takes the profile after the handoff,
  the install fails with `DaemonServiceHandoffError`, nothing claimed or written.
  
  `readDaemonServiceStatus`, `removeDaemonService`, `domovoid service status` and
  `domovoid service remove` treat a Windows task under Domovoi's name as Domovoi's only when
  `service.json` holds a Domovoi registration and the task runs that file through exactly the runtime
  and daemon entry `service.json` records (`serviceRuntime`, now written by every install that names a
  runtime). Any other task is reported as not installed and is neither stopped nor deleted
  (`WindowsTaskNotDomovoiError`). An install from before that record stays removable only when it runs
  `node.exe` on an `@getdomovoi\daemon\dist\index.js` or `apps\daemon\dist\index.js` entry.
  
  On macOS and Linux, status and removal from both entry points report or stop a job named for
  Domovoi only when Domovoi's plist or unit file is there, and on macOS only when `launchctl` says the
  job was loaded from that plist. With no such file, status reports nothing installed or running and
  removal asks no service manager to stop anything.
  
  The Windows logon task, from the desktop and from `domovoid service install` alike, always runs the
  daemon entry through the named Node runtime, and a runtime, entry or configuration path that
  contains a percent sign is refused (`WindowsTaskPercentSignError`), because Task Scheduler expands
  `%NAME%` when the task runs. A path that contains `$(` is refused (`WindowsTaskArgumentVariableError`),
  because Task Scheduler substitutes `$(Arg0)` and the like in task arguments. On Linux, a runtime, entry or
  configuration path that contains `$` or `%` is refused (`SystemdPathCharacterError`), because systemd
  expands variables and specifiers in `ExecStart`. A path that is not in the plain form
  Windows reports (`.` or `..` parts, doubled or forward slashes, a DEL character) is refused
  (`WindowsTaskPathError`), because Domovoi could not recognise that task later. Install refuses a
  same-named task Domovoi did not register (`WindowsTaskNotDomovoiError`) rather than replace it.
  
  When the service manager refuses the new definition (`schtasks /create`, `launchctl bootstrap` or
  `systemctl daemon-reload`), or a service file cannot be written, install puts the previous
  `service.json` and service file back, or removes them when there were none, so the record still
  names what the manager runs. On macOS, when the install had sent a bootout for Domovoi's idle
  job and a later step fails, or the bootout reports failure after unloading the job, the previous
  agent is loaded again. On macOS,
  install boots out an idle job loaded from Domovoi's plist before bootstrapping the new one, and
  refuses before the handoff when the label is loaded from another plist (`LaunchdJobNotDomovoiError`).
- a4200fb: Add `domovoid service install`, `status`, and `remove`. The systemd user unit,
  launchd agent, and Windows logon task generators now ship inside the package
  instead of living as repository scripts no shipped command could reach.
- 77c2829: Add `updateDaemonService({ runtime })`, which moves an installed per-user service to the Node and
  daemon the app now ships, in place. The runtime is checked first and nothing changes before that
  passes. launchd boots the agent out, holds the profile while it writes the new agent, then boots
  it in; systemd writes the new unit, reloads and restarts it; the Windows logon task is stopped,
  the profile held while it lets go, and the task registered again with the new command and run.
  A WSL guest service records its intent, retires its old task, saves the new guest runtime with
  the profile held, and registers and starts a task for it. A start counts only once the daemon
  reports ready. If any step fails, a timeout included, the previous service is put back under its
  own time budget and must report ready too; the error says which way that went, or that nothing
  was changed. The saved configuration is read under the service-operation lease, a restore waits
  for any write still pending, an unreadable owner record fails the update, and the WSL update
  record is read only as a private regular file that matches the saved registration. An install now
  records the Node executable and daemon entry it installed in service.json (`serviceRuntime`), and
  an update records the new ones once they are written, or for a WSL guest once the new service
  reports ready. The previous plist, unit, task action or WSL guest runtime is put back only in the
  shape a Domovoi install writes (absolute runtime and daemon entry, then the saved configuration
  path) and only when its runtime and entry are exactly the ones service.json records. Anything
  else, and any install whose service.json has no such record, is refused before anything changes,
  with the outcome `changed-outside`: "The installed service file was changed outside Domovoi, so
  Domovoi will not update it. Remove the service and install it again to replace it." A service
  that is not installed keeps the outcome `not-installed` and its own words.
  
  On macOS the update and its restore boot out a job under Domovoi's label only when `launchctl`
  says it was loaded from Domovoi's plist; a job from another plist refuses the update with nothing
  changed (`LaunchdJobNotDomovoiError`). On Windows an update refuses, with nothing changed, when the
  previous task action it would register again contains `%`, `$(` or a path Windows would not report
  in that form. A WSL update refuses, with nothing changed, when the old or the new task would carry `%` or `$(`
  in its `wsl.exe` path or arguments, and a Linux update refuses when the recorded old runtime or entry
  contains `$` or `%`. `domovoid service install` for a WSL guest refuses, with the same lines, a
  distribution, Linux user, guest runtime, entry, `wsl.exe` path or configuration path that contains
  `%` or `$(`, before any file is written or task command runs.
- d4228ee: Bind project standing approvals to versioned, server-resolved execution digests.
  Legacy text-only rules remain visible but inactive until explicitly reapproved,
  and package-script changes invalidate pending or reusable approvals.
- cbf620b: Persist structured working plans from Codex, Claude, and ACP providers, apply
  attributed human edits at turn boundaries, and track approval blockers without
  discarding queued or conflicted drafts across session lifecycle changes.
- ef91479: The daemon persists its trusted update metadata versions under the profile lease, read through a strict schema and published durably, and stages a verified update target through the bootstrap installer, which now ships inside the daemon package as `dist/bootstrap-install.js` so an installed runtime can stage without the repository.
- fb78eda: Stamp each usage row with the time its turn was first recorded and answer
  `usage.window` with one query over the ledger. Rows recorded before the stamp
  existed and rows imported by a session transfer carry no time, so they never
  count toward a window; rows a transferred or archived session left behind keep
  counting. Costs in more than one currency within a window are not combined.
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
- 9d94da3: Add retained rule revocation, persisted use counts and renderable hard-gate categories for the Rules tab.
  
  The wire protocol moves to 0.7.0. Update clients and daemons together: a peer on another minor version is refused at `system.hello` with `-32012`.
- c3229d9: `device.issueCode` answers with the address a device dials to spend the code, as
  `pairingAddress`: `{ url, label?, loopback }`, the name on the certificate the daemon serves and
  never the address it binds, or `{ problem }` when there is nothing a device could verify (no
  certificate on a non-loopback listener, an unreadable certificate, a certificate naming no host or
  several). The desktop pairing card, the web connect page and `domovoid pair` draw the same address
  from this one answer; the command line no longer works it out on its own.
- b67435e: Recover saved client relay pins through externally signed daemon channel-key rotation and durable successor adoption.
- e199de4: Prevent CLI, service and Desktop daemons from writing the same profile concurrently. A separate
  profile lease precedes store construction. Local clients can acquire an owned handle or attach
  only after a same-socket instance proof and ordinary authenticated hello. Attachments cannot stop
  the owner, and restarting or unconfirmed owners never trigger a Desktop fallback.
  An attached handle notifies the client when its verification socket closes, without polling or
  automatic reacquisition.
  
  Service installation refuses while the profile is owned. Close Desktop, install or start the
  service, then reopen Desktop to attach. Port zero requests a kernel-assigned port and discovery
  reads the current bound endpoint from the owner record. Stop older processes before upgrading;
  they do not participate in the new lease protocol. Windows retains the existing user-profile ACL
  policy. The daemon's declared Node requirement now matches the repository's Node 22.13.0 minimum.
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
- d5bdbe6: Each model says whether it takes image input. `runtime.models` entries carry `imageInput`,
  `true` when an image attachment on a send to that model is delivered and `false` when it is not;
  the daemon fills it from the same rule the send uses, the adapter's vision capability. A send with
  images to a model that takes none is still refused whole. The error message now names the model
  and the image count, and the error data keeps the shape released clients parse. The attach sheet's
  code is the exported constant `modelImageInputRefusalCode`.
- 0c88e11: Send up to two bounded PNG or JPEG images with a session prompt. Refuse image sends when the adapter lacks vision support; keep uploads out of daemon persistence. Raise bounded authenticated RPC messages to carry both images over direct and encrypted transports. Advertise optional sessionImageAttachments support in system.hello so clients can refuse image sends to older daemons.
- 66ade99: Add opt-in per-file evidence with explicit unknown test links, observed Git revert targets, and commit-bound revert confirmations.
- 3c2ae09: Pair a phone with a single-use code the machine draws itself
- 1c67fba: Keep machine-pairing claims pending for five minutes instead of activating a remote credential
  before the source can store it. The source journals the claim and verifies durable keychain
  readback before confirming activation. Pending credentials cannot authenticate, and an abandoned
  re-pair does not revoke the previous active credential. Lost confirmation replies recover
  idempotently after restart; unconfirmed claims expire without ever granting normal authority.
  
  The wire moves to protocol 0.5.0. Update peers together before enrollment. Existing active bound
  credentials remain valid and do not need re-pairing. If an unfinished claim expires, issue a new
  code on the target and enroll again. Transport or storage ambiguity remains pending for retry.
- 964c47d: Narrow a phone or tablet credential to the pairing card's promise
- 5a33539: Carry a `protocol-mismatch` payload on every `protocolVersionMismatchErrorCode`
  (`-32012`) refusal: the refusing daemon's protocol version, the client's, and the
  `protocolCompatibility` result between them, validated by `protocolMismatchSchema`.
  `system.hello` and `device.claim` send it with their sentence unchanged. The fleet
  dialer reads the peer's version from the payload and falls back to the sentence
  only for a daemon that predates it, and the phone names both versions from the
  payload with the same fallback.
- ef58e04: Deliver signed relay successors before admission and return complete identity pins during opt-in pairing.
- fdc96ec: `session.send` accepts text files and worktree file paths as attachments beside images, at most two in total. Text files are written into the session worktree for the agent to read; worktree paths must stay inside the worktree. New refusal reasons: `invalid-text` and `invalid-workspace-file`.
- 0b59f4f: `session.search { query, limit? }` searches a daemon's sessions by title and by summary, the
  newest assistant message the daemon holds for the session, case-insensitively, and answers
  `{ query, matches: [{ session, matchedIn: "title" | "summary" }], truncated }` without a whole
  snapshot. It is read-only and unaudited, like `session.history`. A desktop or web client fans it
  out per admitted machine for the palette's "Sessions on other machines"; each machine answers
  for itself, so a machine that did not answer stays "not searched" rather than "no match".
- 234d8fe: Select the Windows-owned guest supervisor when installing from WSL 2. Persist
  the guest launch inputs, report task and guest status, and prove guest shutdown
  before removing the registration. Existing systemd registrations remain manageable.
- 31b48d4: Add a skill from a folder on the execution machine after a review. `skill.installPreview` returns
  the parsed manifest, the declared capabilities, the content and source digests, the signature and
  trust state, the file list, and the install targets per scope. `skill.install` copies the folder
  into the `user` or `project` Domovoi skill root only when its digest still matches the preview,
  refuses a blocked skill, a link that leaves the folder, and an existing name with different files,
  stages the copy inside the root and renames it into place, and audits the result. The Skills
  surface gains an Add skill review step with the scope choice, and `domovoid skill add` prints the
  same review and installs with `--yes`.
- 36520ce: Verify skill signatures against a local trust file. A `SKILL.md.sig` whose Ed25519 signature
  over the content digest verifies against a key in `~/.domovoi/skill-trusted-keys.json` now yields
  a trusted state; a key the file does not list stays unverified, and a failing signature or content
  changed since signing is blocked. `domovoid skill keygen`, `sign`, and `trust` create a signing
  key, sign a skill, and add a public key to the trust file. The delivery record on a sent turn
  carries the trust state each delivered skill had, and the skill browser names an untrusted key.
- f9f2352: Add machine-local runtime discovery for remote session forms, with provider model
  and reasoning choices, a complete default with Auto off, supported permission modes,
  and explicit authentication, timeout, empty-catalog and discovery refusals.
  
  Check provider readiness before offering or creating a runtime. Bound discovery
  end to end, cancel expired catalog work, and prevent late results from poisoning
  retries. Keep the existing model-list and session-create contracts and wire version.
- 284ad5e: Record machine transfer coverage and approval decision latency in durable session history. Protocol 0.6.0 requires clients and daemons to update together; legacy receipts keep missing measurements absent.
- 9266302: A phone or tablet can read a terminal. Three read-only methods join the phone and tablet
  allow-list: `terminal.list` names a session's terminals, `terminal.watch` returns what the
  daemon kept of one (redacted before it was kept, at most 65,536 characters, with when that
  record starts and whether earlier output was dropped) and then sends its live output, and
  `terminal.unwatch` stops that. None of them reach the shell: `terminal.create`, `terminal.claim`,
  `terminal.input`, `terminal.resize` and `terminal.close` stay refused to those credentials, so
  the one claimant still types.
  
  Terminal notifications now go to the connections that opened, claimed or watch a terminal,
  not to every client. A closed terminal stays readable for one hour with its exit code, then is
  dropped; the daemon holds it in memory only. The owner on the wire also names the paired
  device the daemon verified on the claiming connection, id and label at claim time, when there
  is one. The pairing card's unbuilt line is the short form, "Terminal output is not on a phone
  yet."
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
- b5b1aa9: Move portable session history and resources with checkpointed machine transfers,
  while keeping machine-local credentials, provider state, and reusable authority
  on the machine where they were granted.
- ef0d241: Allow a turn to select an exact reviewed skill set. Explicit selections pin
  reviewed content and capabilities, remain required under prompt pressure, and
  fail with structured skill-specific reasons when they can no longer be used.
- 33c937f: Add watching-only client authorization, durable policy refusals, and daemon-owned next-turn message queues.
  
  The wire protocol moves to 0.8.0. Update clients and daemons together: a peer on another minor version is refused at `system.hello` with `-32012`.
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

### Patch Changes

- f7c19b5: Never abandon a resource a deadline created. A deadline rejects the moment its signal aborts,
  without waiting for the operation it abandoned, so an expiry in the middle of a creation left the
  only record of that resource inside the discarded operation.
  
  Bootstrap installation now holds its staging creation and its receipt publication and settles both
  in the cleanup phase. An expiry during the staging `mkdtemp` no longer skips removal and leaves a
  `.runtime-` tree in the release directory, and a receipt whose hard link landed after the refusal
  now keeps the runtime tree it names instead of having it deleted. Staging removal retries a
  removal refused with EBUSY, EMFILE, ENFILE, ENOTEMPTY or EPERM inside the existing cleanup budget,
  which is what an aborted npm child that still holds a handle produces on Windows.
  
  Bootstrap archive publication holds its staging creation the same way. An expiry during that
  creation used to report nothing about the directory it left behind; the refusal now names the
  retained staging. Cleanup still shares the caller's budget, so an expired run reports the retained
  path rather than removing it.
  
  Session create and fork now remove a worktree the creation deadline abandoned. An expiry while
  `git worktree add` was running left the worktree and its `domovoi/` branch with no reference, so
  the existing cleanup was skipped entirely. The late result is now removed under the same agent
  timeout, and a failure to remove it is reported.
- d9add3d: Windows fleet dialing can reach an enrolled WSL 2 daemon through a freshly authenticated local route. Pair the guest first and run domovoid inside the distribution on a distinct loopback port. No new pairing or wire migration is required.
  
  The source checks the distribution before each attempt, uses the existing paired-machine credential, and produces a WSL candidate only after the expected daemon authenticates. A stopped distribution, stale endpoint or rejected credential does not produce a route. Discovery, connect and hello share the route's slice of the overall dial deadline. Root credentials from endpoint files are never used for fleet admission.
- d7dacad: Approval cards no longer claim every request is contained. The daemon wrote "Files and processes in
  the session worktree" and "No agent network access granted" into every approval, although only
  Codex runs commands in a sandbox, and an approved Codex request usually asks to run outside it. The
  card's Affects and Network facts now come from the provider and the request: an unsandboxed
  provider (Claude Code, OpenCode, Kilo, ACP agents) says an approved command can reach anything the
  user account can and has the machine's network access; Codex says what its sandbox allows and what
  running outside it means; a request about a file names the file and says whether it is outside the
  session worktree.
  
  Codex's line follows the session's mode: in Ask and Plan the sandbox reads anything the user
  account can except credential stores and secret files, and writes nothing; in Build it writes only
  in the session worktree. A file path on the
  card is redacted like the command, and a secret in it makes the gate a hard gate. Its control
  characters show as escapes, and a long path is shortened in the middle. Inside or outside the
  worktree is decided on the real path, so a link out of the worktree names where it leads. A file
  tool's card names the file the edit really reaches, so a link that stays inside the worktree names
  its target.
  
  Each path a card holds (its file, the directory the request runs in, and a path the provider
  blocked on) is also judged on every spelling the daemon derives for it: as given, resolved, after
  each link, and relative to the worktree and the request's directory. A secret name in any spelling
  hides the path in every one of them and makes the card a hard gate; a path with more spellings than
  the daemon checks hides the card's command and operation whole. A directory that the durable secret
  redaction changes is hidden whole. A name with `.env.` inside it, such as `x.env.example`, is a
  secret file name too.
  
  One path classifier decides whether a path names a credential store or a secret file. It compares
  path components after Unicode NFKC normalization with full case folding and without
  default-ignorable code points, so a ligature such as "ﬁ", a fullwidth letter, or "ß" for "ss" reads
  as the name it stands for. It takes either slash as a
  separator, drops repeated separators and "." components, and judges a path both as written and with
  ".." applied. A store matches when its components appear in the path; the credential stores the
  Codex sandbox refuses (such as `.git-credentials`, `.pgpass` and `~/.aws`) come from one list shared
  by the sandbox, the card, and the command hard gate. A secret file matches on a component name: any
  stem, including none, before `.pem`, `.key`, `.p12` or `.pfx`; `id_rsa`, `id_dsa`, `id_ecdsa` or
  `id_ed25519` with any suffix; the `.env` family, a name that starts with `.env` or ends with `.env`
  or `.envrc`, so `process.env.HOME` in a command or a file name is not one; and a few named files. When the card path, any
  link followed on the way, any link target, or the file it ends at matches, the path is shown as
  "[REDACTED]" with its location kept, and the gate is a hard gate. A command is split into shell words, each also
  split on "=" and ":", and every word goes through the same classifier; a match makes the gate a hard
  gate, as does the earlier command-line check. Shell words are read as a POSIX shell reads them, with
  a backslash before a newline joining the lines and ANSI-C quotes such as `$'\x2eenv'` decoded the
  way bash decodes them: escapes are bytes read as UTF-8, an octal escape past `\377` keeps its low
  byte, and the quoted text ends at its first NUL byte. Words are also read with backslash as an
  ordinary character, the way PowerShell and cmd read it. Other shell obfuscation (variables, command
  substitution, `eval`, encodings, brace and glob expansion, and where another shell decodes an
  ANSI-C quote differently from bash) is a known limit of matching command text.
  
  `~/.docker` and `~/.domovoi` also hold ordinary files, so the card marks them by their secret files,
  `config.json` and `daemon.token`. The store root itself, with or without a trailing slash, or with a
  pattern such as `~/.docker/*`, names the whole store and is hidden and hard-gated too, so archiving
  or copying it is a hard gate; a project's own `.docker/Dockerfile` and files in session worktrees
  under `~/.domovoi` stay visible.
  
  Each path is also judged at its real path when any of it exists: the card path, every operand of the
  command and of a resolved script, and the directory the request runs in are resolved through the
  filesystem, so a link with an ordinary name, or a name the filesystem treats as another, that reaches
  a credential store makes the gate a hard gate. A path that does not exist yet is followed one
  component at a time from its root, so a link is followed before a ".." after it, as the filesystem
  does, and the directory the request runs in is read the same way, so `deep-link/..` is the directory
  the link leads to. Operands are read from that real directory, and a script's operands from its
  package's directory.
  
  Every approval card is made in one place. A new card, a card judged again before an Allow, a card
  read back from disk, and a request a standing rule would answer are all settled the same way: the
  execution is resolved, the operands come from the command and from that execution, and the
  directory as written and at its real path, the file, every operand, and the directory and manifest
  in the execution record are judged. Any credential path among them makes the card a hard gate and
  is hidden, and a manifest reached through a link into a store hides the execution record in every
  copy the daemon saves or sends. One 2 second deadline covers the whole request, the execution
  lookup included; a lookup that runs out of time, or that the filesystem refuses, gives a hard gate
  with the directory, the file and the execution record hidden, and the session is never held. Only
  a settled card enters the workspace state, and every save and broadcast seals any approval that did
  not, as a hard gate with its paths hidden. A standing rule answers only a settled request that is
  not a hard gate.
  
  Before an Allow is accepted, the card is settled again from the request as it is now: a link can
  move to a credential path, and a package script can change, after the card was made. If the card
  changes, it is saved and sent, and the Allow is refused with "The file target changed; review the
  updated approval before allowing it", or, when only the resolved command changed, "The resolved
  command changed; review the updated approval before allowing it".
  
  An approval saved before this change is classified as written when the state loads and whenever it
  is saved, so its stored copy is repaired: the directory, the directory in the execution record, the
  manifest a script came from, and a file line written before its path was classified are hidden, and
  the approval becomes a hard gate. When the daemon starts or opens a project, its saved approvals are
  then settled at their real paths before any client sees them. A standing rule whose execution record
  holds such a path is dropped.
  
  A saved card keeps its file only as its file line, so at load and at Allow each path that line names
  is followed on disk under the same 2 second deadline: a file that became a link into a credential
  store is hidden and the card becomes a hard gate, and a line that no longer reads back as a path
  (shortened, with an escaped character, or in another format) seals the card. A saved file line is
  read back only when it reads exactly one way as one of the card's three file sentences, no path in
  it holds that sentence wording (" in the session worktree", ", outside the session worktree" or
  ", through a link at "), and the reading renders back to the same line; any other line seals the
  card, so a file name that holds the wording cannot be read as other paths. A sealed card keeps a
  provider's own reach line and hides any other Affects line, whatever its format.
  
  A saved card's execution record is not trusted at load or at Allow. The execution is resolved again
  from the card's saved directory, command, and, for a file or read tool, the file its file line
  names, through the same resolution a new card uses and under the same 2 second deadline. If the
  fresh result differs from the saved record in digest, state, or reason, or any path or operand on
  the card reaches a credential store, the card becomes a hard gate and its record is hidden. A saved
  card whose directory or file line is hidden cannot be resolved again, so it is sealed. So is a
  saved card for a file or read tool, such as Edit or Read, whose resolution reads a file path, when
  its Affects line is not a file
  line that reads back as a path, such as a provider's reach line or an older daemon's wording, since
  nothing on it says which file to judge.
  
  When a card hides a path (a credential file or store, a hidden directory, or any path on a sealed
  card), that path is replaced with "[REDACTED]" in the card's operation and command lines, and the
  rest of the agent's text stays, so `cat ~/.aws/credentials` shows as `cat [REDACTED]`. The path is
  matched as written, at its real path, and in the forms the path classifier compares. A hidden file
  is also matched relative to the worktree and relative to the directory the request runs in, each
  as given and as it really lies, so `src/.env` or `.env` for a hidden `src/.env` requested from
  `src` is replaced; each relative form with "/" or "\" and with or without a leading "./". A name
  that only starts with the path, such as `x.envy.txt` beside a hidden `x.env`, is kept. The text is
  not split into words first, so a hidden name that holds a comma, a space, a quote or a colon, such
  as `src/.env,prod`, is replaced whole. A secret file that only the agent's text names, such as
  `src/private.pem` in the operation of a card for `src/index.ts`, is judged by the same classifier,
  replaced the same way, and makes the card a hard gate. Such a name is read whole beside a curly
  quote, a guillemet, a fullwidth bracket, an em dash, an ellipsis or a line suffix such as `:12` or
  `#L3`. The matching has a work limit: a card whose text would take more, or that names a hidden path
  longer than any real path, shows its operation and command as `[REDACTED]`. The classifier reads `.env.example` and
  `.envrc` as secret files too, so those names are replaced as well. A hidden
  directory at the start of a longer path is replaced, and a shell word that decodes into the path
  through quotes or escapes is replaced whole. An execution record whose command words hold the path
  is hidden. This holds for new, settled, sealed and saved cards, in workspace.get, workspace.changed,
  the store and approval receipts. A relative word under a directory that is itself a credential path
  is replaced only when it exists there, so a program name such as `ls` stays.
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
- 07e8696: `approval.resolve` saves the decision before it answers the agent. When the save fails, the daemon answers `daemonPersistenceUnavailableErrorCode` (`-32014`), the agent is not told, no standing rule is created, and the approval stays pending. Before, the agent was allowed to proceed and the caller was told "Internal daemon error", and an "Always in this project" rule the person was told had failed reached disk on the next save. If the save succeeds but the agent cannot be told, the decision is undone with a second save and the approval stays waiting. An emergency stop that lands during the save keeps its denial, and the stale decision is neither applied nor sent. Cached session history shows the new receipt.
- d76b0e0: The session artifact watcher no longer rescans the worktree for events inside directories its scan never enters (`node_modules`, `.git`, build output, coverage and the rest of its ignore list), so a build or test run there no longer costs a full walk. On platforms other than macOS and Windows, where Node emulates a recursive `fs.watch` by walking the whole tree synchronously and holding one inotify watch per file, the watcher now polls its bounded asynchronous scan every 2 seconds instead, so a worktree with installed dependencies no longer stalls the daemon or exhausts the user's inotify watches. There, a session is scanned every 2 seconds while a turn starts or runs and after any scan that finds a new or changed artifact. After 3 scans in a row find nothing new and no turn is running, it is scanned every 10 seconds (ruled 2026-09-23), so an idle session's artifact can take up to about 10 seconds to appear. A turn starting puts it back on 2 seconds at once. Each scan reads at most 20,000 directory entries to depth 12 and skips the ignored directories. A failing scan backs off the same way. On every platform, at most one scan runs per session and at most one waits behind it, so a scan slower than the poll does not build a queue, and a scan failure that repeats on every poll (a worktree past the 20,000-entry scan limit, or a deleted root) is reported once until a scan succeeds again.
- 19a5fe5: Give each provider message its own thread item.
  
  The daemon keyed the streaming assistant item on the turn, so every message a
  provider sent during one turn appended into a single item. Two messages ran
  together with no separator, and because the item kept the position it was
  created at, tool calls that ran between messages were placed after all of the
  text instead of where they happened.
  
  The Codex adapter now forwards the provider item id on an agent message delta,
  the same way it already forwards it on command output, and the daemon keys the
  assistant item on that id. Adapters that report no item id keep the previous
  turn-scoped behaviour.
- 76172f8: The audit log prunes only when its per-class row count says the cap is reached, instead of walking the index to the cap on every append. Retention is unchanged: the prune itself still deletes by position, so a count left high by a caller's rolled-back transaction deletes nothing and is recounted.
- dcb26a7: An audit append at the retention cap no longer walks the cap's worth of index rows to find what to prune. The retained count per class is kept exact (a caller's rollback is detected by checking that the last appended row, matched by sequence, entry id and class, still exists, and the count is then recounted; the sequence alone is not enough, because SQLite reuses a rolled-back sequence), so the prune removes only the oldest rows past the bound, found from the front of the index. Retention is unchanged: each class still holds exactly its bound.
- f9cf76b: Record a session-start checkpoint at worktree creation and expose semantic reasons for every new checkpoint in paged history.
- 7888b2c: An interrupted turn's late end no longer completes the turn sent after it. The Claude Code and
  OpenCode adapters (Kilo shares the OpenCode one) kept one active turn per thread and ended whichever
  turn held it when a completion arrived. Stop returns once the provider acknowledges the interrupt,
  and the interrupted turn's own result or idle comes after that, so a message sent in the gap was
  recorded as finished at once while the provider kept working on it, and its reply was dropped.
  
  Claude Code: a result that names only the user messages of an interrupted turn
  (`user_message_uuid`, `user_message_uuids`) is that turn's and ends nothing. Any other result ends
  the active turn as before, including one naming a message the SDK made itself or naming none.
  OpenCode and Kilo: after an interrupt, a `session.error` and the `session.idle` that ends the
  interrupted run, when they come before the next turn's own messages, are that run's and end
  nothing, since the server finishes an aborted run before it takes the next prompt. When the error
  arrives while the interrupted turn still holds the slot, it ends that turn, and the idle that
  follows still ends nothing. Without an interrupt, the first idle or error ends the turn as before.
- 5b2daa7: Name the installation step that ran out the bootstrap budget. An expired install reported only the
  total, the phrase "including installation and verification", and the destination to inspect. That
  does not say whether the download, the dependency install, the native terminal build or a
  verification pass held the clock, which is the difference between retrying and diagnosing. The
  refusal now appends the step that was still running and how long it had been running, and keeps the
  unannotated total as its cause.
  
  Nothing about cancellation changed. The same operation rejects at the same moment, an expired run
  still publishes nothing, and staging cleanup still spends its own separate budget.
- 0ec38aa: Find npm when Node is installed through Homebrew. The bootstrap probed only two paths beside the Node executable, so a Cellar layout that links its npm launcher was told to install a supported Node distribution while a working npm 11 was present. It now follows that link to a real npm-cli.js, and refuses dangling links, shell wrappers and directories. It also resolves the extracted package directory before handing npm a prefix, because a symlinked staging path made npm treat the package as a separate linked root.
- b2f72a9: Bound bootstrap HTTPS inactivity to 30 seconds of network waiting between non-empty body chunks,
  inside the existing five-minute installation deadline. Headers, redirects, and empty chunks do
  not renew the allowance; local disk backpressure remains bounded by the original total. Embedded
  callers can set a positive integer `inactivityTimeoutMs`.
  
  Abort fetch and reject late results with `BOOTSTRAP_DOWNLOAD_INACTIVE`, an origin-only diagnostic,
  and a connection-check remedy. Cancellation does not promise immediate runtime socket disposal:
  a stalled TLS connection can delay process exit until Node's own connect timeout. No expired
  download may proceed to publication or installation.
- 0160350: Prevent concurrent verified bootstrap downloads from replacing each other's archive bytes. Each
  download uses private staging and atomic no-replace publication. Matching existing archives are
  verified and reused; conflicting archives are retained and refused. Publication and cleanup share
  one bounded deadline, and cleanup failures name both the archive outcome and retained staging.
  This protects archive publication; verified runtime installation is a separate phase and service
  supervision remains separate.
- 75f2f28: Stream bootstrap archives into private staging while hashing and bounding each download, instead
  of retaining multiple archive-sized buffers. Bound SHA256SUMS separately to 256 KiB. Keep both
  checksum checks, fsync, and atomic no-replace publication before reporting success.
  
  Downloads, staging, and publication share a five-minute total deadline; publication also has a
  30-second phase limit within the remainder. Expired operations cannot begin later steps. Timeout
  errors name the archive to inspect, and private staging can remain if its cleanup budget expired.
  The streamed archive phase does not itself install dependencies or manage a service.
- e9d4e37: Retain production daemon diagnostics in five local JSONL files of at most 1 MiB
  each. Redact and bound records before writing, preserve limits across restart,
  and report file failures through stderr while keeping existing error delivery.
- 002c74a: Keep WSL helper paths and Git arguments literal by bypassing the default Linux shell with --exec. This fixes UNC path translation and prevents shell expansion of arguments. Update the Windows daemon; no re-pairing or protocol change is required.
- 1dd9ee7: Build auto no longer runs a package script without a card when the script's runner loads worktree
  code. `pnpm test`, `pnpm build` and `pnpm lint` whose bodies run vitest, jest, mocha, ava, eslint,
  prettier, stylelint, oxlint, knip, madge, vite, tsup, rollup, esbuild, swc, webpack, next, astro,
  changeset, attw or publint now ask on every run, because those runners execute test files,
  JavaScript config, plugins or lifecycle scripts the agent can write. Scripts that run only `tsc`,
  `tsd` or `biome` are still allowed. A hard gate anywhere in a script graph is now found even when an
  earlier step already needs review.
- 4884900: Daemon Git commands never run repository hooks. A relative `core.hooksPath` resolves inside the
  session worktree, where the agent can write, so a checkpoint on archive, provider switch,
  transfer, restore or file revert used to run a hook file the session had edited, with the
  daemon's full user rights and outside any gate or sandbox. Every Git command the workspace
  service runs now points `core.hooksPath` at a path that cannot be a directory and turns
  `core.fsmonitor` off.
  
  Checkpoint commits also skip commit signing. A signing setup with no key for the Domovoi
  committer, or a failing `pre-commit` hook, no longer makes every checkpoint in that repository
  fail. When a checkpoint fails after staging, for any reason, the index is put back byte for byte
  as it was, so the worktree is not left staged and anything the person had staged stays staged.
  
  Git filter drivers set in the repository's own config (local or worktree scope) now refuse
  checkpoint, restore, file revert, archive and transfer with an error that names the filter and the
  config that sets it. Git runs a filter's command on every add, checkout and reset, and a
  repository-set command such as `./scripts/clean.sh` runs a file the agent can edit. Turning the
  filter off instead would change what a checkpoint stores, for example git-crypt plaintext. Filters
  from your global or system Git config, such as Git LFS, still run.
  
  The file-change view reads its evidence with those repository-set filters treated as absent, so
  their commands never run there. A filtered file can show as changed in that view; nothing is
  stored.
  
  Daemon Git commands no longer inherit Git settings from the daemon's own environment
  (`GIT_CONFIG`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_COUNT`
  and its keys and values, `GIT_CONFIG_PARAMETERS`, `GIT_DIR`, `GIT_WORK_TREE`,
  `GIT_INDEX_FILE`, `GIT_EXEC_PATH`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `GIT_EXTERNAL_DIFF`,
  `GIT_PAGER`, `GIT_EDITOR`). Session push and fetch replace an ssh command, askpass, credential
  helper, upload-pack or receive-pack that the repository's own config sets with your global or
  system value, or Git's default, turn the `ext` transport off and skip push signing. A URL rewrite
  or proxy command the repository's own config sets refuses the push or fetch with an error that
  names it. A restore into a session worktree this machine already holds checks that worktree's own
  config for filters too.
- 5ffc29f: A checkpoint now includes a file whose name is only whitespace. The daemon read the staged file list
  through a helper that trims git's output, which stripped such a name from the NUL-delimited list, so
  a checkpoint whose only change was that file found nothing to commit and saved nothing.
- 3d92b6f: Stop reporting every cached Claude turn as failed.
  
  Anthropic reports cache reads and cache writes beside `input_tokens` rather than
  inside it, so a normal cached turn reports something like 4 input tokens next to
  21,393 read from cache. The normalized counters treat cached input as part of
  input, so `normalizeUsage` refused the turn with "Cached input tokens cannot
  exceed input tokens" after the reply had already been delivered. The session went
  to `failed`, the thread showed "Provider request failed", and the desktop raised
  "Agent work failed" on every response.
  
  `normalizeProviderUsage` now folds `cache_read_input_tokens` and
  `cache_creation_input_tokens` into the input count, which is what the provider
  billed. Only Anthropic reports those two names, so no other payload shape moves.
  
  Second, a usage counter that does not add up no longer fails a delivered turn.
  The Claude adapter drops the unusable readout and reports the turn as what it
  was, because usage is a readout and not the work.
- d02514f: A read-only Git command from Claude Code now skips Domovoi's approval only when Git is not configured
  to run a program for it. Domovoi reads the worktree's effective Git configuration first (every
  scope, includes resolved) and asks instead when it finds an fsmonitor helper, an external diff,
  a diff textconv or command, a filter, signature verification or a GPG program, when a
  post-index-change hook exists (git status can rewrite the index), or when `GIT_EXTERNAL_DIFF` is
  set. A configuration that cannot be read also asks.
- 4f57611: Pager settings (`core.pager`, `pager.*`, `GIT_PAGER`, `PAGER`) no longer make a read-only Git command
  from Claude Code ask. Git starts a pager only when its output is a terminal, and Claude Code runs
  Bash commands without one. A command that fakes a terminal, such as `script` or `unbuffer`, is not a
  listed read and still asks.
- 8ab80dc: A Git read from Claude Code no longer asks just because Git LFS is set up: the four filter lines
  `git lfs install` writes are allowed when they are exactly `git-lfs clean -- %f`,
  `git-lfs smudge -- %f`, `git-lfs filter-process` and `true`. Any other filter or value still asks.
  In a repository with a submodule every such Git read now asks, because git status runs each
  submodule under its own configuration.
- 48dc434: The Git settings check behind Claude Code's read-only Git commands now also asks when
  `GIT_EXEC_PATH` is set, when `format.pretty` or a `pretty.*` format uses a signature placeholder
  (`%G?`, `%GG`, `%GS`, `%GK`, `%GF`, `%GP`, `%GT` or `%GR`, which make git log run the signature
  program), and it now finds a post-index-change hook under a hooks path that starts with a space.
- 51de722: A read-only Git command from Claude Code now asks in a partial clone (a promisor remote, a
  partial-clone filter or `extensions.partialClone`), because commands such as `git log --stat` fetch
  missing objects on demand and run the remote's programs to do it. A pretty format with an escaped
  `%%G` no longer counts as a signature placeholder.
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
- 5a14da7: Keep the Claude conversation across a mode change; a reopen happens only for an ended session, resumes only a started one, and a failed reopen leaves the thread usable.
- 0cc804a: Claude Code sessions now send reads outside the session worktree to an approval. Claude Code runs
  its read-only commands (`cat`, `grep`, `find`, read-only `git` and others) and approves file reads
  inside its working directory before Domovoi's approval callback runs, so `cat ~/.aws/credentials`
  or a `Read` of a private key never produced an approval card, in any mode.
  
  The daemon registers a `PreToolUse` hook for every Claude Code session. A `Bash`, `Read`, `Glob`,
  `Grep`, `LS` or `NotebookRead` call that names a path outside the worktree (after following links),
  starts with `~`, expands a variable, runs a bare `cd`, or runs from a shell directory outside the
  worktree is sent to the approval path with the reason on the card. A read-only call that names a
  secret, such as `git show HEAD:.env`, goes there too, so the credentials hard gate applies. In Ask,
  which has no approvals, those calls are refused and recorded as a policy refusal. Reads that stay
  inside the worktree still run without a card.
  
  A standing rule no longer covers a `Read`, `Glob`, `Grep`, `LS` or `NotebookRead` of a path outside
  the worktree: those requests are never fingerprinted, so each one asks.
- 31eb8b1: Claude Code's read-only Bash commands now skip Domovoi's approval only when they are `cat`, `head`,
  `tail`, `wc`, `ls` without `-R`, or a Git read that prints no file content, and only when every
  argument is a path Domovoi can see before the command runs. Any other read, such as `grep -R`,
  `find -exec`, a glob or a pipe into `xargs`, now raises an approval card in Plan and Build and is
  refused in Ask, because it can reach files outside the worktree that are only known at run time.
- 95810a1: Fix Desktop discovery of a local TLS daemon whose configured certificate chain omits the root, while retaining certificate expiry, hostname, and owner-proof checks.
- 097e00d: Bound `domovoid pair` and `domovoid open` with one 15-second deadline that starts before the
  socket exists and covers connect, `system.hello`, and the call itself. A listener that accepts
  the connection and then says nothing is refused instead of holding the terminal forever, and so
  is a peer that completes the handshake and then stalls mid-call. Neither command can obtain a
  fresh allowance for a later phase.
  
  The refusal names the address that was waited on, which wait expired, and the remedy: check that
  domovoid is running at that address, then run the command again. `domovoid pair` repeats that
  refusal rather than its generic line, while every other daemon error stays generic so nothing
  quotes the request back to the screen. A refused command drops the transport instead of asking a
  stalled peer for a close handshake, but disposal remains Node's: a connection stalled inside a
  TLS handshake can outlive the refusal.
- 4a8b80a: The `domovoid` one-shot RPC client validates each frame with the JSON-RPC response schema before reading it. A `null`, number, array or notification frame is ignored instead of throwing inside the socket listener, a reply to the request that is not a well-formed response refuses without repeating its text, and `domovoid pair` validates the pairing code result instead of casting it. A pairing code result of the wrong shape is refused with the same `The daemon refused device.issueCode` error as a malformed reply, not a schema error.
- 0b293f4: When the Codex app-server dies partway through a line of output, the error shown is again its exit
  code and the reason it printed on stderr (for example that the sign-in expired), not "emitted invalid
  JSONL" for the leftover fragment.
- 9dbde2e: The Codex notice's repository-history scan now runs only when the worktree's Git settings could not
  run a program (the same check that gates Claude Code's Git reads), and it runs with repository hooks
  and fsmonitor switched off, no `ext::` transport, and lazy fetching disabled. A partial clone or a
  program-running setting makes the notice say "Domovoi could not finish checking the repository
  history." instead of running the scan.
- f0d3c74: The Codex notice's repository-history scan now refuses every Git transport while it runs, so a
  partial-clone setting written after Domovoi's check cannot make it fetch, and it does not run at all
  with a Git older than 2.45, which cannot refuse lazy fetches; the notice then says "Domovoi could
  not finish checking the repository history."
- c943176: When the Codex notice's repository-history scan fails, times out or reaches its bound, the notice
  now says "Domovoi could not finish checking the repository history." instead of listing nothing.
  `pwd` and a plain `echo` (no redirect to a file, no substitution) join the Claude Code reads that
  skip Domovoi's approval.
- b772543: Domovoi's note about the files the Codex sandbox refuses is now added to your own Codex developer
  instructions instead of replacing them. Before each Codex thread starts, Domovoi asks Codex for the
  `developer_instructions` it resolved for the session worktree (`config/read`) and sends both. If
  Codex cannot answer that request, the thread does not start.
- e37020a: The Codex sandbox notice now also names the files in the repository history that match the denied
  patterns, with "Codex can still read these through Git", because the sandbox refuses the file on
  disk but not a committed copy. The history scan is bounded to 1,000 matching commits, 3 seconds and
  256 KiB of output; a scan that fails or hits a bound lists nothing, and the session still starts.
- a6d18ac: Split Codex reasoning output from visible output tokens so usage totals preserve
  the provider-reported total without dropping or double-counting reasoning.
- 0bc3530: Codex sessions are refused in a worktree that holds configuration Codex would load from the
  repository itself: `.codex/config.toml`, `.codex/hooks.json` or `.codex/rules/*.rules`, in any
  directory from the session's directory up to the project root. Codex loads these once the person
  trusts the project, and they can start programs or change agent permissions. The refusal happens
  before Codex is asked anything, at session start, fork, a switch onto Codex, resume and each turn,
  and names the file: "Codex would load .codex/config.toml from this worktree, and that file can start
  programs or change agent permissions. Domovoi does not load repository-brought configuration until a
  trust gate ships. Remove .codex/config.toml from this worktree or use another provider here."
  
  A session worktree is a linked git worktree, and Codex takes hook declarations for it from the
  repository's main checkout: `.codex/hooks.json` and the `[hooks]` table of `.codex/config.toml`, in
  the main checkout folder matching each directory from the session's directory up to the worktree
  root. When the worktree is clean but the main checkout holds one of these files, the session is
  refused at the same points and names the file and the main checkout: "Codex would load
  .codex/hooks.json from this repository's main checkout at /path/to/repo, and that file can start
  programs or change agent permissions. Domovoi does not load repository-brought configuration until a
  trust gate ships. Remove .codex/hooks.json from the main checkout or use another provider here."
  
  Every Codex thread Domovoi starts or resumes now marks the project untrusted for that thread:
  `thread/start` and `thread/resume` carry `config.projects` entries with `trust_level = "untrusted"`
  for each path Codex consults for trust, the canonical path of every directory from the session's
  directory up to the project root and of the repository root, which for a linked worktree is the main
  checkout. Codex then loads no project `.codex` configuration, hooks or rules, and no longer writes a
  trusted entry for the project into the person's Codex `config.toml` when a Build thread starts. A
  trust level the person set for these paths is overridden for Domovoi's threads only; their
  `config.toml` is not changed. Codex turns shell snapshots off for untrusted projects.
  
  An untrusted project also stops Codex reading the repository's `AGENTS.md`, so Domovoi reads it and
  sends it with every Codex turn as `additionalContext`, including the first turn after a resume:
  `AGENTS.override.md` if it is a file, otherwise `AGENTS.md`, at the worktree root, in Codex's own
  "AGENTS.md instructions" format, within Codex's default 32 KiB budget and Domovoi's existing limits
  for instruction files (a regular file of at most 128 KiB that resolves inside the worktree). Text
  over Codex's 4,000-byte limit for one context value is sent as numbered entries so Codex does not
  shorten it. The person's own `~/.codex/AGENTS.md` still loads through Codex.
  
  Codex does not escape a context value, so an `AGENTS.md` could close the `INSTRUCTIONS` tag and its
  own entry and open a forged `domovoi-sandbox` entry. Domovoi sends the `<` of any `INSTRUCTIONS` or
  `domovoi-` tag in the file, opening or closing, in any case, as `&lt;`, and never splits a `&lt;`
  across two numbered entries. The rest of the file is sent as written.
- aa0c05d: Every Codex turn now also carries Domovoi's note about the files the sandbox refuses, as turn
  context (`additionalContext`), so a Codex thread started before that note existed learns it after
  it is resumed. Codex keeps the note once. A Codex that does not accept the field runs the turn
  without it.
- f303874: When a session starts on Codex, is handed off to Codex or is forked to Codex, the thread now says
  that the Codex sandbox refuses reads of `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`,
  `.netrc` and `.pypirc`, and that a test or build that loads `.env` fails with "Operation not
  permitted". Codex emits nothing for a refused command, so Domovoi also starts each Codex thread with
  developer instructions that name those files and ask the model to say so in its reply when a
  command fails on one of them.
- 961e74e: Codex sessions can no longer read common credential stores. Every Codex mode ran with whole-disk
  read access, so a command such as `cat ~/.aws/credentials` ran inside the sandbox with no approval
  card. The daemon now starts `codex app-server` with two permission profiles, `domovoi-read` for Ask
  and Plan and `domovoi-build` for Build, and selects one per turn in place of the old sandbox policy.
  Both keep the previous read, write and network limits and deny reads of `~/.ssh`, `~/.aws`,
  `~/.domovoi`, `~/.config/gh`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/.gnupg` and other credential
  stores, and deny secret files inside the worktree: `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`,
  `.npmrc`, `.netrc` and `.pypirc` at any depth. A test or build that loads `.env` inside the Codex
  sandbox now fails. Other reads outside the worktree still run without a card; a strict allow-list waits for a
  survey of the toolchains commands load. A denied command fails with "Operation not permitted", and
  commands that need `~/.gnupg` or `~/.npmrc`, such as signed commits, fail inside the sandbox too.
- ab18590: The daemon bearer no longer reaches child processes or borrows a device's name. A daemon started
  with `DOMOVOI_AUTH_TOKEN` kept it in its environment, so the Claude Code SDK, OpenCode and Kilo
  servers, agent processes and every terminal inherited the credential that resolves approvals. The
  daemon now removes `DOMOVOI_AUTH_TOKEN` and `DOMOVOI_CREDENTIAL_PATH` from the process environment
  once it has read them, including when the desktop app passes its own environment, and keeps them
  in memory so a second start in the same process uses the same bearer and path. The kept values are
  pinned to the profile directory that named them (its device and inode), and only a later read of the
  process environment for that same profile gets them back. Every acquisition takes them out first,
  including one that refuses, before it reads any option. `DOMOVOI_RELAY_CREDENTIAL_FILE` is
  taken and pinned the same way. The desktop app takes all three, and its development daemon token,
  out of its environment as the first thing its main process does. `AcquireLocalDaemonOptions` and `ProductionDaemonOptions` take
  `environmentOverrides`, settings added on top of the environment, which the desktop uses in
  development instead of a copy of its environment. Overrides may not set `DOMOVOI_AUTH_TOKEN`,
  `DOMOVOI_CREDENTIAL_PATH` or `DOMOVOI_RELAY_CREDENTIAL_FILE`; an acquisition given such an override
  throws before anything starts.
  
  A connection authenticated with the daemon bearer chose its own audit identity in `system.hello`,
  including a paired phone's `device-...` id, so its approvals were recorded under that phone. Such a
  hello is now refused, and `terminal.create` and `terminal.claim` refuse a request that names a
  paired device's id the connection did not authenticate as. Client audit actors carry
  `credential: "daemon"` or `"device"`, stored with the audit entry, including on a queued send the
  daemon releases later.
- 19a5fe5: Record provider context compaction as a quiet system marker in the session thread.
- f058294: Grade a fleet peer that refuses this daemon's protocol by which side is behind.
  The dialer reads the peer's version out of its refusal, and the heartbeat
  records `upgrade-required` when the peer is the older side and
  `version-mismatch` when it is the newer one, where it recorded
  `version-mismatch` for both. A refusal that names no version is graded by the
  version the peer last advertised.
- 9828935: `domovoid --help` now names the four environment variables the daemon reads that it left out: `DOMOVOI_TOOL_PATH`, `DOMOVOI_RELAY_IDENTITY_PUBLIC_KEY`, `DOMOVOI_RELAY_CREDENTIAL_FILE` and `DOMOVOI_WINDOWS_POWERSHELL`. A test now fails when the daemon reads a variable that the help text or the package README does not name.
- c746eab: Publish a machine identity without replacing one won by an overlapping daemon
  start, so every concurrent start adopts the same durable machine ID.
- 6f52997: Keep project standing approvals in Domovoi and grant providers one command at a time.
- 19a5fe5: Use provider-native Plan mode when available, keep prose plans available as a fallback, and expose provider-reported file changes with per-file line counts on tool activity.
- 051e889: Switching projects after a queued send no longer breaks the daemon. Queued sends load with the project that owns their session. A send still waiting when a switch interrupts its turn is held, so it is never released on a later, unrelated turn.
- 14527f0: Provision and reopen profile-scoped relay channel keys, retain only an external identity public anchor, and verify signed successors without silently replacing missing keys.
- b7f7c95: The switch to or from the login service is now held by the daemon itself. `system.serviceHandoffFence` (loopback, daemon credential only) answers the same refusal as the window's check, or, when nothing runs, no dispatch is in flight and no gate waits, admits no new turn until the connection that took it closes. The desktop takes it right before it stops the daemon inside the app or removes the service, so a turn that starts after the first check makes the switch wait instead of being stopped.
  
  Staging the shipped runtime refuses an app version that is not one release version, a `~/.domovoi` or `~/.domovoi/runtime` that is a link, a shipped part that is not a regular file, and a link that leads outside the shipped runtime, all before any byte is copied. Links inside the runtime are copied as they are. An earlier copy of the same version is moved aside and put back if the new copy cannot be renamed into place.
  
  After a failed install or removal the desktop reads the service back and reports it, along with the daemon it reaches afterwards, including one this app did not start. Settings no longer says nothing was installed or removed unless the read-back shows it.
- 279349c: The desktop can install the daemon as a login service from Settings and remove it again. The app copies the runtime it ships under the profile, asks the daemon's own installer to register the service pointing at that copy, and only then stops its in-app daemon and attaches to the service. The switch refuses while a turn runs or a gate waits and names the sessions; a runtime the app does not ship is reported without touching anything.
  
  Install and Remove both wait while a turn runs or a gate waits. The desktop main process checks this too, before anything is stopped: it reads the workspace from its own daemon (`readLocalServiceHandoffRefusal` in `@getdomovoi/daemon`) and applies the same check the window uses (`serviceHandoffRefusal` in `@getdomovoi/protocol`). A workspace it cannot read also makes the switch wait. While the service takes over the profile or gives it back, a window reconnect waits for the handoff instead of starting a daemon inside the app. The runtime copy is made in a fresh directory and renamed into place, so no file from an earlier copy of the same version survives. Settings says when the service was installed but this window could not reach it, when the daemon inside the app stopped and did not start again, and what to run when a removal leaves the profile owner unresolved. A daemon running outside the app is drawn as the installed service, with Remove available, only when the desktop reads the service as installed from the service manager.
- 19a5fe5: Batch adjacent streaming workspace deltas within the named 32 millisecond
  budget while preserving session and operation order. Flush queued deltas
  before snapshots, turn boundaries, other agent events, and shutdown so clients
  cannot apply streamed text twice. Reuse the active assistant item during a
  turn instead of scanning the full thread for every token.
  Mutating RPCs now return their snapshot once to the caller while still
  broadcasting the same change to every other client.
- 2cd8a1b: The daemon resolves the PATH it looks for provider CLIs on at startup, from an override, the account's login shell and the launch environment, records it in tools.json, and names the absolute path each CLI was found at. A packaged app launched from Finder or the Dock no longer reports every harness as not installed.
- 51a7431: Refuse corrupt WSL listings instead of reporting missing distributions. Discovery requires a
  valid header and every nonblank row to parse, with no partial results. Both `domovoid wsl list`
  and `domovoid open` report the corrupt classification and a diagnostic command to run, without
  repeating unreadable row contents. Header-only listings and explicit absence answers still work.
- 4a32392: Update production dependencies: the Claude, Kilo and OpenCode provider SDKs in the daemon; Electron 44.2.0 in the desktop; React 19.2.8, Lucide 1.42.0 and react-resizable-panels 4.12.4 in the shared ui and the clients. Development tooling moves with them (vitest 5, shadcn 4.21). The phone follows its Expo SDK: expo 57.0.22, reanimated 4.5.1 and worklets 0.10.1 as the SDK resolves them, jest held at 29 because jest-expo 57 expects it, and a deps:check that refuses drift from the installed SDK.
- df4716f: Bound pairing claims per source and listener without resetting on reconnect, and keep rejected pre-authentication traffic in a separate audit retention budget so it cannot evict operator decisions. Throttled claims do not consume a valid pairing code. Existing history remains readable.
- 5fea2c8: `system.emergencyStop` now broadcasts `system.emergencyStopped` before the idle workspace snapshot that reflects it, so a client holding a queued message sees the stop before the session goes idle and does not send the message that would restart the stopped work. While a stop is in progress, workspace snapshots and deltas that other changes would broadcast are held; the stop notice goes out first and one snapshot then carries every change. The client that made a change still gets the new state in its own reply.
- 91b1e15: Accept compatible patch versions in daemon snapshots without rewriting the reported
  version. Validate bounded canonical wire versions consistently and compare major
  and minor components exactly, including values above the safe integer limit.
- 0d60644: Expire every stored pending approval card when the daemon starts and when a project's saved state is opened again. A stored card's provider request id came from a provider process or thread that is gone, and a new provider process can issue the same id to a live request in another session, so allowing or archiving the stale card could decide that request. Startup archive recovery no longer sends a decision to the provider for stored cards. At startup, each session whose card expired and that had no active turn gets the thread line "Domovoi restarted, so this approval request expired. Send a message to continue." A session whose turn was interrupted gets only the existing "Daemon restart interrupted the active turn." line. When a project opens again, each session whose saved card expired gets the thread line "This approval request expired when the project closed. Send a message to continue." Each session gets one line however many cards it held. The agent asks again when the session continues.
- 65da87b: An emergency stop now fences two handlers that had already passed its checks. A queued message released at a turn boundary carries the stop's cancellation into its `session.send`, so a stop that lands while the provider starts the turn leaves the message held instead of delivered and the session without the new turn. An `approval.resolve` that is reading package scripts checks again after that read and refuses when the stop has already denied and removed the approval, so the agent is not told "allow" after the stop's "deny".
- 18f6543: Upgrade Zod to 4.5.2 while preserving UTF-16 string limits, persisted minute-precision timestamps, transfer manifest digests, and readable validation refusals.
- ca22e9e: Reserve time for fallback routes inside one overall fleet dial deadline. Each eligible route gets
  a share of the remaining time for connection and authenticated hello, so a silent first endpoint
  cannot consume every later route's allowance. Cancel abandoned attempts, reject late results, and
  retain typed timeout refusals naming a sanitized address instead of arbitrary transport error text.
- 9e1e9c5: Keep healthy fleet machines readable when another stored machine row is malformed. Retain the damaged row in quarantine with an atomic, sanitized audit receipt, and exclude it from dialing and heartbeat updates.
  
  Add opt-in quarantine diagnostics to `fleet.list` with typed operator remedies. Existing list calls, lifecycle replies, and notifications retain their wire shape. UI rendering is unchanged. Forget or explicitly enroll a peer again when its identity is valid; invalid identities require offline registry repair.
- 4359bcf: Fix provider usage accounting and persist dispatch attribution, deduplication and coverage across restart and transfer.
  
  Versioned transfers use contract v2 to carry portable accounting. Both endpoints must support v2; strict v1 receivers cannot parse the added evidence.
- 4bf0e8e: Git for Windows' default `diff.astextplain.textconv = astextplain` no longer makes a Claude Code Git
  read ask or stop the Codex notice's history scan. Any other value for that key, and any other diff
  textconv, still does.
- eb8040e: A cross-provider handoff now tells the next provider how many recognized test runs passed and failed in the session, from the same thread evidence `session.evidence` reports. Before, it always sent the session summary's counters, which are set to zero when a session is created and never updated, so the receiving agent was told no test had passed or failed. The counts cover the whole session, so the handoff also names whether the latest recognized run passed or failed (`last`). A session that failed three times and then went green is not handed off as tests currently failing.
- 6b30c51: Reject overlapping bundle restores before repository inspection or fetch, including independent
  service instances sharing a worktree root. Keep later incremental restores and concurrent restores
  of different sessions working. Release owned filesystem claims on normal completion, failure and
  cancellation; report a claim left by a killed process for explicit recovery with Domovoi stopped.
- 12f0a90: Domovoi reads the repository instruction files it sends to Claude, Codex, OpenCode and Kilo by
  opening each file once and reading only from that open file. Before, it checked a path and then
  opened the path again, so a process writing in the worktree could swap the file for a link to a file
  outside it between the check and the read, and the outside file's contents were sent as project
  instructions. The file is now opened without following a link (`O_NOFOLLOW`, with `O_NONBLOCK` so a
  named pipe cannot hold the open), must be the same file, by device and inode, that the check found,
  must be a regular file of at most 128 KiB, and is read up to that limit. Each directory between the
  worktree root and the file must be a real directory, not a link, and the same one before and after
  the open; otherwise nothing is sent from that file.
  
  A hard link has no target to resolve, so a worktree name hard-linked to a file outside the worktree
  passed every path check and the outside file's contents were sent. The open file must now have
  exactly one name (a link count of 1); a file with more names, inside the worktree or not, sends
  nothing.
  
  Windows has no `O_NOFOLLOW`. There the check before the open refuses a link, and the device and
  inode comparison after the open refuses a link swapped in between. Node has no call that opens a file
  relative to an open directory, so a directory swapped for a link and back again between these checks
  is narrowed, not ruled out, on every platform.
- 4712ef9: The instruction files Domovoi reads for a session no longer follow an `@path` import found in
  Markdown code (double-backtick and multiline code spans, fences indented up to three spaces, fences
  left open, and indented code blocks), and never read a file inside Git metadata or inside a nested
  repository or submodule, including through a symlink at the worktree root.
- 972e6c7: An inline HTML code tag that opens inside emphasis and closes after it still hides the import it
  encloses, and a closing tag of a different element no longer ends it.
- 5da6a5a: The instruction files Domovoi reads for a session are now parsed as CommonMark
  (`mdast-util-from-markdown`), and `@path` imports are taken from text only, never from code blocks,
  code spans or raw HTML. Fences inside list items, code spans after an escaped backtick, and indented
  code right after a heading no longer load an import, and an import after such a fence is no longer
  lost.
- 96c757b: An inline HTML code tag is recognised only by its own tag name, so a tag written inside another
  tag's attribute or inside an HTML comment no longer hides or reveals an instruction-file import.
- d47bfc6: An `@path` import written between inline HTML `<code>`, `<pre>`, `<kbd>` or `<samp>` tags in an
  instruction file is no longer loaded.
- 6b0e4fd: The daemon reads the web app a pairing code can be opened in from `DOMOVOI_WEB_APP_URL`, or `webAppUrl` in the service configuration file. It must be an absolute `http` or `https` URL without whitespace, control characters, credentials or a fragment, at most 2048 characters; the daemon refuses to start with anything else and does not echo the value. An invalid saved `webAppUrl`, including one that is not a string, fails as a `DaemonConfigurationError`, both when the configuration is parsed and when the service loads the file. When it is set, `device.issueCode` returns it as `webAppUrl` beside `pairingAddress`; when it is unset, the result has no `webAppUrl`. The protocol validates the field with `webAppUrlSchema`.
- 7815f0a: Pin a kept inherited bearer to its profile directory by device, inode and canonical path. A
  directory at another path that reports the same device and inode, as a new directory can when a
  filesystem such as ext4 gives it the inode number of one just deleted, no longer receives the
  bearer kept for the deleted profile. The directory's birth time is not part of the identity:
  where statx is unavailable, the reported birth time is the change time, which moves whenever a
  file is added to the directory.
  
  A profile directory that exists but whose canonical path cannot then be read, for any reason
  including ENOENT, now receives no kept bearer. It used to be read as a directory that did not
  exist yet and could match a bearer pinned by path.
  
  The canonical path must also lead to the directory the stat saw. A profile symlink retargeted
  between the stat and the canonical-path lookup, or a canonical path that names another directory,
  leaves the profile unnamed, so it keeps and receives no bearer.
- 4aa3ef7: Update @napi-rs/keyring to 2.0.0. A locked or inaccessible keychain now throws from every read and write, and a delete returns false only when nothing was there; every caller already reports that throw as unavailable and never as an absent credential.
- 1204d6c: Allow transfers to known eligible machines even when legacy fleet recovery rows exceed the display limit. Keep pending enrollment and forget operations masked, retain credential checks, and refuse transfers when pairing or the credential store is unavailable.
- 5ae04b0: When every harness is missing, Start a session shows a search report instead of a status list: what the daemon looked for, the PATH it searched, and that finding nothing there is not proof nothing is installed. The daemon reports the searched PATH on the machine (machine.toolPath), and a missing harness reads Not found rather than Not installed everywhere.
- aba51b2: Startup reads and migrates the stored workspace once instead of twice: the first `load()` takes the snapshot the store constructor already migrated. Opening a project no longer reads and migrates the whole current workspace just to learn this machine's record; the daemon passes the machine it already holds.
- 50510c7: Desktop no longer reports every in-app daemon startup failure as an invalid profile. `acquireLocalDaemon` names three causes the owner can act on: `port-in-use` when another program holds the daemon's port, `state-locked` when another process holds the profile's state database (SQLite busy or locked), and `identity-mismatch` when the stored workspace belongs to another machine identity. Other failures keep `profile-invalid`. Every startup failure is now written to the error sink with its redacted cause, so Desktop's log keeps it. A port already in use now refuses at once instead of waiting out the startup deadline, because the WebSocket server's copy of the listen error no longer throws before `start()` can reject, and stopping a daemon whose listener never started no longer fails, so the profile lease is released and the next attempt in the same process can start. A Desktop owner record left `stopping` by a Desktop that quit before its daemon finished stopping is retired when the next launch holds the profile lease, so that launch starts instead of being refused as unreachable. After the daemon is listening, a later error from its WebSocket server is written to the error sink instead of being dropped.
- 3e2c556: Report a machine that ran out of time as an unreachable owner rather than an invalid profile.
  Acquiring the local daemon recognised an expired budget only when the deadline error was the one
  thrown. A startup step that bounds itself reports its own expiry and carries the deadline as a
  cause, so credential initialization timing out was classified as `profile-invalid`, and the
  refusal told the person to inspect their owner record, private key and credential file. Nothing
  was wrong with any of them; the machine was slow.
  
  The classification now looks through the wrapper, including the aggregate a step raises when its
  cleanup also failed, and answers `owner-unreachable`, which says to wait for the daemon or start
  it explicitly. A genuinely damaged profile still reports `profile-invalid`.
- ccc14a7: Report a locked or unavailable OS keychain separately from an absent machine, provider, or relay credential.
- 7bc1d86: Release one-shot CLI connections after a complete reply as well as after a refusal.
  A peer that withholds its close acknowledgement can no longer keep an answered
  `domovoid pair` or `domovoid open` process waiting outside the command deadline.
  No configuration changes or re-pairing are required.
- 0a7be6d: An IPv4-mapped IPv6 address counts as loopback only inside 127.0.0.0/8. The check matched any
  mapped address whose hex began with `7f`, so `::ffff:7.240.0.1` was treated as this machine when
  classifying routes, choosing which routes to dial and checking a tailnet host.
- e6fa2ec: The protocol package exports `notificationMethods`, the schema of the params of every notification
  the daemon sends, with the `NotificationMethod` and `NotificationParams` types. The daemon now sends
  a notification only if its payload parses against that schema and carries no field the schema does
  not describe. A refused notification is reported and not sent. A workspace resync that cannot be
  built closes the slow client, which reconnects, instead of sending an unchecked snapshot. The
  daemon's RPC writer sends a notification only as a frame built from `notificationMethods`, and a
  response only as a frame whose serialized envelope is a JSON-RPC 2.0 response, whose result parses
  against its method's result schema, whose error data is one of the protocol's declared error data
  kinds, and which carries no field those schemas do not describe. A result that fails the check is
  reported and the request gets an internal error instead.
- 9901dd5: Resuming an OpenCode or Kilo session is refused when its history pages repeat a cursor, since the
  pages then cannot be shown to cover the history, and a full page that comes back without a cursor
  is followed by one read of the whole history before the next message id is chosen.
- 95d5434: A failed subagent refusal is retried only against the same link of that subagent, never against a
  later subagent that reused the id, and a repeated deletion without a parent keeps the deletion's
  original thread, so unloading that thread still clears it.
- 966f5c3: OpenCode and Kilo sessions can send prompts again. OpenCode 1.18 and Kilo 7.7 refuse a message id
  that does not start with `msg` ("Expected a string starting with \"msg\""), and the adapter sent a
  random UUID with every prompt and steer, so every send failed with HTTP 400. The adapter now makes
  ids in the servers' own ascending scheme: `msg_`, the milliseconds times 4096 plus a counter as
  twelve hex digits, then fourteen random base62 characters, so they also sort with the ids the
  server makes.
  
  Each id also sorts after the last one the daemon made, when the clock steps back or a millisecond
  runs out of counter values, and after the newest message the session already holds: on resume the
  adapter reads the greatest id in the session's whole history, a page at a time, and it follows
  every message id the server reports.
  
  When a session already holds a message at the last order the servers' 48-bit field can hold, no
  id can sort after it, so the next prompt is refused with "OpenCode session has used the last
  message id the server can order, so it cannot take another message" (or the Kilo name) instead
  of sending an id that wraps to zero and sorts first. One such session does not stop ids for the
  others.
- a848818: A subagent refusal that fails after its OpenCode or Kilo thread was unloaded is dropped instead of
  being kept for the thread's next load, and a subagent deletion seen before its creation is
  remembered so the creation that follows adopts nothing.
- 4fb3d7c: A subagent refusal that fails after the subagent was deleted is dropped instead of kept for retry,
  and a subagent deleted again is remembered as the most recent deletion, so a burst of deletions
  cannot make it adoptable again.
- 263a67e: An OpenCode or Kilo subagent is now bound to the turn that started it. When that turn ends, any
  approval the subagent is still waiting on is refused on the provider and forgotten, so answering its
  card later does nothing and the subagent's work does not run. An approval the subagent asks for
  after its turn ended is refused at once, with no card, and anything else it sends then is dropped
  instead of being attached to the next turn. Approvals the thread's own agent asked for are
  unchanged.
- 36fc9d0: An OpenCode or Kilo subagent first seen while its thread has no active turn is now never linked to a
  later turn, so none of its requests become a card, and neither do those of anything it starts. A
  refusal the provider did not accept is kept and sent again when its card is answered or the
  thread's next turn starts or ends. A deleted subagent's record is dropped, with a bounded record of
  recent deletions so it is not adopted again.
- 69cbaee: OpenCode and Kilo subagents now run under Domovoi approvals, and current servers' approval
  requests reach Domovoi at all. A subagent the `task` tool starts keeps only its parent's deny
  rules, so the built-in `general` and `explore` agents ran shell commands and edits with no
  approval card, and the adapter dropped every event from a session it had not created.
  
  Every agent now asks before it edits, runs a command, fetches or leaves the project, through a
  top-level `permission` block in the inline OpenCode and Kilo configuration. The adapter follows a
  subagent session from its `session.created` event to the Domovoi thread that started it, raises
  its approval requests on that thread's turn, answers them on the subagent session, and shows its
  commands and file changes in the thread. A subagent finishing does not end the turn.
  
  OpenCode 1.18 and Kilo 7.7 send approval requests as `permission.asked`, which the adapter did not
  handle, so a Build turn that needed an approval waited forever. Both `permission.asked` and the
  older `permission.updated` are handled. A Kilo event that carries no properties, such as `sync`, no
  longer ends the event stream and fails the turn.
- 767c388: When an OpenCode or Kilo thread is stopped or its provider session is deleted, every approval still
  pending for it or its subagents is refused on the provider and forgotten, so a later answer to its
  card sends nothing. A provider-deleted session fails the active turn ("OpenCode deleted the
  session") and unloads the thread. A deleted subagent's pending and failed refusals are dropped, and
  an unknown session is adopted only from its creation event.
- 35a0cc6: Run the person's own installed `claude` for Claude Code sessions. The daemon finds `claude` on the
  tool PATH, the executable provider readiness already reports, and passes that path to the Claude
  Agent SDK instead of letting the SDK start its own bundled agent binary. Without `claude`
  installed, model discovery and new or resumed Claude Code sessions fail with "Claude Code is not
  installed" and the SDK is never called.
  
  The desktop app no longer packages the SDK's per-platform `@anthropic-ai/claude-agent-sdk-*`
  packages, so it carries no copy of the agent binary and packaging never re-signs one. It still
  bundles the SDK's JavaScript library, which the daemon imports.
- 1fadaa1: Retain exact reviewed skill text by digest with bounded on-demand retrieval, report missing revisions as unavailable, and validate versioned declared scopes before approval or prompt delivery.
- 71efbdd: Recover a profile after verified service removal using an owner-only receipt bound to the exact
  stopped instance and installation registration. New service installations carry that registration;
  older saved configurations remain readable but need reinstalling to gain automatic removal proof.
  
  For legacy or custom supervisors, `domovoid profile recover --confirm-no-supervisor` records the
  operator's explicit assertion that no supervisor will restart the daemon. It refuses a live owner,
  does not start a daemon, and does not treat missing configuration or elapsed time as shutdown proof.
- ea4a201: A provider disconnect no longer marks a frozen transfer source or an unfinished archive as failed. Those sessions keep their lifecycle and provider thread, so the workspace snapshot stays valid and saves, `system.hello` and `workspace.get` keep working. Any turn or approval they still held on the exited process is cleared, as for other sessions of that provider. The disconnect result is also validated on a copy before it reaches the live workspace. Queued sends it holds are written in one store transaction before anything else changes; if the store refuses one, that send stays as it was and the rest of the disconnect still applies.
- adc3f35: Provider exit reasons read the child's stderr once its streams have closed. The Codex app-server
  transport and the ACP agents built the "exited with code 1: <stderr>" reason in the process `exit`
  handler, and Node documents that stdio may still be open when `exit` fires, so the last line a
  crashing CLI printed ("401", "Not logged in") could miss the reason and the failure be classified
  as unknown. The reason is now built on `close`. A grandchild that inherited the pipes can hold
  `close` off indefinitely, so the end is reported 500 ms after `exit` if `close` has not come by then.
- ed11c45: `project.open` on a folder that is not a Git repository, a path that does not exist, or a repository with no commits now answers "That folder is not a Git repository with at least one commit" instead of "Internal daemon error", and `domovoid open` prints that sentence. The git error stays in the daemon log. Git missing from PATH answers "Git was not found on this machine's PATH. Install Git, then restart Domovoi so it can find it." and a safe.directory ownership refusal answers "Git refused this folder because a different user owns it. Add it to Git's safe.directory list, then open it again."; `domovoid open` repeats both. Other inspection failures, such as a permission error, keep the internal error. When `session.send` cannot connect to the provider, resume its thread, or start a turn, the session records the classified provider failure, so clients show the sign-in, quota or change-model guidance, and the call answers with that failure's fixed message. A failed steer of a running turn answers the same way but does not mark the session, because its turn is still running. Timeouts and cancellations keep their existing handling.
- 9387a5d: Make the protocol package installable from a registry tarball. The manifest now carries top level
  `main` and `types` so consumers on the `node10` module resolution can find the declarations, a
  `default` export condition so CommonJS and non `import` resolvers reach the same entry, a
  `./package.json` subpath, `sideEffects: false`, and the `keywords` and `bugs` metadata a registry
  listing needs. A `prepack` script builds `dist` before packing, so a tarball can no longer be
  produced without the files its manifest points at.
- f9955d6: A queued message the running build cannot read no longer stops the daemon from starting. The row moves to a `queued_session_send_quarantine` table with its bytes and the reason, a `queued-send.quarantine` audit receipt names it, the daemon error log reports it, and the other queued messages still load. Reasons written when a queued message changes state are trimmed and bounded to the 1,024 UTF-16 units the loader accepts. If the database is locked or the move fails, the row is skipped for that load, stays where it is, and the error log says it was not moved; the next load tries again. A new queued message for the same session moves an unreadable row aside before replacing it, and refuses to replace it if the move fails. A row with no session id is moved aside once. The daemon keeps the same bounded reason in memory that it writes to disk.
- 28efb31: Give audit queries and exports their own finite 30-second read deadline, independent of agent operations. A short agent timeout no longer cancels valid audit reads. Preserve audit cancellation and rejection of results that arrive after the audit deadline.
- 80c8318: Add a guest crash supervisor with three bounded restarts, private atomic evidence and explicit exhaustion status. Stop and retire one supervisor registration, proving its loop and recorded children dead before task removal. Service status returns failure for exhausted, failed or unbound supervision while preserving its diagnostics. WSL installer selection remains pending.
- 2a0d03a: Move machine credentials and their index behind a bounded serialized worker so a slow OS
  keychain cannot stop unrelated RPC, provider or terminal delivery. Keep caller deadlines
  across queueing, construction and native steps, without allowing timed-out work to be overtaken.
  Recheck fleet eligibility after reads and preserve journal digest checks during index repair
  and deletion. The local fleet-keychain recovery CLI uses the same worker.
  
  No wire or pairing migration is required. Native work already entered can finish after the
  caller expires; pending operations stay visible until reconciliation verifies the result.
  A failed worker requires a daemon restart. Shutdown reports failure if its exit is unconfirmed.
- 130500f: Stop and verify the Windows logon task before removing its registration and saved configuration.
  Previously removal could report success while the daemon kept running. Windows removal now uses
  the built-in PowerShell Task Scheduler API, disables new starts, and shares one 30-second deadline
  across all phases. An unavailable manager, unknown state, or timeout refuses with an actionable
  task-specific error instead of falling back to deletion. Credentials, identity, session state, and
  worktrees are not removed.
- 946f8ee: Wait for a killed process to exit before treating what it held as free.
  
  Session archive killed the session's terminals and then removed the worktree without waiting. A
  pty shell keeps that worktree as its working directory until it actually exits, so the removal
  raced a dying shell, which Windows refuses outright while a handle is still open. Archive now
  observes each closed terminal's exit before removing the worktree, under the existing agent
  timeout, and reports a terminal whose exit it could not confirm.
  
  The Codex stdio transport reported its close as soon as it sent SIGKILL rather than when the
  app-server exited, so a shutdown could claim a stopped provider and a reconnect could start a
  replacement alongside a process that still held the workspace. The close now waits for the real
  exit after the kill, bounded by the same shutdown grace, which is the pattern the ACP transport
  already uses.
- 7cd200e: Preserve non-default daemon settings when installing systemd, launchd, and Windows logon services. Each launch reads the same validated non-secret configuration, including TLS paths, listener settings, allowed origins, and identity paths. Installation refuses an environment-only bearer instead of silently changing credentials; use a private credential file before installing. Service manager operations share a bounded deadline.
- 997661b: Recover interrupted session creation and checkpoint forks from durable intent.
  Preserve unfinished work without replaying provider setup. Expose a recovered
  worktree only after its completion receipt, repository, branch, and HEAD verify;
  otherwise retain its location for inspection. Keep intent through failed or late
  cleanup until worktree removal settles or a session snapshot commits.
- 7a069eb: Secret redaction now catches prefixed variable names such as `DOMOVOI_AUTH_TOKEN`, `NPM_TOKEN`,
  `HF_TOKEN`, `DATABASE_PASSWORD`, `POSTGRES_PASSWORD` and `CLOUDFLARE_API_TOKEN`. The name patterns
  required a word boundary right before the sensitive word, and `_` is a word character, so
  `NPM_TOKEN=value` was stored, broadcast and shown on approval cards in clear, and a command
  carrying one was not treated as containing a secret. A sensitive name may now carry an identifier
  prefix in assignments, `export`, PowerShell `$env:`, `set "..."`, JSON-style keys, `--prefix-token`
  flags and `-Dprefix.password=` properties, including npm's `//registry.npmjs.org/:_authToken=` and
  `npm_config__authToken=`. `SECRET_KEY`, `DJANGO_SECRET_KEY` and `STRIPE_SECRET_KEY` are caught too.
  A suffix still does not count, so `TOKEN_BUDGET=4096`, `TOKENIZERS_PARALLELISM=false` and
  `SECRET_KEY_BASE` are left alone, and a negated flag such as `psql --no-password mydb`,
  `mysql --skip-password mydb` or `tool --db-no-password mydb` is not taken as a secret. After a
  prefixed name, a plain number or `true`/`false` stays visible when the word right before the
  sensitive name is `total`, `has`, `max`, `min`, `count`, `is` or `enable`, so `total_token=5` and
  `has_secret=false` read as written. Every other value stays hidden, including
  `DB_PASSWORD=123456` and `limit_token=5`. One-dash flags such as `-db-password value`
  and `-token value` are read as flags too. The terminal holds a prefixed name whole across reads,
  with a `set "` or `$env:` before it, drops the rest of a value that outgrows what it carries up to
  the value's end, and does not show a counting value whose line began before an idle flush. A
  quoted value it drops ends only at an unescaped closing quote, even when a backslash and the quote
  arrive in different reads. When a name alone outgrows what it carries, the value that follows is
  still dropped whole, quoted or not, and the fields after it are kept. A quoted flag or `-D`
  property value now honours backslash escapes, so `--token "a\"b"` is hidden whole instead of
  leaving `b` in clear. A quoted value, including `$'...'`, now stays hidden up to its unescaped
  closing quote across spaces, tabs, `;`, CR, LF and terminal reads, so `NPM_TOKEN="a b"` read in
  two pieces and `--npm-token="a\rb"` no longer show `b`, in terminal output, stored command output,
  approval cards and thread copies. A quote that never closes hides the rest of the record, and the
  terminal and the command output stream keep hiding into the following output until it closes,
  across an idle flush too. A command substitution, `$(...)` or a backtick pair, now stays hidden up to
  its matching closing delimiter, nested or inside double quotes, across spaces, line breaks and
  terminal reads, so `TOKEN=$(get secret value)` and ``--token `get secret` `` no longer show what
  follows the first space. A substitution that never closes is handled as an unclosed quote is.
  Process substitutions, `<(...)` and `>(...)`, parameter expansions, `${...}`, arithmetic,
  `$((...))`, and array assignments, `NAME=(...)`, now stay hidden up to their closers the same way,
  so `NPM_TOKEN=<(printf a b)`, `NPM_TOKEN=${VAR:-a b}` and `NPM_TOKEN=(a b)` no longer show what
  follows the first space. A value is now read as one shell word: a quote in the middle of it opens
  (`TOKEN=ab"c d"`, `TOKEN=ab'c d'`, `TOKEN=ab$'c d'`), and a quoted value goes on to its delimiter
  after its closing quote. A quote opened right before a name, as in `set "NAME=value"` or
  `echo "NAME=a b"`, holds the value up to that quote's closer, honouring backslash escapes as any
  quoted value does, so `set "TOKEN=a\"b"` no longer shows `b`, and the value goes on to its delimiter
  after the closer, as `echo "TOKEN=a"b` is one word. Where the terminal has lost what came
  before a name (an idle flush in the middle of it, or a name longer than it carries), a quote in the
  value still opens, so a `set "NAME=value"` split there may hide the output that follows until
  another quote arrives. A deeply nested value read one
  character at a time now costs each read only what that read holds, rather than a copy of the whole
  nesting. A `-D` property may have spaces after its `=`, so `java -DPassword= value` is hidden. A
  name and separator inside a value, as in `-DGITHUB_TOKEN ==Password: value`, hide the value that
  follows them too, even past the end of the value they sit in. A name and separator at the end of a
  line, as in `X_TOKEN:` or `{"x-token":`, hide the first value on the next line in the command
  output stream as they already did in stored output and the terminal, so that stream holds such a
  line until the next one arrives. A name inside another name's quoted value, as in
  `java -Dpassword="a API_KEY=b" -jar app.jar`, is part of that value: it is hidden with it, and what
  follows the value is kept. A doubled separator or terminal formatting where a value starts, as in
  `TOKEN==(a b)` or a colour code before the value, still lets an array's `(` open there. The
  terminal no longer shows a value that ends in or holds a sensitive word when a read ends inside it,
  as in `TOKEN=abctoken` followed by more, or a flag typed one character at a time: it holds from the
  name that value belongs to. A sensitive word glued to the end of a value, with a separator after it
  (`TOKEN=abctoken: value`), hides the value after it. At an idle beat the terminal keeps dropping a
  word it was reading, a closed quote's word included, up to its delimiter, and a name and separator
  at the end of what it shows drop the value typed after the beat. A name after the closing quote of
  `set "NAME=value"` hides its own value in every copy. A long chain of glued names
  (`API_KEY=a_token=a_token=…`) is read in linear time.
- 9c12124: `device.redeemCode` validates `protocolVersion` with the shared protocol version schema, like every other version reader. A noncanonical or overlong version (such as `01.8.0`) is now refused as invalid params with the request's id, instead of passing validation and failing inside the compatibility check as an internal error with `id: null`.
- 8e18a9b: Creating a session no longer runs code the repository brings. Claude Code sessions loaded the
  worktree's project and local settings, so a tracked `.claude/settings.json` hook, `env` block or
  helper command and every `.mcp.json` server ran with no approval card, in every mode including
  Ask. OpenCode and Kilo loaded project configuration, plugins and MCP entries for the worktree and
  ran a package install in its `.opencode` directories.
  
  Until a repository trust step exists, Claude Code sessions start with only user settings, and the
  OpenCode and Kilo servers start with project configuration switched off. Instruction files still
  reach the agent: the daemon reads `CLAUDE.md` (with its `@path` imports inside the worktree),
  `.claude/CLAUDE.md` and `CLAUDE.local.md` for Claude Code, and the first of `AGENTS.md`,
  `CLAUDE.md` and `CONTEXT.md` for OpenCode and Kilo, and passes them as system prompt text. Project
  skills, subagents and commands under `.claude/` are not loaded for Claude Code sessions.
  
  Kilo reads `.kilo/mcp.json`, `.kilocode/mcp.json` and `.kilocodemodes` from the session directory
  even with project configuration switched off, and starts the MCP servers they name. The daemon now
  refuses to open, resume or send a turn to a Kilo session in a worktree that contains one of them,
  and names the file.
- 9cac913: The restore lease record is no longer flushed to disk on every write, and the writes no longer
  block the daemon's event loop. A restore wrote the record three times per Git command, each with a
  synchronous flush; on Windows runners a flush measured up to 0.85 s, so one restore could stall the
  daemon for seconds. The record is still written to a new file and renamed over the old one, so a
  reader sees a whole record, and a crash of the daemon process keeps the last completed rename.
  After an OS crash or power loss an unflushed record can be lost or torn; no Git child survives a
  reboot, and recovery already refuses to reclaim a claim whose record lists children or cannot be
  read, so the claim is kept for inspection as before.
- 8e3a45f: Recover abandoned transfer restore claims only after the owner has exited and
  every Git command has a recorded, uninterrupted settlement. Preserve claims when
  descendant liveness is unknown, including after command cancellation or a missing
  exit record. Keep exclusion through command close and delayed claim cleanup;
  refuse legacy or incomplete ownership records explicitly.
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
- e08eda3: Whole-snapshot writes no longer discard concurrent changes. An arriving `transfer.commit` imports only its session into the live workspace at the save point, so two overlapping commits keep both sessions. `session.fork` merges only the new session into the live workspace, so text another session streams during the save is kept. The transfer commit, the provider thread restart and the ownership-conflict write now join the persistence serializer, so a worker write posted earlier can no longer land after them and put an older snapshot back on disk.
- 2cdba11: Refuse overlapping service install, status and removal commands using a separate per-OS-user
  operation lease held across file and manager steps. Changing the shell's home cannot bypass it.
  The daemon can still take its own profile lease while installation waits for startup. A refused
  command names the lease and asks the operator to retry after the active command finishes.
  
  The existing deadline remains shared across the whole operation. After a timeout the lease stays
  held until the CLI exits. A killed or timed-out CLI does not prove a native manager cancelled its
  job; inspect the manager and saved configuration before retrying. No credentials are changed.
- 788f63d: Prevent concurrent transfer chunk retries from removing a directory while another receive
  still holds a chunk open, which can fail with EPERM on Windows. Reserve the complete member
  receive through cleanup within the daemon process, refuse overlapping receives without a
  queue wait, and release the reservation after errors so later retries can proceed.
- 6ab8dad: Workspace snapshot writes that arrive while one is still waiting to start now share that write, since each write carries the whole live snapshot as it stands when it starts. The backlog is at most one running and one pending write, so a burst of provider events or RPCs no longer queues one whole-snapshot write each and delays tool rows and approval cards behind them.
- 90a3111: Report service runtime state on macOS and Windows. Distinguish a loaded launch agent from a running process, and read numeric Task Scheduler state instead of localized status text.
- 6b30c51: Attempt restore-claim close and removal independently, always clearing the process-local reservation. Verify a unique ownership token before removing a claim, preserving an observed replacement and naming its ownership change. Report cleanup failures with the claim path while preserving the original restore failure. If restoration already completed, explicitly warn against retrying it. Manual claim removal still requires stopped daemons because token verification and unlink are not atomic.
- f15b01b: Build node-pty from source during verified bootstrap installation on musl or unknown Linux libc instead of choosing its libc-unqualified prebuild. Check native module loading before publishing an installation and on receipt reuse, within the existing five-minute deadline. An unusable existing runtime is refused with a path and remedy, never replaced automatically.
  
  The pinned Node 22 Alpine smoke installs the real archive, opens a PTY, and authenticates against the production daemon. Python, make, a C++ compiler, platform headers, and registry access remain required. Manual package-manager installs do not apply the bootstrap policy; native compilation and the external toolchain are not frozen by the runtime lock.
- 2c9ffc1: Accept a WebSocket whose Origin names this daemon, so a phone that sends the address it dialled can pair.
- ee3fe90: Add separate, kind-bound remote client grants and Fleet client admission. A machine pairing remains daemon-to-daemon authority, not permission for a desktop or browser to control the target.
  
  Operators issue a separate client credential on the target with `domovoid pair --client desktop --label "My desktop"`, then choose Authorize this client in Fleet. Use, Terminal and inventory reads require the target identity and client receipt to verify. Desktop main verifies each enrolled route through the home daemon and grants only that exact socket origin. Update both daemons and the client before using these additive calls. The wire remains 0.5.0, existing pairings remain valid and no re-pair is required.
  
  Client credentials stay only in app memory. Closing the app or removing local access does not revoke the remote grant; revoke the device in the target's Devices list. Remote Desktop preview frames remain unavailable until they have a separate verified path. This does not enable a hosted relay or expose the daemon's machine keychain to the client.
  
  Desktop serves its bundle from an explicit app origin so response CSP is enforced. Existing development profiles may need appearance, layout and first-run preferences selected again because old file-origin browser storage is not migrated. The daemon profile and its canonical sessions are unchanged.
  
  If `DOMOVOI_ALLOWED_ORIGINS` is explicitly configured, add the exact `domovoi-app://desktop` origin and restart that daemon. The default configuration already includes it; custom lists are not silently widened.
- 7e30caa: Stored state that cannot be read is no longer moved aside silently. The daemon records a `state.quarantine` audit receipt naming the kept file, logs it, and returns an optional `stateRecovery` field on every client `system.hello` result until it restarts. A database moved aside whole, including one where `PRAGMA quick_check` finds damage in a table other than the workspace, keeps its workspace snapshot and paired devices when they still read and validate. Paired devices receive only whether a recovery happened and what was kept, not the path or the failure text. State written by a newer protocol minor is read through a read-only connection, left byte for byte in place, and startup fails with a message naming the file and both versions, so going back to an older build no longer resets the newer build's workspace.
- 67e712e: State written by a newer protocol minor is refused with `NewerWorkspaceStateError`, which names the
  path and both versions: "Domovoi state at <path> was written by a newer daemon (protocol <stored>),
  and this daemon speaks protocol <daemon>. It was left as it is and this daemon did not start. Run
  the newer Domovoi again, or update this one to protocol <stored major.minor> or later." `domovoid`
  prints that message and exits 1 instead of a stack, and the desktop's acquisition carries it as the
  refusal message instead of the generic profile one.
- 41a8edf: When SQLite ends a store transaction on its own, as it does when the database is full, saving a transferred session and holding queued sends now report the error that ended it. Before, the rollback that followed failed with "no transaction is active", and that message replaced the real cause. If that happens while phone pairings are being copied out of a database moved aside at startup, the daemon now starts and its recovery notice says the pairings were not kept, instead of failing to start.
- bdb1d89: Install the verified daemon archive through its reviewed production dependency lock. Package the
  integrity-bearing lock under a non-special name, bind the same-release protocol archive, and use
  private staging with bundled npm 10.0.0 or newer. Materialise the lock as package-lock.json, run
  npm ci without dependency scripts, verify the physical graph and fetched-integrity records, run
  only the reviewed node-pty build, and publish a runnable receipt after verification.
  
  The bootstrap keeps one five-minute total deadline including installation, native build,
  verification, and cleanup. Existing or concurrent matching installs are verified and reused,
  never overwritten. Failure can retain a verified archive or private staging but is not reported
  as a completed installation. No provider SDK is bundled, no service starts, and PATH is unchanged.
  
  Manual npm, pnpm, or Bun adds of the daemon are not frozen. Native compilation, Node, the OS, and
  the external toolchain remain reproducibility limits. The protocol library still supports all
  three package managers independently.
- 7afb1e2: Update the Anthropic SDK to preserve native abort and timeout errors across JavaScript realms.
- 84d90d5: Persist turn ordinals and exact message links across steering, restart and transfer.
- 52f75d0: Remove the temporary transfer root a daemon created for itself. A daemon on in-memory state has no
  directory beside its state file to keep transfer packages in, so it makes one under the operating
  system temporary directory. Nothing removed it, so every such daemon left a
  `domovoi-transfer-transactions-` tree behind for the life of the machine.
  
  The daemon now records the root it created and removes it as the last step of shutdown, after the
  store and the usage ledger are closed and nothing is still writing packages into it. Removal
  retries a refusal from a transfer that just released a file, and a removal that still fails is
  reported with the rest of the shutdown failures instead of being dropped.
- eef6cea: Terminal redaction no longer leaks a value typed after an idle beat released its name. The daemon
  holds back a tail that might become a secret and releases it on a short idle beat so a prompt
  shows; a value typed after the released name went out in clear, live and in the replay a
  rejoining client is handed. The terminal redactor is still main's held-tail redactor. After an
  idle release, the line as shown stays as context until it ends: a name and separator in it, even
  one split around the beat, make what follows that name's value, and the value is shown as the
  replacement. Durable redaction is unchanged.
- 3fdab3d: Terminal output no longer reaches phones and tablets. The daemon sent every terminal's
  `terminal.output`, `terminal.ownership` and `terminal.closed` notifications to every connected
  client, so a paired phone or tablet credential, including a watching-only one, received the live
  bytes of any terminal the owner opened, although the pairing card says terminal output is not on a
  phone. Those notifications now go only to the connections that opened the terminal with
  `terminal.create` or took it with `terminal.claim`, and never to a phone, tablet or watching-only
  credential. A connection that closes leaves the terminal's audience.
- 06e19f1: A terminal's owner keeps it across a reconnect. Ownership now follows the client a direct connection authenticated as (its hello identity, or its paired device), not only the socket: when the owner reconnects, the daemon hands the terminal back at the hello and announces it with `terminal.ownership`, so it is not reaped after 30 seconds just because the terminal pane was not open, and a new connection that attaches before the old one has closed can type instead of being refused as another client. Another client is still refused, an abandoned terminal is still reaped, and relay channels stay bound to the channel that admitted them. Every move of the terminal to another connection of the same client, whether by typing, resizing, closing or reopening the pane, by the reattach at hello, or by the handoff when the holding connection closes, is announced to the terminal's audience with `terminal.ownership`, the same notice a claim sends.
- bdac41e: A connection that watches a terminal gets output still waiting in the batch either in its record or
  live, not both, including when it was already watching. Closed terminal records share one budget
  of 1,048,576 characters and at most 16 records, and the oldest are dropped first when a new one
  would not fit.
- 87b573b: Publish file-backed root credentials and local owner challenge keys only after their private
  staging bytes are synced and closed. A killed first initializer no longer leaves an empty
  authoritative file, and concurrent initializers reuse the winning credential without replacement.
  Initialization is bounded by the remaining startup deadline and requires hard-link support.
  Existing malformed files remain untouched; startup names an explicit offline quarantine remedy.
- b5b1aa9: Harden session transfers against interference and interrupted work.
  
  Promoted artifact sources are opened without following symlinks and read through
  the handle that was validated, so a file swapped after its check cannot be read
  in its place. Non-final transfer chunks must be exactly one chunk long, which
  bounds what a sender can make the journal hold.
  
  Transfers no longer block unrelated sessions, concurrent transfers no longer
  overwrite each other's state, and a move interrupted by a failed terminal
  shutdown, a crash between commit and save, or a failed journal write leaves the
  source recoverable rather than frozen or silently thawed.
- b5b1aa9: Preserve managed worktrees and durable checkpoint refs across session transfers,
  and expose sanitized target-contact evidence before an operator can recover a
  frozen source.
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
- b2e5888: Generate release SBOMs from the daemon's packed runtime lock, including non-host optional
  packages and the embedded protocol. Component SHA-512 hashes and the separate protocol
  artifact are bound to the locked archive bytes. Validate CycloneDX 1.6 offline before
  publishing checksums. Missing local license observations remain empty rather than hiding
  components; external toolchains and unfrozen manual installs remain outside this inventory.
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
- 4ddf93f: Add authenticated daemon update discovery and staging; defer activation with a policy refusal.
- d0a58b7: Make the fleet machine id contract authoritative for canonical workspace identity. `machineSchema.id` and `projectSchema.machineId` accepted any nonempty string while the fleet, credential, and pairing contracts require `machine-[0-9a-f]{32}`, so a workspace could be schema-valid while its machine could not be recorded in the fleet or used for pairing. Both fields now reuse `machineIdSchema`, and the existing snapshot refinement continues to require the project to name the workspace machine.
  
  A workspace saved with a non-canonical machine id is migrated on load rather than quarantined: the daemon replaces the legacy id with a deterministic canonical id derived from it, aligns the stored project reference, and records a system thread receipt naming both values. Sessions, approvals, artifacts, and annotations are preserved. A daemon started with a machine identity file still refuses state that names a different machine, which is unchanged behavior.
- 6832713: Refuse WSL facts on any platform but linux. A heartbeat or enrollment
  descriptor that claims a distribution for a `win32` or `darwin` daemon is
  refused as an invalid descriptor instead of being shown as a WSL machine.
- 12ca8d6: Say what `wsl.exe` could not do instead of calling it absence. `domovoid wsl
  list` and `domovoid open` now report whether WSL is not installed, the call was
  denied, it timed out, the service or distribution failed, or the answer could
  not be read, each with its remedy, instead of reporting a missing distribution
  or a missing daemon. An endpoint file that is not one a daemon published is
  refused as unreadable and nothing in it is repeated.
- 12ca8d6: Ask the distribution where a repository is before running `git` there. The
  runner that starts `git` inside a WSL distribution asks the distribution's
  own `wslpath` which Windows path the repository reads back as, so a Windows
  drive is refused wherever the distribution mounts it, not only under `/mnt`.
- 232ffe8: Bound bundle restore claim release with a quarantined cleanup lifecycle and exclude concurrent transfer member receives across daemon processes.
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
