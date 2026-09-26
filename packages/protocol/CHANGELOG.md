# @getdomovoi/protocol

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
- 2adb117: Add semantic checkpoint reasons to thread and history records while preserving legacy rows with unknown reasons.
- 4cacf7a: Show Codex OAuth 5-hour and weekly usage windows using provider-reported
  percentages and reset times. Providers that do not report quota windows keep
  the explicit unavailable state.
- d4228ee: Bind project standing approvals to versioned, server-resolved execution digests.
  Legacy text-only rules remain visible but inactive until explicitly reapproved,
  and package-script changes invalidate pending or reusable approvals.
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
- 9e1e9c5: Keep healthy fleet machines readable when another stored machine row is malformed. Retain the damaged row in quarantine with an atomic, sanitized audit receipt, and exclude it from dialing and heartbeat updates.
  
  Add opt-in quarantine diagnostics to `fleet.list` with typed operator remedies. Existing list calls, lifecycle replies, and notifications retain their wire shape. UI rendering is unchanged. Forget or explicitly enroll a peer again when its identity is valid; invalid identities require offline registry repair.
- c32065a: Expose the frozen suite-A Noise IK codec at `@getdomovoi/protocol/relay`. Keep the Node crypto oracle test-only and remove alternate-suite implementations. External composition review and relay admission integration remain pending.
- 4359bcf: Fix provider usage accounting and persist dispatch attribution, deduplication and coverage across restart and transfer.
  
  Versioned transfers use contract v2 to carry portable accounting. Both endpoints must support v2; strict v1 receivers cannot parse the added evidence.
- 9d94da3: Add retained rule revocation, persisted use counts and renderable hard-gate categories for the Rules tab.
  
  The wire protocol moves to 0.7.0. Update clients and daemons together: a peer on another minor version is refused at `system.hello` with `-32012`.
- c3229d9: `device.issueCode` answers with the address a device dials to spend the code, as
  `pairingAddress`: `{ url, label?, loopback }`, the name on the certificate the daemon serves and
  never the address it binds, or `{ problem }` when there is nothing a device could verify (no
  certificate on a non-loopback listener, an unreadable certificate, a certificate naming no host or
  several). The desktop pairing card, the web connect page and `domovoid pair` draw the same address
  from this one answer; the command line no longer works it out on its own.
- b67435e: Recover saved client relay pins through externally signed daemon channel-key rotation and durable successor adoption.
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
- fe7968f: Pairing by camera. The protocol gains `pairingPayloadSchema` and its
  encoder and decoder: the text a pairing QR carries, a daemon address (TLS,
  or plaintext on loopback only) and a client credential. The phone gains
  `expo-camera` and a Scan a pairing code screen that reads it, names the
  machine, asks once and connects; a refused camera pastes the same text.
- d5bdbe6: Each model says whether it takes image input. `runtime.models` entries carry `imageInput`,
  `true` when an image attachment on a send to that model is delivered and `false` when it is not;
  the daemon fills it from the same rule the send uses, the adapter's vision capability. A send with
  images to a model that takes none is still refused whole. The error message now names the model
  and the image count, and the error data keeps the shape released clients parse. The attach sheet's
  code is the exported constant `modelImageInputRefusalCode`.
- 0c88e11: Send up to two bounded PNG or JPEG images with a session prompt. Refuse image sends when the adapter lacks vision support; keep uploads out of daemon persistence. Raise bounded authenticated RPC messages to carry both images over direct and encrypted transports. Advertise optional sessionImageAttachments support in system.hello so clients can refuse image sends to older daemons.
- e736472: Add validated durable turn ordinals and exact history links with usage coverage.
- 66ade99: Add opt-in per-file evidence with explicit unknown test links, observed Git revert targets, and commit-bound revert confirmations.
- cdf5f87: Add bounded relay admission above the frozen Noise IK codec, with strict pairing
  key schemas and an encrypted client/responder record layer in a separate subpath.
  The frozen codec entry and recorded wire fixtures stay unchanged.
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
- 20e7e91: Add a `context-window-exceeded` provider failure with a `shorten-context` action.
  A turn that outgrows the model context window is not retryable, so it no longer
  falls through to the retryable unknown failure, and the client tells a person to
  shorten the turn or start from a checkpoint instead of offering a retry.
- 9048458: Let `session.usage` carry context occupancy. `contextTokens` and
  `contextWindowTokens` are both optional, and occupancy is rejected without the
  window it was measured against, so a client can show a context readout only when
  the provider reported both numbers.
- 5a33539: Carry a `protocol-mismatch` payload on every `protocolVersionMismatchErrorCode`
  (`-32012`) refusal: the refusing daemon's protocol version, the client's, and the
  `protocolCompatibility` result between them, validated by `protocolMismatchSchema`.
  `system.hello` and `device.claim` send it with their sentence unchanged. The fleet
  dialer reads the peer's version from the payload and falls back to the sentence
  only for a daemon that predates it, and the phone names both versions from the
  payload with the same fallback.
- fb78eda: Add `usage.window`, a read-only total of tokens, provider-reported cost, turns,
  and sessions recorded on one daemon between two instants. The window is half
  open, must end after it starts, and carries no per-session breakdown.
- c3e566a: Add versioned declared skill scopes and bounded retrieval of exact reviewed revisions. Preserve unknown legacy scopes and unavailable revision evidence.
- 2b21f85: Add runtime-validated daemon update metadata and RPC contracts.
- ef58e04: Deliver signed relay successors before admission and return complete identity pins during opt-in pairing.
- cad2971: Define validated relay carrier greetings, public recovery delivery records, and bounded multiplexed frames outside the frozen endpoint codec.
- fdc96ec: `session.send` accepts text files and worktree file paths as attachments beside images, at most two in total. Text files are written into the session worktree for the agent to read; worktree paths must stay inside the worktree. New refusal reasons: `invalid-text` and `invalid-workspace-file`.
- 0b59f4f: `session.search { query, limit? }` searches a daemon's sessions by title and by summary, the
  newest assistant message the daemon holds for the session, case-insensitively, and answers
  `{ query, matches: [{ session, matchedIn: "title" | "summary" }], truncated }` without a whole
  snapshot. It is read-only and unaudited, like `session.history`. A desktop or web client fans it
  out per admitted machine for the palette's "Sessions on other machines"; each machine answers
  for itself, so a machine that did not answer stays "not searched" rather than "no match".
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
- 7e30caa: Stored state that cannot be read is no longer moved aside silently. The daemon records a `state.quarantine` audit receipt naming the kept file, logs it, and returns an optional `stateRecovery` field on every client `system.hello` result until it restarts. A database moved aside whole, including one where `PRAGMA quick_check` finds damage in a table other than the workspace, keeps its workspace snapshot and paired devices when they still read and validate. Paired devices receive only whether a recovery happened and what was kept, not the path or the failure text. State written by a newer protocol minor is read through a read-only connection, left byte for byte in place, and startup fails with a message naming the file and both versions, so going back to an older build no longer resets the newer build's workspace.
- ea2b5ab: Add bounded structured working-plan state with stable steps, independent
  structure and progress revisions, approval blockers, and retained edit conflicts.
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
- d0a58b7: Make the fleet machine id contract authoritative for canonical workspace identity. `machineSchema.id` and `projectSchema.machineId` accepted any nonempty string while the fleet, credential, and pairing contracts require `machine-[0-9a-f]{32}`, so a workspace could be schema-valid while its machine could not be recorded in the fleet or used for pairing. Both fields now reuse `machineIdSchema`, and the existing snapshot refinement continues to require the project to name the workspace machine.
  
  A workspace saved with a non-canonical machine id is migrated on load rather than quarantined: the daemon replaces the legacy id with a deterministic canonical id derived from it, aligns the stored project reference, and records a system thread receipt naming both values. Sessions, approvals, artifacts, and annotations are preserved. A daemon started with a machine identity file still refuses state that names a different machine, which is unchanged behavior.
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
- 711bee5: Settings opens with Daemon on this machine: whether this app, the installed login service or another window holds it, what quitting does, and what installing the service writes on this platform. Install and Remove are drawn locked with the command that does the job beside them.
- b7f7c95: The switch to or from the login service is now held by the daemon itself. `system.serviceHandoffFence` (loopback, daemon credential only) answers the same refusal as the window's check, or, when nothing runs, no dispatch is in flight and no gate waits, admits no new turn until the connection that took it closes. The desktop takes it right before it stops the daemon inside the app or removes the service, so a turn that starts after the first check makes the switch wait instead of being stopped.
  
  Staging the shipped runtime refuses an app version that is not one release version, a `~/.domovoi` or `~/.domovoi/runtime` that is a link, a shipped part that is not a regular file, and a link that leads outside the shipped runtime, all before any byte is copied. Links inside the runtime are copied as they are. An earlier copy of the same version is moved aside and put back if the new copy cannot be renamed into place.
  
  After a failed install or removal the desktop reads the service back and reports it, along with the daemon it reaches afterwards, including one this app did not start. Settings no longer says nothing was installed or removed unless the read-back shows it.
- 279349c: The desktop can install the daemon as a login service from Settings and remove it again. The app copies the runtime it ships under the profile, asks the daemon's own installer to register the service pointing at that copy, and only then stops its in-app daemon and attaches to the service. The switch refuses while a turn runs or a gate waits and names the sessions; a runtime the app does not ship is reported without touching anything.
  
  Install and Remove both wait while a turn runs or a gate waits. The desktop main process checks this too, before anything is stopped: it reads the workspace from its own daemon (`readLocalServiceHandoffRefusal` in `@getdomovoi/daemon`) and applies the same check the window uses (`serviceHandoffRefusal` in `@getdomovoi/protocol`). A workspace it cannot read also makes the switch wait. While the service takes over the profile or gives it back, a window reconnect waits for the handoff instead of starting a daemon inside the app. The runtime copy is made in a fresh directory and renamed into place, so no file from an earlier copy of the same version survives. Settings says when the service was installed but this window could not reach it, when the daemon inside the app stopped and did not start again, and what to run when a removal leaves the profile owner unresolved. A daemon running outside the app is drawn as the installed service, with Remove available, only when the desktop reads the service as installed from the service manager.
- 91b1e15: Accept compatible patch versions in daemon snapshots without rewriting the reported
  version. Validate bounded canonical wire versions consistently and compare major
  and minor components exactly, including values above the safe integer limit.
- 18f6543: Upgrade Zod to 4.5.2 while preserving UTF-16 string limits, persisted minute-precision timestamps, transfer manifest digests, and readable validation refusals.
- 6b0e4fd: The daemon reads the web app a pairing code can be opened in from `DOMOVOI_WEB_APP_URL`, or `webAppUrl` in the service configuration file. It must be an absolute `http` or `https` URL without whitespace, control characters, credentials or a fragment, at most 2048 characters; the daemon refuses to start with anything else and does not echo the value. An invalid saved `webAppUrl`, including one that is not a string, fails as a `DaemonConfigurationError`, both when the configuration is parsed and when the service loads the file. When it is set, `device.issueCode` returns it as `webAppUrl` beside `pairingAddress`; when it is unset, the result has no `webAppUrl`. The protocol validates the field with `webAppUrlSchema`.
- 64e9c45: Offer the ride back whenever a thread sits away from its bottom. A streaming
  reply grows one row rather than adding rows, so the unseen count can stay at
  zero while the thread keeps moving, and the pill used to stay hidden. The
  count is still the label when there is one.
- 1204d6c: Allow transfers to known eligible machines even when legacy fleet recovery rows exceed the display limit. Keep pending enrollment and forget operations masked, retain credential checks, and refuse transfers when pairing or the credential store is unavailable.
- 5ae04b0: When every harness is missing, Start a session shows a search report instead of a status list: what the daemon looked for, the PATH it searched, and that finding nothing there is not proof nothing is installed. The daemon reports the searched PATH on the machine (machine.toolPath), and a missing harness reads Not found rather than Not installed everywhere.
- a5f0f7e: The phone's thread follows a reply only when the person is already at the bottom. Scrolled up
  to read an earlier turn, the viewport holds still while new output lands, and a pill above the
  composer offers the ride back: "3 new" with a primary dot, or "Waiting on you" on the warning
  ramp with a pulsing dot when a decision arrived below. 44px tall for a thumb. Before, every
  growth of the thread scrolled to the end regardless of where the person was.
  
  `threadFollowState` and `threadFollowPillText` live in `@getdomovoi/protocol` so every surface
  with a thread derives the same three states.
- 59b1a7a: `modelDisplayName(modelId, harnessId)` derives a model's short name from its id: drop every
  token the harness name already says, then replace hyphens with spaces. `claude-sonnet-4.6` under
  `claude-code` reads `sonnet 4.6`; `gpt-5.3-codex` under `codex` reads `gpt 5.3`. A model that
  arrives from `runtime.discover` needs no second name written for it.
  
  The desktop and web model chip now reads `<harness> · <short name>`, and each row in the model
  list shows the short name with the full id in mono beside it, because the id is what the audit
  log and the provider's error say. A harness that did not report is absent from the filter row and
  the list rather than greyed; one the snapshot called missing appears once discovery hears models
  from it. The count line reads how many harnesses reported.
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
- 45e152d: Settings gains Phone and tablet: a pairing card that shows the daemon's own pairing code for a phone, tablet or browser, with its QR, address and 180 second countdown, and says why no code can be shown when the daemon answers on loopback only or reports no certificate. The shared list of what a paired device can do now carries six lines, including that gates reach a device only while its app is open, and the terminal line is the short one.
- 7bea6a9: Report a touched file path exactly as the provider named it. A leading or trailing space is a legal character in a path name, so the previous trim could name a file the provider never did and could fold two distinct paths into one, making the file count wrong. Whitespace alone is still rejected.
  
  Show a refused plan reply. Accepting a plan written as prose now surfaces the failure next to the button instead of returning it to its resting label in silence, and the branch no longer invites a line comment it cannot take.
- e094929: Keep persisted provider prompt delivery records readable when Domovoi changes
  its current prompt budget while still rejecting usage above the recorded limit.
- 9387a5d: Make the protocol package installable from a registry tarball. The manifest now carries top level
  `main` and `types` so consumers on the `node10` module resolution can find the declarations, a
  `default` export condition so CommonJS and non `import` resolvers reach the same entry, a
  `./package.json` subpath, `sideEffects: false`, and the `keywords` and `bugs` metadata a registry
  listing needs. A `prepack` script builds `dist` before packing, so a tarball can no longer be
  produced without the files its manifest points at.
- 9c12124: `device.redeemCode` validates `protocolVersion` with the shared protocol version schema, like every other version reader. A noncanonical or overlong version (such as `01.8.0`) is now refused as invalid params with the request's id, instead of passing validation and failing inside the compatibility check as an internal error with `id: null`.
- 8523d3d: Validate public relay identity pins and identity-signed channel successors without changing the frozen Noise codec.
- d5a77a5: Remove exports nothing outside the protocol's own tests used: `planTransfer`, `TransferPlan`, `transferStepSchema` and `TransferStep` (sessions move through the `transfer.*` RPCs), `selectTransport` and `TransportSelection` (dialers use `usableTransports`), and the aliases `maximumClientSnapshotThreadItems`, `maximumRenderedThreadItems` and `machineCredentialSchema`. No wire member changes. The transport tests now assert the same behaviour through `usableTransports`.
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
- ee3fe90: Add separate, kind-bound remote client grants and Fleet client admission. A machine pairing remains daemon-to-daemon authority, not permission for a desktop or browser to control the target.
  
  Operators issue a separate client credential on the target with `domovoid pair --client desktop --label "My desktop"`, then choose Authorize this client in Fleet. Use, Terminal and inventory reads require the target identity and client receipt to verify. Desktop main verifies each enrolled route through the home daemon and grants only that exact socket origin. Update both daemons and the client before using these additive calls. The wire remains 0.5.0, existing pairings remain valid and no re-pair is required.
  
  Client credentials stay only in app memory. Closing the app or removing local access does not revoke the remote grant; revoke the device in the target's Devices list. Remote Desktop preview frames remain unavailable until they have a separate verified path. This does not enable a hosted relay or expose the daemon's machine keychain to the client.
  
  Desktop serves its bundle from an explicit app origin so response CSP is enforced. Existing development profiles may need appearance, layout and first-run preferences selected again because old file-origin browser storage is not migrated. The daemon profile and its canonical sessions are unchanged.
  
  If `DOMOVOI_ALLOWED_ORIGINS` is explicitly configured, add the exact `domovoi-app://desktop` origin and restart that daemon. The default configuration already includes it; custom lists are not silently widened.
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
- fa621d6: Name the workspace delta batch delay as a performance budget. Terminal output already had a published batch delay, but assistant text deltas had none, so any batching interval would have been a bare number inside the daemon. The budget file now carries `workspaceDelta.batchDelayMilliseconds` and the protocol package exports it as `workspaceDeltaBatchDelayMilliseconds`, so the interval is visible to `pnpm performance:budget` and to every client that needs to reason about it. A test pins the value and pins it at or above the terminal output delay.
- 6832713: Refuse WSL facts on any platform but linux. A heartbeat or enrollment
  descriptor that claims a distribution for a `win32` or `darwin` daemon is
  refused as an invalid descriptor instead of being shown as a WSL machine.
