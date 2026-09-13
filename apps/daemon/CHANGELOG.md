# @getdomovoi/daemon

## 0.1.0

### Minor Changes

- 1204d6c: Enroll fleet peers through a source-daemon-owned, authenticated exchange and refresh their reported facts with bounded heartbeats. Keep machine credentials in the OS keychain, publish pending cross-store operations honestly, and distinguish confirmed from unconfirmed remote revocation when forgetting a peer.
  
  The wire protocol moves to 0.4.0. Replace device.saveCredential and device.machineCredential with fleet.enroll and fleet.forget; fleet.list now returns the machine, pending, and unenrolled entry union. Older peers must update, but existing bound credentials and valid 0.3 workspace state are preserved without another forced pairing cycle. Enrollment does not grant a client credential for remote Use or Terminal.
  
  Keep legacy recovery rows visible beyond the 128-machine admission limit, bound wire snapshots to 512 entries, and report overflow without truncation. Local fleet-keychain recovery commands list IDs without credential bytes and remove a named local key only after the operator confirms Domovoi is stopped; remote revocation remains a separate action.
  
  Fix canonical transfer serialization of undefined optional fields, so real working-plan edits survive a machine transfer with the repository and history.
- 1524651: Add explicit TLS tailnet advertisements and source-local configured SSH-forward routes. Services retain both settings. Machine authentication, route deadlines and forget masking still apply; removing SSH configuration removes that fallback after restart. Domovoi does not start SSH tunnels or add WSL or relay transports.
  
  Loopback advertisements now reflect whether the listener uses TLS. Peers cannot enable a source-local route through their own SSH or loopback advertisements, including TLS loopback URLs.
- 707e0ab: Persist current context occupancy reported by Claude, Codex, and ACP providers,
  and expose it only while its provider runtime and thread remain active.
- bb0bdf5: Classify a turn that outgrows the model context window as
  `context-window-exceeded` rather than a retryable rate limit or unknown failure,
  and keep a usage limit written with the words spelled out classified as a rate
  limit.
- 9dc6a6f: Replace the public raw daemon constructor with `createProductionDaemon`. The
  factory always installs a durable root credential and machine identity,
  provider discovery, the peer-credential store, persistent state, and configured
  transport protection, so shipped entry points cannot omit production
  dependencies that tests inject.
  
  This is a breaking embedding API change. Consumers must await the factory and
  use its returned handle. The `@getdomovoi/daemon/internal` package path remains
  present for artifact compatibility but no longer exports the raw constructor.
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
- a4200fb: Add `domovoid service install`, `status`, and `remove`. The systemd user unit,
  launchd agent, and Windows logon task generators now ship inside the package
  instead of living as repository scripts no shipped command could reach.
- d4228ee: Bind project standing approvals to versioned, server-resolved execution digests.
  Legacy text-only rules remain visible but inactive until explicitly reapproved,
  and package-script changes invalidate pending or reusable approvals.
- cbf620b: Persist structured working plans from Codex, Claude, and ACP providers, apply
  attributed human edits at turn boundaries, and track approval blockers without
  discarding queued or conflicted drafts across session lifecycle changes.
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
- 66ade99: Add opt-in per-file evidence with explicit unknown test links, observed Git revert targets, and commit-bound revert confirmations.
- 1c67fba: Keep machine-pairing claims pending for five minutes instead of activating a remote credential
  before the source can store it. The source journals the claim and verifies durable keychain
  readback before confirming activation. Pending credentials cannot authenticate, and an abandoned
  re-pair does not revoke the previous active credential. Lost confirmation replies recover
  idempotently after restart; unconfirmed claims expire without ever granting normal authority.
  
  The wire moves to protocol 0.5.0. Update peers together before enrollment. Existing active bound
  credentials remain valid and do not need re-pairing. If an unfinished claim expires, issue a new
  code on the target and enroll again. Transport or storage ambiguity remains pending for retry.
- 5a33539: Carry a `protocol-mismatch` payload on every `protocolVersionMismatchErrorCode`
  (`-32012`) refusal: the refusing daemon's protocol version, the client's, and the
  `protocolCompatibility` result between them, validated by `protocolMismatchSchema`.
  `system.hello` and `device.claim` send it with their sentence unchanged. The fleet
  dialer reads the peer's version from the payload and falls back to the sentence
  only for a daemon that predates it, and the phone names both versions from the
  payload with the same fallback.
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
- f9cf76b: Record a session-start checkpoint at worktree creation and expose semantic reasons for every new checkpoint in paged history.
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
- a6d18ac: Split Codex reasoning output from visible output tokens so usage totals preserve
  the provider-reported total without dropping or double-counting reasoning.
- f058294: Grade a fleet peer that refuses this daemon's protocol by which side is behind.
  The dialer reads the peer's version out of its refusal, and the heartbeat
  records `upgrade-required` when the peer is the older side and
  `version-mismatch` when it is the newer one, where it recorded
  `version-mismatch` for both. A refusal that names no version is graded by the
  version the peer last advertised.
- c746eab: Publish a machine identity without replacing one won by an overlapping daemon
  start, so every concurrent start adopts the same durable machine ID.
- 6f52997: Keep project standing approvals in Domovoi and grant providers one command at a time.
- 51a7431: Refuse corrupt WSL listings instead of reporting missing distributions. Discovery requires a
  valid header and every nonblank row to parse, with no partial results. Both `domovoid wsl list`
  and `domovoid open` report the corrupt classification and a diagnostic command to run, without
  repeating unreadable row contents. Header-only listings and explicit absence answers still work.
- df4716f: Bound pairing claims per source and listener without resetting on reconnect, and keep rejected pre-authentication traffic in a separate audit retention budget so it cannot evict operator decisions. Throttled claims do not consume a valid pairing code. Existing history remains readable.
- 91b1e15: Accept compatible patch versions in daemon snapshots without rewriting the reported
  version. Validate bounded canonical wire versions consistently and compare major
  and minor components exactly, including values above the safe integer limit.
- 18f6543: Upgrade Zod to 4.5.2 while preserving UTF-16 string limits, persisted minute-precision timestamps, transfer manifest digests, and readable validation refusals.
- ca22e9e: Reserve time for fallback routes inside one overall fleet dial deadline. Each eligible route gets
  a share of the remaining time for connection and authenticated hello, so a silent first endpoint
  cannot consume every later route's allowance. Cancel abandoned attempts, reject late results, and
  retain typed timeout refusals naming a sanitized address instead of arbitrary transport error text.
- 9e1e9c5: Keep healthy fleet machines readable when another stored machine row is malformed. Retain the damaged row in quarantine with an atomic, sanitized audit receipt, and exclude it from dialing and heartbeat updates.
  
  Add opt-in quarantine diagnostics to `fleet.list` with typed operator remedies. Existing list calls, lifecycle replies, and notifications retain their wire shape. UI rendering is unchanged. Forget or explicitly enroll a peer again when its identity is valid; invalid identities require offline registry repair.
- 4359bcf: Fix provider usage accounting and persist dispatch attribution, deduplication and coverage across restart and transfer.
  
  Versioned transfers use contract v2 to carry portable accounting. Both endpoints must support v2; strict v1 receivers cannot parse the added evidence.
- 6b30c51: Reject overlapping bundle restores before repository inspection or fetch, including independent
  service instances sharing a worktree root. Keep later incremental restores and concurrent restores
  of different sessions working. Release owned filesystem claims on normal completion, failure and
  cancellation; report a claim left by a killed process for explicit recovery with Domovoi stopped.
- 1204d6c: Allow transfers to known eligible machines even when legacy fleet recovery rows exceed the display limit. Keep pending enrollment and forget operations masked, retain credential checks, and refuse transfers when pairing or the credential store is unavailable.
- 3e2c556: Report a machine that ran out of time as an unreachable owner rather than an invalid profile.
  Acquiring the local daemon recognised an expired budget only when the deadline error was the one
  thrown. A startup step that bounds itself reports its own expiry and carries the deadline as a
  cause, so credential initialization timing out was classified as `profile-invalid`, and the
  refusal told the person to inspect their owner record, private key and credential file. Nothing
  was wrong with any of them; the machine was slow.
  
  The classification now looks through the wrapper, including the aggregate a step raises when its
  cleanup also failed, and answers `owner-unreachable`, which says to wait for the daemon or start
  it explicitly. A genuinely damaged profile still reports `profile-invalid`.
- 7bc1d86: Release one-shot CLI connections after a complete reply as well as after a refusal.
  A peer that withholds its close acknowledgement can no longer keep an answered
  `domovoid pair` or `domovoid open` process waiting outside the command deadline.
  No configuration changes or re-pairing are required.
- 1fadaa1: Retain exact reviewed skill text by digest with bounded on-demand retrieval, report missing revisions as unavailable, and validate versioned declared scopes before approval or prompt delivery.
- 71efbdd: Recover a profile after verified service removal using an owner-only receipt bound to the exact
  stopped instance and installation registration. New service installations carry that registration;
  older saved configurations remain readable but need reinstalling to gain automatic removal proof.
  
  For legacy or custom supervisors, `domovoid profile recover --confirm-no-supervisor` records the
  operator's explicit assertion that no supervisor will restart the daemon. It refuses a live owner,
  does not start a daemon, and does not treat missing configuration or elapsed time as shutdown proof.
- 9387a5d: Make the protocol package installable from a registry tarball. The manifest now carries top level
  `main` and `types` so consumers on the `node10` module resolution can find the declarations, a
  `default` export condition so CommonJS and non `import` resolvers reach the same entry, a
  `./package.json` subpath, `sideEffects: false`, and the `keywords` and `bugs` metadata a registry
  listing needs. A `prepack` script builds `dist` before packing, so a tarball can no longer be
  produced without the files its manifest points at.
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
- 8e3a45f: Recover abandoned transfer restore claims only after the owner has exited and
  every Git command has a recorded, uninterrupted settlement. Preserve claims when
  descendant liveness is unknown, including after command cancellation or a missing
  exit record. Keep exclusion through command close and delayed claim cleanup;
  refuse legacy or incomplete ownership records explicitly.
- 584e7d9: Derive runtime build versions from release metadata. Fleet facts, daemon and client greetings,
  and provider initialization report the running release instead of a fixed development version.
  Production startup refreshes the persisted local version without changing machine identity.
  Wire protocol compatibility and existing pairings are unchanged.
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
- 90a3111: Report service runtime state on macOS and Windows. Distinguish a loaded launch agent from a running process, and read numeric Task Scheduler state instead of localized status text.
- 6b30c51: Attempt restore-claim close and removal independently, always clearing the process-local reservation. Verify a unique ownership token before removing a claim, preserving an observed replacement and naming its ownership change. Report cleanup failures with the claim path while preserving the original restore failure. If restoration already completed, explicitly warn against retrying it. Manual claim removal still requires stopped daemons because token verification and unlink are not atomic.
- f15b01b: Build node-pty from source during verified bootstrap installation on musl or unknown Linux libc instead of choosing its libc-unqualified prebuild. Check native module loading before publishing an installation and on receipt reuse, within the existing five-minute deadline. An unusable existing runtime is refused with a path and remedy, never replaced automatically.
  
  The pinned Node 22 Alpine smoke installs the real archive, opens a PTY, and authenticates against the production daemon. Python, make, a C++ compiler, platform headers, and registry access remain required. Manual package-manager installs do not apply the bootstrap policy; native compilation and the external toolchain are not frozen by the runtime lock.
- ee3fe90: Add separate, kind-bound remote client grants and Fleet client admission. A machine pairing remains daemon-to-daemon authority, not permission for a desktop or browser to control the target.
  
  Operators issue a separate client credential on the target with `domovoid pair --client desktop --label "My desktop"`, then choose Authorize this client in Fleet. Use, Terminal and inventory reads require the target identity and client receipt to verify. Desktop main verifies each enrolled route through the home daemon and grants only that exact socket origin. Update both daemons and the client before using these additive calls. The wire remains 0.5.0, existing pairings remain valid and no re-pair is required.
  
  Client credentials stay only in app memory. Closing the app or removing local access does not revoke the remote grant; revoke the device in the target's Devices list. Remote Desktop preview frames remain unavailable until they have a separate verified path. This does not enable a hosted relay or expose the daemon's machine keychain to the client.
  
  Desktop serves its bundle from an explicit app origin so response CSP is enforced. Existing development profiles may need appearance, layout and first-run preferences selected again because old file-origin browser storage is not migrated. The daemon profile and its canonical sessions are unchanged.
  
  If `DOMOVOI_ALLOWED_ORIGINS` is explicitly configured, add the exact `domovoi-app://desktop` origin and restart that daemon. The default configuration already includes it; custom lists are not silently widened.
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
- Updated dependencies [1204d6c]
- Updated dependencies [b5b1aa9]
- Updated dependencies [e736472]
- Updated dependencies [66ade99]
- Updated dependencies [cdf5f87]
- Updated dependencies [1c67fba]
- Updated dependencies [e094929]
- Updated dependencies [20e7e91]
- Updated dependencies [9048458]
- Updated dependencies [5a33539]
- Updated dependencies [fb78eda]
- Updated dependencies [9387a5d]
- Updated dependencies [c3e566a]
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
