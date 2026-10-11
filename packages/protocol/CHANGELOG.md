# @getdomovoi/protocol

## 0.1.0-alpha.0

### Minor Changes

- 309562f: Add the `approval-answered-elsewhere` provider failure (action `review-changes`, not
  retryable). A daemon sets it when a provider server reports an approval reply the daemon
  did not send and the daemon stopped the session for it. The approved call may already
  have run, so a client tells the person to review the session's changes rather than retry.
  `ProviderFailure` is now a named type so declaration output stays within what the
  compiler will serialize.
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
- 6b2324b: Approval cards carry optional attribution for the client that started their turn and a realpath-aware outside-project fact relative to the session worktree. Each containment value names its path or working-directory basis; working-directory containment does not restrict a command's reach. Working-directory facts require a directory reported for that specific command. Reloaded cards omit working-directory containment because their saved directory is display text, not the original request evidence. Unknown facts stay absent, including on older saved cards, and phone and tablet snapshots retain the facts.
  
  Export `approvalPlanStep` to derive a current 1-based step and total from the session plan's approval blocker without storing a stale step number on the card.
- df3452f: A checkpoint the daemon takes before an allowed command now says why. `checkpointReasonSchema`
  adds `before-approved-command`, and the daemon sets it on the checkpoint it records when a person
  allows a gated command. The thread item and its session history entry carry it, so a client can
  name the reason beside the time instead of showing only the time. Checkpoints recorded before
  this change carry no reason, as before. The desktop checkpoints list reads it as "before an
  approved command".
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
- 68833ac: A message without a `review` sends no comment. Ruling Q402: the legacy default that attached every
  open comment of the session to a `session.send` carrying no `review` is removed before protocol
  0.8.0 ships. On the wire, `session.send` without `review` now composes the same provider prompt
  as `review: { annotationIds: [] }`: no comment, no build basis, and a handoff context that lists
  no open annotation. The daemon never fills in a review; the only comments that reach the agent are
  the ones the message names. `review` stays optional rather than required, so a daemon cannot
  invent one and a client built before the field keeps sending words; such a client loses the
  comments it never named.
  
  Every client now states its review. Desktop and web (`packages/ui`) and the phone and tablet
  (`apps/mobile`) list a session's comments as open without yet offering the drawn choice of which
  to send, so a send names every open comment of that session, read from the latest snapshot at the
  moment of sending: `openCommentReviewFor` in `@getdomovoi/protocol` keeps the newest up to the 20
  a message may carry, the order the daemon delivered under the old default, and names no build
  basis. When more comments are open than that, the review also carries `omittedOverLimit`, the
  count of older open comments it left out. The wire accepts the count only on a full review, as a
  positive whole number up to 1,000,000. The daemon records it in the sent message's
  `providerPromptDelivery.annotations` (`availableCount` and `omitted.limit`) and tells the agent
  the count, but composes only the comments the review names; the count never selects a comment. A
  queued message keeps the count until release. Desktop and web show the record with the existing
  delivery note line, and the phone and tablet show the same sentence under the sent message, so a comment
  that missed the turn stays visible after the send succeeds. The sentence is
  `annotationsOverLimitLine` in `@getdomovoi/protocol`, the one copy every surface and the History
  tab read; the History tab's `annotationsOverLimit` carries the same `omitted.limit` count, so it
  includes the count a review reported. A message that starts a session the
  client just created, and a `DomovoiClient.sendMessage` given no review, send `{ annotationIds: [] }` explicitly rather than leaving the field out. The
  chosen preview stays a viewer bookmark until the dock sends it (ruling Q342 A). The command line
  sends no message.
  
  A queued message persisted before this change with no review is released as it was queued and
  sends no comment.
  
  An annotation ID is now at most 256 UTF-16 code units, the same bound a send's review uses for
  the IDs it names (ruling Q432 A), so every open comment can be named in a review. A longer ID is
  refused where it enters, for example a session transfer import. The delivery record keeps a
  comment's ID exactly as stored.
- a894fcb: Preview comments can now be sent explicitly. `session.send` takes an optional `review`: the ids
  of the open comments this message sends (at most 20) and, as `buildBasis`, the preview the person
  chose for the agent to build on. A message that carries a review delivers only the comments it
  names, so a half-written comment does not steer that turn. `review: { annotationIds: [] }` is
  the explicit send of nothing: no comment and no build basis. The review is checked when the message
  is sent, when it is queued and when a queued message is released: a comment that is not open on
  the session, or a build basis that is not one of its previews, refuses the whole message rather
  than sending less than the person chose. The refusal carries error data
  `{ kind: "session-review-refused", reason: "comment-unavailable" | "build-basis-unavailable" }`,
  so a queued message that meets it at release is refused, as attachment and skill faults are. Only the named comments' crops are read. The build basis
  is never dropped for the payload budget; comments still are, oldest first, as before. A turn's
  delivery record names the build basis it carried. A queued message keeps its review across a
  restart.
  
  Ruling Q402: a message without a review sends no comment and no build basis. A legacy default
  that attached every open comment of the session to such a message was carried for one
  pre-release step and removed before protocol 0.8.0 shipped; the release note "A message without
  a `review` sends no comment" describes what every client now sends. Phone and tablet keep the
  same methods: `review` rides on `session.send`, which they already hold. The first message after
  a cross-provider handoff follows the same rule: the handoff context carries no current comment,
  and only the review's comments reach the provider.
- 9e1e9c5: Keep healthy fleet machines readable when another stored machine row is malformed. Retain the damaged row in quarantine with an atomic, sanitized audit receipt, and exclude it from dialing and heartbeat updates.
  
  Add opt-in quarantine diagnostics to `fleet.list` with typed operator remedies. Existing list calls, lifecycle replies, and notifications retain their wire shape. UI rendering is unchanged. Forget or explicitly enroll a peer again when its identity is valid; invalid identities require offline registry repair.
- c32065a: Expose the frozen suite-A Noise IK codec at `@getdomovoi/protocol/relay`. Keep the Node crypto oracle test-only and remove alternate-suite implementations. External composition review and relay admission integration remain pending.
- 4359bcf: Fix provider usage accounting and persist dispatch attribution, deduplication and coverage across restart and transfer.
  
  Versioned transfers use contract v2 to carry portable accounting. Both endpoints must support v2; strict v1 receivers cannot parse the added evidence.
- 8871313: A `tool.inventory` git filter entry carries `commandInexact: true` exactly when its `command` is not the configured value byte for byte: redaction cut part of it, rewrote it, or the value holds the redaction marker text itself, which cannot be told apart from a cut. The protocol refuses an entry that shows the marker without the flag. A command the redaction would cut nothing from is shown exactly as configured, its patterns and braces unescaped, so it stays reviewable. Nobody can review a command shown other than as Git runs it, so the daemon records no git filter acknowledgement for a block that holds one, and its filters stay held back under any grant. The trust sheet offers no trust for such a block and says that Domovoi cannot show the command exactly as Git runs it. Any cut counts, a credential alone included.
- d3e5aef: A `session.history` message entry may carry an optional `annotationsOverLimit`: how many open
  annotations a sent message left out for the per-turn limit. It is a positive integer and only valid
  on a message whose role is `user`. Entries without it parse as before.
- 9d94da3: Add retained rule revocation, persisted use counts and renderable hard-gate categories for the Rules tab.
  
  The wire protocol moves to 0.7.0. Update clients and daemons together: a peer on another minor version is refused at `system.hello` with `-32012`.
- c3229d9: `device.issueCode` answers with the address a device dials to spend the code, as
  `pairingAddress`: `{ url, label?, loopback }`, the name on the certificate the daemon serves and
  never the address it binds, or `{ problem }` when there is nothing a device could verify (no
  certificate on a non-loopback listener, an unreadable certificate, a certificate naming no host or
  several). The desktop pairing card, the web connect page and `domovoid pair` draw the same address
  from this one answer; the command line no longer works it out on its own.
- 8ea383c: The workspace snapshot can describe several active projects on one machine. It gains `projects`,
  every active project, and `projectCap`, how many projects the daemon keeps active at once (at most
  `maximumProjectCap`, 16). `project` stays and is the focused project: one of `projects`, and null
  only when no project is active. Each session and approval rule must belong to one of `projects`. A
  snapshot without `projects`, such as one a daemon stored before this, reads as its focused project
  alone; `workspaceProjects` returns the list either way.
  
  `session.create`, `tool.inventory` and every `skill.*` call take an optional `projectId`; left
  out, the daemon uses the focused project. A project id is at most 256 UTF-16 code units, in a
  snapshot as in a call, so every listed project can be named. `project.close` (`projectId`, `client`, optional
  `confirmation`) is declared with its confirmation, error code -32022, and its result: the snapshot
  and each session it stopped, `stopped` or `unconfirmed`. It is a control call that changes stored
  state, and a phone or tablet credential may not make it. A `project.open` past the cap is refused
  with error code -32021 and `{ kind: "project_cap", cap, activeProjectIds }`. The wire record now
  also covers the repository git filter refusal the daemon already sends. The protocol version stays
  0.8.0.
- b67435e: Recover saved client relay pins through externally signed daemon channel-key rotation and durable successor adoption.
- 81c488a: Add `localOwnerRequiredErrorCode` (`-32019`) for a method the daemon answers only
  to its owner on a direct loopback connection. It is a policy refusal, not a
  credential failure, so a client that receives it keeps the connection open.
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
- e68d767: Store an optional suggested label with a Domovoi client pairing code. The device's own name is used when it pairs; the stored suggestion is not read yet.
  
  Make --label optional on domovoid pair --client. Print the word code and browser instructions for web pairing.
- cdf5f87: Add bounded relay admission above the frozen Noise IK codec, with strict pairing
  key schemas and an encrypted client/responder record layer in a separate subpath.
  The frozen codec entry and recorded wire fixtures stay unchanged.
- 02a1b58: The window that shows a pairing code now learns what became of it. `device.issueCode` returns a
  `pairingId` beside the code, and the daemon sends a `device.codeOutcome` notification naming
  that id to the connection that issued a client code, and to no other connection. It says the
  code was redeemed, with the paired device row; refused because the device speaks another
  protocol (with its label and both versions; the code stays open), because the paired device
  list is full (with its label), or because the code was spent as a machine pairing; or closed
  because wrong codes used up its attempts or another code replaced it. A code that runs out its
  time sends nothing, since the issuer holds its expiry. The device that spent the code gets the
  same answers as before: the uniform refusal, or its own protocol-mismatch and device-limit
  errors. For a protocol mismatch, the daemon writes that refusal first and only then matches the
  code and tells its issuer, and the match costs the same whether the code is live, wrong, expired
  or spent. Only the issuer of the code that was open when the refusal went out is told, so a code
  issued in between hears nothing of it, even when its words repeat. Codes issued without a client
  kind report nothing.
  
  The shared client accepts the notification and publishes it as a `device-code-outcome` event.
- 3c2ae09: Pair a phone with a single-use code the machine draws itself
- e268b8f: A system thread item may carry an optional `connectionId` (a UUID) and `clientId`, the same shape a
  receipt uses, naming the connection that asked for a pause. Rows written before the fields existed
  parse as before.
- 1c67fba: Keep machine-pairing claims pending for five minutes instead of activating a remote credential
  before the source can store it. The source journals the claim and verifies durable keychain
  readback before confirming activation. Pending credentials cannot authenticate, and an abandoned
  re-pair does not revoke the previous active credential. Lost confirmation replies recover
  idempotently after restart; unconfirmed claims expire without ever granting normal authority.
  
  The wire moves to protocol 0.5.0. Update peers together before enrollment. Existing active bound
  credentials remain valid and do not need re-pairing. If an unfinished claim expires, issue a new
  code on the target and enroll again. Transport or storage ambiguity remains pending for retry.
- 964c47d: Narrow a phone or tablet credential to the pairing card's promise
- 973430f: Phone and tablet credentials may now call `tool.inventory`, so the phone can show what the open
  repository holds back, entry by entry. The method stays observe-tier and read-only: it reports
  environment key names, never values, and commands the daemon has already redacted. Repository
  trust is still granted and taken back from desktop or web only: `repository.trust` and
  `repository.revokeTrust` remain outside the phone and tablet scope, and the daemon refuses them to
  those credentials before reading their parameters.
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
- b2e05be: A receipt now names the paired device that decided. The receipt thread item and the approval
  history entry carry an optional `device`, the device's id and label in the shape a terminal owner
  names it, bounded like a paired device label. The daemon writes the id of the device record it
  verified on the deciding connection and the label that record has at the decision, when a person
  allows or denies a gate, reverts a file, archives a session or presses the emergency stop; a
  connection on the daemon credential has no paired device and writes none, and an archive resumed
  at startup has no connection and writes none. Renaming the device later does not rewrite a
  receipt. The label is redacted like other durable text when the daemon writes a receipt and when
  a session arrives by transfer. Transfer journals keep the received bytes unchanged, as they do
  for every other field. The daemon tries to remove a transfer's package after commit, and an abort
  also removes its payloads; if cleanup fails, the bytes stay until a later retry or the startup
  pruning of inactive transfers.
  
  The web and desktop receipt reads the label from the wire, before the client kind, as
  `decided from dana · phone, connection ...`; history rows read `decided on dana · phone`; the
  phone and tablet receipt reads `dana · phone · device fcbd…cdf8`. A receipt without a device,
  from the daemon credential or a snapshot written before the field, reads as before.
- ef58e04: Deliver signed relay successors before admission and return complete identity pins during opt-in pairing.
- cad2971: Define validated relay carrier greetings, public recovery delivery records, and bounded multiplexed frames outside the frozen endpoint codec.
- 2f4a95a: The tool inventory's repository can now carry a `gitFilters` block: each git filter driver the
  repository's own Git config sets (`local`, `worktree` or `command` scope), by operation (`clean`,
  `smudge` or `process`, or a Git LFS setting that starts a program: `lfs-transfer-path`,
  `lfs-transfer-args`, `lfs-standalone-agent`, `lfs-extension-clean`, `lfs-extension-smudge`), with
  its redacted command, the config file that sets it and the scope Git read that file in, and
  whether the daemon holds it back. A file is listed once per scope, an entry names a listed file
  in its scope, at most 64
  entries and 32 files are listed, and `omittedEntries` counts the rest. The block is optional.
  When the daemon could not read the repository's Git config, the block lists nothing and carries
  `unreadable` with a reason code, `too-large` or `git-failed`.
  
  Adds `repositoryGitFilterErrorCode` (`-32020`) for a `session.create`, `session.fork` or transfer
  refused because checking the repository out would run a filter its own Git config sets. Its data,
  `repositoryGitFilterRefusalSchema`, names the project, the current configuration digest, the
  repository's trust against that digest, and up to 32 drivers by name and scope, never by command,
  with `omittedDrivers` counting the rest.
- 3ccf0f3: The daemon can read a repository's own Claude Code, OpenCode and Kilo configuration without running
  any of it, for the tool inventory and repository trust. It lists the tool servers, hooks, environment
  key names, permission rules, helper commands, plugins and skills those files declare, and computes
  the configuration digest a trust grant pins to. The scope includes Kilo's `config.json` and the
  `tui.json` and `tui.jsonc` plugin files OpenCode and Kilo load. A repository root that is itself a link
  is refused like any other link. Every command, rule and name is redacted before it leaves the reader,
  and environment values are never read. Each text is cut before its first trigger and ends in
  `[REDACTED]`: an authorization scheme word, a sensitive key or flag, an assignment, a header flag
  (`-H`, `--header`, `--proxy-header`), URL user info, or any credential shape the protocol's check
  knows. The reader looks for a trigger in every form that check reads: as written, quoted strings
  included; after one layer of percent encoding; after backslash and `\u` escapes; as the shell's
  words; and among a JSON argument vector's strings. Each of those readings is taken again of every
  form another makes, until no new form appears. Text whose forms still change after six readings or
  64 forms is cut after its program name, or reads `[REDACTED]` alone. A command given as an argument
  vector is cut at whole arguments. Before the cut, a URL keeps its scheme and host, and its path and every query and
  fragment value read `[REDACTED]`. The protocol's check then judges each text once; one it would still
  refuse is cut after its program name, or reads `[REDACTED]` alone. Nothing calls the reader yet; the
  `tool.inventory` handler and the trust store come later.
  
  The protocol exports the cap on each tool inventory entry text field
  (`maximumToolInventoryCommandLength`, `maximumToolInventoryDetailLength`,
  `maximumToolInventoryMatcherLength`, `maximumToolInventoryNameLength`,
  `maximumToolInventoryHelperNameLength`, `maximumToolInventoryRuleLength` and
  `maximumToolInventoryEventLength`), and the inventory schema holds each field to them. The daemon's
  reader fits every redacted text to the same constants. It also exports its credential check
  (`holdsCredential`), the rules that check reads (`credentialRules`: scheme words, sensitive key
  parts, whole-name keys, pointer suffixes and token prefixes, frozen), `isCredentialKey` and
  `credentialShapeAt`, which finds the first credential shape in work that grows linearly with the
  text. The daemon's reader takes its rules from these rather than a copy.
- fc40225: A `repository.revokeTrust` result can count the threads it stopped and did not list. A revoke
  stops every thread that loaded the repository's trusted configuration, however many there are. It
  lists at most `maximumRepositoryTrustThreadRestarts` (1,024) in `threads`, and `omittedThreads`
  counts the rest. The field is a positive integer present only when at least one thread was left
  out, so a client never presents a cut list as the whole of it.
- f94caa0: A repository's trust state can now say that it cannot be trusted, whatever the person approves,
  because its agent would load input the configuration digest does not cover. The state lists each
  refusal by provider, code (`nested-config`, `main-checkout-hooks`, `main-checkout-unknown` or
  `instructions-outside`) and redacted path, at most 32 of them, and counts the rest in
  `omittedRefusals`. It pins to no digest. `repository.trust` gains a `cannot-trust` outcome for
  such a repository, in which nothing is granted, and `repository.revokeTrust` may report a
  repository in this state. Paths and provider names are held to the same rules as the tool
  inventory's text, which now lives in one module both use.
- a5a510e: `repository.trust` takes an optional `gitFilters: { reviewed: true, reviewDigest }`. A client sends it when it showed the person every git filter the repository's own Git config sets, from `tool.inventory`'s `repository.gitFilters` read with the same `configDigest`, and `reviewDigest` is that block's `reviewDigest` as the client received it. Every `repository.gitFilters` block carries a `reviewDigest` over what it lists, not over `heldBack`; the daemon recomputes it at trust time and grants nothing when it differs. Only a grant made with it lets the daemon run those filters; a grant made without it, by an older client or before filters could run, keeps them held back, and a refusal over a filter under such a grant reports the repository as trusted.
  
  Each `clean`, `smudge` and `process` entry in `tool.inventory`'s `repository.gitFilters` carries `required`: `"true"`, `"false"` or `"unset"`, the driver's effective `filter.<driver>.required`, which the trust digest pins. A Git LFS setting carries none.
- e29f975: Adds repository trust to the protocol. Trust is recorded per machine and per repository, and it
  is pinned to the digest of the repository's provider configuration files that the person
  reviewed. A trust state is not trusted, trusted with the digest it covers, or not trusted because
  the configuration changed since it was trusted, which keeps the earlier grant for review. A
  trusted state whose digest is not the current one is refused. The tool inventory's repository now
  carries its trust state.
  
  `repository.trust` takes the project and the digest the client showed, and answers either trusted
  or that the configuration changed, with the repository's current digest and state.
  `repository.revokeTrust` leaves the repository not trusted and lists each session whose agent
  thread it restarted, or whose old thread it could not confirm stopped. Both are control methods
  that change stored state, listed in `repositoryTrustRpcMethods` for the daemon's credential check.
  Only desktop and web clients call them: phone and tablet credentials do not get them, and a grant
  names a desktop or web client. A grant time is at most 40 UTF-16 code units, checked before it is
  read as a timestamp. Neither method has a field for another
  machine, the fleet or a hard gate, so trust never skips a hard gate. The daemon does not answer
  them yet.
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
- 6ddadb7: Add explicit terminal claim release, claim timestamps, and opt-in resize notifications.
  Released shells keep running unheld and require a new claim before input, resize, or close.
  Preserve claim times across reconnects, report `claimHeld` on ownership changes, and send
  `terminal.resized` only to watchers that request `followResize`.
  
  Resize notifications mark their position in the output stream before the PTY is resized.
  Already-redacted output queued before a resize is sent before the notice; output drawn
  for the new grid follows it. Text the redactor still retains at the resize, including
  complete lines, can follow the notice. Resizing does not release that text.
  While output is paused for slow readers, adjacent resize markers coalesce to the latest
  dimensions and wait for low water. Resizes with no eligible follower do not observe
  backpressure. Closing a terminal flushes queued output and markers before its closed notice.
  Joining or rejoining a paused terminal preserves that pause. The reply excludes queued
  output from its replay, so that text arrives once through the live stream after resume.
  Live joins also stop draining when delivery first pauses, retaining queued resize markers
  until low water. Same-client ownership moves through input deliver pending text to the
  new connection even though the input reply carries no replay.
  Reopening a same-client terminal with new dimensions captures its replay before resizing,
  so synchronous redraw output arrives only live, after the resize marker. The create reply
  reports the dimensions at the start of its queued live suffix when the connection follows
  resizes; other create replies report the new dimensions. A following watch reply also
  reports the starting grid of its queued suffix. Resize boundaries are retained even when
  no follower exists yet, so a follower joining during a pause receives old-grid output
  before the notice that advances it to the new dimensions. Without an eligible follower,
  resize boundaries wait for normal batch delivery instead of flushing partial output early.
  A retained boundary can split an output notification at that delivery, preserving the
  old-grid and new-grid ordering needed by a follower that joins before the queue drains.
  An empty replay has no start timestamp; if queued output exceeds retained history,
  the watch reply reports that earlier output was dropped.
  
  Protocol version remains `0.8.0`; new fields are optional and older watch requests receive
  no resize notifications.
  
  The desktop and browser terminal pane and the phone's terminal view read `claimHeld` from an
  ownership notice. After a release they say nobody holds the shell, and the former holder's pane
  stops sending input until it takes the shell again. A notice without `claimHeld` still means held.
- e583a5a: Ruling Q401: the workspace snapshot now carries turn timing, one source for "Worked for N" and
  the header clock on desktop and tablet. `turns` lists, for each turn the snapshot's thread links,
  its `id`, `sessionId`, `ordinal`, `startedAt`, `completedAt` when known, and `status`. The daemon
  derives it from its usage ledger for every snapshot it sends and never stores it; it is absent
  when the thread links no turn. A pending turn is running; completed and failed turns ended when
  the daemon saw them end; an interrupted turn has `completedAt` only when the daemon saw it stop.
  Each turn id is listed once. If the ledger cannot be read, the snapshot goes out without `turns`
  and the daemon reports the failure once until a read succeeds again.
  
  A turn that was still running when the daemon itself stopped has no `completedAt` in the
  snapshot: the restart time is not when it ended. The ledger still records that restart time, and
  now says so: its turn metadata, and the `turn` on `session.history` entries, carry
  `completedAtSource: "daemon-restart"` for such a turn. Records written before this change carry
  no mark. Phone and tablet access is unchanged.
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
- 728416e: Add the `tailnet.status` observe method and `tailnetListenerStatusSchema`: the
  daemon's tailnet listener is off, listening on an address and port with the
  certificate's expiry, or refused with a bounded reason and whether the daemon
  retries on its own.
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
- 1ed1cdf: Adds the `tool.inventory` method: what each agent's own configuration files on one machine
  declare, as tool servers, hooks, permission rules, environment keys, helpers, plugins and skills,
  each with the file that declared it and whether it runs when a session starts. Every file is
  reported as read, empty, absent or unreadable with a reason, and entries come only from files that
  were read. Environment entries carry key names only, as identifiers; no field holds a value. The
  daemon redacts every text field before sending it, and the schema refuses any text that still
  carries a value: an environment assignment, a sensitive key, flag or authorization scheme with its
  value, URL user info, or a known token shape, read as sent and after one layer of quoting, percent
  and backslash decoding. Text is one line
  with no format characters or separators. A remote tool server is named by a valid host and a port
  from 1 to 65535, never a URL path, query or user info. A response, envelope included, stays within 256 KiB, and each
  agent counts the entries it left out to fit. Entries the repository brings can be marked
  held back, and the inventory carries a digest of the repository's configuration files so a later
  trust decision can pin to what the client was shown. An agent Domovoi starts with no tool servers
  says so rather than listing none found. The method is observe-tier and read-only, and phone and
  tablet credentials do not get it. The daemon does not answer it yet.
  
  Approval requests now refuse fields they do not define instead of dropping them, and gain an
  optional `toolServer` fact naming the server, its transport, and the
  file that declared it. Such a request never carries a resolved execution record, so a tool server
  call is answered with Allow once or Deny and never becomes a standing rule.
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
- 9a015e9: Update production dependencies. The daemon moves to Claude Agent SDK 0.3.281, Anthropic SDK 0.128.0,
  Agent Client Protocol SDK 1.5.0, Kilo SDK 7.7.9, OpenCode SDK 1.18.32, MCP SDK 1.30.1 and yaml
  2.9.1. Claude Agent SDK 0.3.281 is built against Claude Code 2.1.281, so the daemon now refuses an
  older `claude` with "Update Claude Code to 2.1.281 or newer". The floor was 2.1.263. The keyring
  binding moves to 2.1.0, zod to 4.6.5 and vite to 8.3.0. The shared ui and the web and desktop
  clients move to Lucide 1.47.0 and tailwind-merge 3.7.0, and stay on React 19.2.8 and
  react-resizable-panels 4.12.4: the newer two would put startup JavaScript over its budget. The
  phone takes Expo 57.0.24 and stays on the React, safe-area and SVG versions that SDK bundles.
- 91b1e15: Accept compatible patch versions in daemon snapshots without rewriting the reported
  version. Validate bounded canonical wire versions consistently and compare major
  and minor components exactly, including values above the safe integer limit.
- 18f6543: Upgrade Zod to 4.5.2 while preserving UTF-16 string limits, persisted minute-precision timestamps, transfer manifest digests, and readable validation refusals.
- 5f104a3: Include optional daemon time in fleet snapshots, notifications, and mutation replies so clients can measure heartbeat ages against the daemon clock. Keep protocol version 0.8.0 and accept snapshots without the timestamp.
- 9db320a: Report fleet machines as unreachable when failed connection attempts outlast the existing offline heartbeat bound. Keep brief failures reconnecting and restore healthy status after authenticated contact resumes.
- b8c55c2: The tool inventory no longer carries a credential in a remote tool server's host or in an
  environment key name. The reader shows `[REDACTED]` for a host with a label shaped like a known
  credential, read in the URL as written and as parsed, and for an environment key name that is
  itself shaped like one; the entry is still listed. The protocol refuses those shapes in both fields
  and takes the marker, so a reader that misses one drops the entry and counts it instead of sending
  it.
- 16c242a: The tool inventory no longer shows a secret path in a command. A flag that says where a token,
  key, secret, password or credential lives (`--token-file`, `--password-file`, `--ssh-key-path`,
  `--key-file` and the like, as `--flag value` or `--flag=value`) is a trigger: the reader cuts the
  text there, as it does at a sensitive flag. The protocol exports `isCredentialLocationKey` and the
  `locationSuffixes` rule, and its backstop refuses a value after such a flag. In a command line or
  argument vector, the reader also cuts at the first argument that names a known credential store
  or secret file, judged by the same classifier the hard gate uses. A rule such as `Read(./.env)` is
  not a command and keeps its path.
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
- 777efeb: Leave the demo OpenCode audit session effort unset so the model uses its own setting.
- 45e152d: Settings gains Phone and tablet: a pairing card that shows the daemon's own pairing code for a phone, tablet or browser, with its QR, address and 180 second countdown, and says why no code can be shown when the daemon answers on loopback only or reports no certificate. The shared list of what a paired device can do now carries six lines, including that gates reach a device only while its app is open, and the terminal line is the short one.
- 7bea6a9: Report a touched file path exactly as the provider named it. A leading or trailing space is a legal character in a path name, so the previous trim could name a file the provider never did and could fold two distinct paths into one, making the file count wrong. Whitespace alone is still rejected.
  
  Show a refused plan reply. Accepting a plan written as prose now surfaces the failure next to the button instead of returning it to its resting label in silence, and the branch no longer invites a line comment it cannot take.
- 19aad21: The preview frame's anchor messages keep a comment's ID exactly as stored, with the same 256 code unit bound, so a padded or whitespace-only ID resolves its anchor instead of being rejected.
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
- 66a1846: `isLoginServiceRuntimeVersion` is the one check for the version that names a published runtime copy's directory: the desktop publishes only under such a version, and the daemon reads a service's runtime version back only from one.
- ee3fe90: Add separate, kind-bound remote client grants and Fleet client admission. A machine pairing remains daemon-to-daemon authority, not permission for a desktop or browser to control the target.
  
  Authorize this client in Fleet takes a separate client credential for the target, one a device.pair request made with the target daemon's own credential returns. No Domovoi command or screen hands out that raw credential yet: `domovoid pair` prints a one-time pairing code, which the dialog does not take. Use, Terminal and inventory reads require the target identity and client receipt to verify. Desktop main verifies each enrolled route through the home daemon and grants only that exact socket origin. Update both daemons and the client before using these additive calls. The wire remains 0.5.0, existing pairings remain valid and no re-pair is required.
  
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
- cb8b27a: An approval card names the tool server behind a call to a tool server's tool, and the daemon
  refuses Always for any such card before it reads the card's execution record. Claude MCP tools are
  named from `mcp__<server>__<tool>`. Codex MCP tool calls, which Codex asks about with an MCP
  elicitation, now raise an approval card when the request is tied to exactly one running call of that
  server on the same thread and turn; any other request marked as a tool call approval is declined.
  The card states the call's tool, server and arguments first, and the request's own message only as
  unchecked text. The answer never asks Codex to remember it. An ACP tool call is a shell command
  only when its kind is `execute`. An OpenCode or Kilo permission is a shell command only for `bash`
  with its command; an edit of one file is the Edit file tool on that file, so Always still makes a
  file rule; any other permission, one with no name included, is the provider's tool, which cannot
  become a standing rule.
  
  The protocol's `toolServer` fact can name a server without the file that declared it: the daemon
  names a server as the agent names it when it did not read that server's configuration, so
  `transport`, `source` and `file` are optional, and a file still needs its source.
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
- b30b27e: Preserve absent provider effort defaults and start those models with unset effort. Claude offers Model's own first when effort is supported, omits the initial effort override, and clears an existing override when unset is selected. Normalize legacy medium effort to unset when a model reports neither levels nor a default, so stored sessions can restart and change runtime.
- b90c8de: The protocol package gains the web app bundle manifest, `domovoi-web.json`: its schema, the path and extension rules, the size bounds and the protocol compatibility rule, so the web build that writes it and the daemon that reads it share one definition. Paths are ASCII, refuse a trailing period and Windows device names in any segment, and must differ under case folding. It is not wire and changes no protocol version.
- fa621d6: Name the workspace delta batch delay as a performance budget. Terminal output already had a published batch delay, but assistant text deltas had none, so any batching interval would have been a bare number inside the daemon. The budget file now carries `workspaceDelta.batchDelayMilliseconds` and the protocol package exports it as `workspaceDeltaBatchDelayMilliseconds`, so the interval is visible to `pnpm performance:budget` and to every client that needs to reason about it. A test pins the value and pins it at or above the terminal output delay.
- 6832713: Refuse WSL facts on any platform but linux. A heartbeat or enrollment
  descriptor that claims a distribution for a `win32` or `darwin` daemon is
  refused as an invalid descriptor instead of being shown as a WSL machine.
