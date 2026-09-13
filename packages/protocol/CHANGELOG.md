# @getdomovoi/protocol

## 0.1.0

### Minor Changes

- 1204d6c: Enroll fleet peers through a source-daemon-owned, authenticated exchange and refresh their reported facts with bounded heartbeats. Keep machine credentials in the OS keychain, publish pending cross-store operations honestly, and distinguish confirmed from unconfirmed remote revocation when forgetting a peer.
  
  The wire protocol moves to 0.4.0. Replace device.saveCredential and device.machineCredential with fleet.enroll and fleet.forget; fleet.list now returns the machine, pending, and unenrolled entry union. Older peers must update, but existing bound credentials and valid 0.3 workspace state are preserved without another forced pairing cycle. Enrollment does not grant a client credential for remote Use or Terminal.
  
  Keep legacy recovery rows visible beyond the 128-machine admission limit, bound wire snapshots to 512 entries, and report overflow without truncation. Local fleet-keychain recovery commands list IDs without credential bytes and remove a named local key only after the operator confirms Domovoi is stopped; remote revocation remains a separate action.
  
  Fix canonical transfer serialization of undefined optional fields, so real working-plan edits survive a machine transfer with the repository and history.
- 2adb117: Add semantic checkpoint reasons to thread and history records while preserving legacy rows with unknown reasons.
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
- e736472: Add validated durable turn ordinals and exact history links with usage coverage.
- 66ade99: Add opt-in per-file evidence with explicit unknown test links, observed Git revert targets, and commit-bound revert confirmations.
- cdf5f87: Add bounded relay admission above the frozen Noise IK codec, with strict pairing
  key schemas and an encrypted client/responder record layer in a separate subpath.
  The frozen codec entry and recorded wire fixtures stay unchanged.
- 1c67fba: Keep machine-pairing claims pending for five minutes instead of activating a remote credential
  before the source can store it. The source journals the claim and verifies durable keychain
  readback before confirming activation. Pending credentials cannot authenticate, and an abandoned
  re-pair does not revoke the previous active credential. Lost confirmation replies recover
  idempotently after restart; unconfirmed claims expire without ever granting normal authority.
  
  The wire moves to protocol 0.5.0. Update peers together before enrollment. Existing active bound
  credentials remain valid and do not need re-pairing. If an unfinished claim expires, issue a new
  code on the target and enroll again. Transport or storage ambiguity remains pending for retry.
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
- ea2b5ab: Add bounded structured working-plan state with stable steps, independent
  structure and progress revisions, approval blockers, and retained edit conflicts.
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

- 91b1e15: Accept compatible patch versions in daemon snapshots without rewriting the reported
  version. Validate bounded canonical wire versions consistently and compare major
  and minor components exactly, including values above the safe integer limit.
- 18f6543: Upgrade Zod to 4.5.2 while preserving UTF-16 string limits, persisted minute-precision timestamps, transfer manifest digests, and readable validation refusals.
- 1204d6c: Allow transfers to known eligible machines even when legacy fleet recovery rows exceed the display limit. Keep pending enrollment and forget operations masked, retain credential checks, and refuse transfers when pairing or the credential store is unavailable.
- e094929: Keep persisted provider prompt delivery records readable when Domovoi changes
  its current prompt budget while still rejecting usage above the recorded limit.
- 9387a5d: Make the protocol package installable from a registry tarball. The manifest now carries top level
  `main` and `types` so consumers on the `node10` module resolution can find the declarations, a
  `default` export condition so CommonJS and non `import` resolvers reach the same entry, a
  `./package.json` subpath, `sideEffects: false`, and the `keywords` and `bugs` metadata a registry
  listing needs. A `prepack` script builds `dist` before packing, so a tarball can no longer be
  produced without the files its manifest points at.
- 584e7d9: Derive runtime build versions from release metadata. Fleet facts, daemon and client greetings,
  and provider initialization report the running release instead of a fixed development version.
  Production startup refreshes the persisted local version without changing machine identity.
  Wire protocol compatibility and existing pairings are unchanged.
- ee3fe90: Add separate, kind-bound remote client grants and Fleet client admission. A machine pairing remains daemon-to-daemon authority, not permission for a desktop or browser to control the target.
  
  Operators issue a separate client credential on the target with `domovoid pair --client desktop --label "My desktop"`, then choose Authorize this client in Fleet. Use, Terminal and inventory reads require the target identity and client receipt to verify. Desktop main verifies each enrolled route through the home daemon and grants only that exact socket origin. Update both daemons and the client before using these additive calls. The wire remains 0.5.0, existing pairings remain valid and no re-pair is required.
  
  Client credentials stay only in app memory. Closing the app or removing local access does not revoke the remote grant; revoke the device in the target's Devices list. Remote Desktop preview frames remain unavailable until they have a separate verified path. This does not enable a hosted relay or expose the daemon's machine keychain to the client.
  
  Desktop serves its bundle from an explicit app origin so response CSP is enforced. Existing development profiles may need appearance, layout and first-run preferences selected again because old file-origin browser storage is not migrated. The daemon profile and its canonical sessions are unchanged.
  
  If `DOMOVOI_ALLOWED_ORIGINS` is explicitly configured, add the exact `domovoi-app://desktop` origin and restart that daemon. The default configuration already includes it; custom lists are not silently widened.
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
- 6832713: Refuse WSL facts on any platform but linux. A heartbeat or enrollment
  descriptor that claims a distribution for a `win32` or `darwin` daemon is
  refused as an invalid descriptor instead of being shown as a WSL machine.
