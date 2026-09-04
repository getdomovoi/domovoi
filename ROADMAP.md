# Domovoi roadmap

This roadmap turns the signed product handoff, product contract, distribution contract, and the
2026-08-28 and 2026-09-02 repository audits into an ordered delivery plan. It describes outcomes,
dependencies, and proof of completion. It does not replace `PRODUCT.md`, `DESIGN.md`, or the
Claude Design handoffs.

## Status and priority

- `[x]` implemented and verified in the repository
- `[ ]` not complete
- `P0` required before untrusted or remote use
- `P1` required for the first useful public alpha
- `P2` required for hosted beta or broad distribution
- `P3` later expansion

## Current baseline

The repository already proves this local vertical slice:

- [x] pnpm TypeScript monorepo with protocol, daemon, shared UI, Electron, and web packages
- [x] versioned Zod schemas over WebSocket JSON-RPC
- [x] daemon-owned SQLite workspace state and restart persistence
- [x] isolated Git worktrees with durable checkpoints and recoverable restore
- [x] Ask, Plan, Build manual, and Build auto runtime policy
- [x] approval requests, decisions, standing rules, receipts, and originating-client attribution
- [x] Codex CLI, Claude Code, OpenCode, and Kilo session adapters
- [x] provider/model selection and checkpointed cross-provider handoff
- [x] interactive daemon-owned PTYs with ownership transfer
- [x] sandboxed HTML artifacts with short-lived preview capabilities
- [x] structured preview annotations, replies, and resolution
- [x] local skill discovery across project, user, system, Codex, Claude, Kilo, and `.agents` paths
- [x] searchable skill browser and read-only `SKILL.md` source viewer
- [x] shared responsive UI in Electron and the installable web/PWA shell
- [x] custom desktop window decoration on Windows and Linux, native title bar on macOS
- [x] Linux, macOS, and Windows CI for typecheck, tests, and builds
- [x] Apache-2.0 local core and documented open-core boundary

## Goal 0: secure and bound the local core

Priority: `P0`. Finish before asking users to trust Domovoi with real repositories or remote
access.

- [x] Require authentication for every daemon, including loopback listeners
  - Generate a high-entropy credential when none is supplied.
  - Persist standalone credentials in a user-private file and keep browser handoff session-only.
  - Prove unauthenticated RPC and terminal requests are rejected.
- [x] Stop a paired machine reading another machine's workspace
  - A machine hello returns no workspace and machine sockets are excluded from workspace
    broadcasts. Machine connections get the transfer surface only.
- [x] Bind a machine credential to the machine it was issued for
  - Enrolment records the machine a credential is for, and the actor is derived from the
    credential rather than asserted by the caller. `system.hello` no longer accepts a
    caller-supplied `machineId`, which is a wire change, so the shared protocol is `0.2.0` and
    peers speaking `0.1.0` fail at the handshake.
  - Credentials issued before the binding could act as either a machine or a person and are
    revoked on migration, so every pairing made before this has to be made again. The paired
    devices list names an upgrade revocation, and a move to a machine whose credential was
    retired refuses with `target-pairing-required`.
- [x] Protect embedded OpenCode and Kilo provider servers
  - Use provider-supported authentication or OS-protected IPC.
  - Prove direct unauthenticated requests cannot bypass Domovoi approvals.
- [x] Restrict persisted state permissions
  - Create the Domovoi state directory as `0700` and database plus sidecars as `0600` on POSIX.
  - Repair permissive existing files on startup.
  - On Windows, state lives under `.domovoi` in the user profile directory; no ACL restriction
    equivalent exists yet.
- [x] Make RPC timeouts cancel or quarantine underlying work
  - A timed-out provider, Git, checkpoint, or restore operation must not mutate state after the
    serialized request has failed.
- [x] Split the daemon-wide mutation queue
  - Keep ordering per session and resource.
  - Terminal input, unrelated sessions, and independent machines must not block behind slow Git or
    provider work.
- [x] Bound streamed workspace updates
  - Broadcast bounded typed deltas and debounce canonical persistence instead of sending the
    complete growing snapshot for every token.
  - Keep complete durable history while paging older items behind a bounded recent window.
- [x] Drain queued events before persistence shutdown
  - Reject new RPC and provider events after shutdown starts while draining already-queued work.
  - Persist the final canonical state before provider and SQLite cleanup, with restart recovery
    coverage.
- [x] Add subprocess deadlines and cancellation to Git operations
- [x] Recover Codex cleanly after its subprocess exits
- [x] Add browser RPC response deadlines and cancellation
- [x] Return stable public RPC errors while keeping internal exception detail in redacted logs
- [x] Validate daemon environment configuration at runtime
- [x] Tighten protocol aggregate references and JSON-RPC response invariants

Completion proof:

- adversarial authentication and authorization tests;
- timeout and race tests with late completions;
- bounded long-session measurements;
- clean shutdown recovery tests;
- Linux, macOS, and Windows CI.

## Goal 1: finish the local desktop alpha

Priority: `P1`. Produce a dependable single-machine Domovoi that can replace a terminal-only agent
workflow without becoming a code editor.

### Completion-audit remediation ledger

Live-verified against `getdomovoi/domovoi` on 2026-09-01 (America/Boise):

- [#94](https://github.com/getdomovoi/domovoi/pull/94) — `fix: bound daemon request admission` —
  `MERGED`: closes unbounded pre-authentication request admission and inherited RPC method dispatch.
- [#95](https://github.com/getdomovoi/domovoi/pull/95) —
  `fix: harden provider connection lifecycle` — `MERGED`: closes late provider setup/shutdown and
  stale-connection races after timeouts.
- [#93](https://github.com/getdomovoi/domovoi/pull/93) —
  `fix: harden desktop lifecycle and renderer` — `MERGED`: closes unawaited daemon shutdown and
  untrusted privileged-renderer IPC origins.
- [#96](https://github.com/getdomovoi/domovoi/pull/96) — `fix: stabilize session evidence` —
  `MERGED`: closes mixed-generation Git evidence when worktree state changes during collection.
- [#98](https://github.com/getdomovoi/domovoi/pull/98) — `fix: ignore stale skill source` — `MERGED`:
  closes out-of-order skill-source responses replacing the active selection.
- [#99](https://github.com/getdomovoi/domovoi/pull/99) —
  `test: verify bundled desktop launch` — `MERGED`: closes missing built-desktop launch proof and
  Windows skill-link safety coverage.
- [#97](https://github.com/getdomovoi/domovoi/pull/97) —
  `fix: harden preview annotation context` — `MERGED`: closes annotation-crop retention races
  through reserved concurrent crops and serialized reconciliation, and reports retention failures
  through the one bounded, secret-redacting error path.
- [#100](https://github.com/getdomovoi/domovoi/pull/100) — `build: enforce workspace quality gates` —
  `MERGED`: closes audit concerns I1–I5 and adds the workspace lint gate. Before it, `pnpm lint`
  matched no package script and passed without linting anything.
- [#101](https://github.com/getdomovoi/domovoi/pull/101) — `perf: bound desktop alpha hot paths` —
  `MERGED`: offloads snapshot persistence to a worker that waits for a busy database and is
  replaced once it is gone, bounds RPC output, debounces history search, and backs off reconnects
  without retrying a device a machine has revoked.

Every ledger entry is now merged.

### Sessions and worktrees

- [x] Open a local Git repository and create a session worktree
- [x] Send, steer, stop, persist, and resume agent turns
- [x] Reconcile interrupted active turns on daemon startup without losing worktree or history
- [x] Restart a quarantined provider thread in-app while preserving the existing session worktree
- [x] Create and restore checkpoints with a recovery checkpoint
- [x] Change providers/models through a documented checkpointed handoff
- [x] Prevent manual checkpoint creation while an agent is mutating the worktree
- [x] Add a complete session history with filters for messages, tools, approvals, handoffs,
  checkpoints, annotations, and tests
- [x] Expose worktree diff, changed-file details, and test evidence from real Git/tool state
- [x] Review the worktree diff as unified text or as two split columns, with added, modified, and
  deleted counts beside the changed-file list
- [x] Revert one changed file from the Changes dock behind a confirmation, after the daemon has
  taken a recovery checkpoint and with a client-attributed receipt
- [x] Add session archive and deliberate cleanup without deleting the source repository
- [x] Add explicit fork-with-model beside switch-here behavior
- [x] Require explicit confirmation before switching projects stops the current project's running work
- [x] Keep workspace state per project so opening a second repository preserves the first
  - Persist one snapshot row per project id beside the active-workspace row, migrating an
    existing single-row database into the row for its own project.
  - Restore a project's sessions, thread, approvals, artifacts, and annotations on reopen, and
    keep machine-scoped state such as machine facts and skill enablement reviews out of the
    per-project rows.
  - Stop live provider threads, active turns, and terminals when switching away, and delete
    session worktrees only on the deliberate `session.archive` path.

### Providers and credentials

- [x] Codex CLI adapter
- [x] Claude Code adapter
- [x] OpenCode adapter
- [x] Kilo adapter
- [x] Cursor Agent adapter
- [x] Grok CLI adapter
- [x] Provider account and readiness settings from the signed handoff
- [x] OS-keychain storage for direct provider API keys and other secrets
- [ ] Direct API adapters where they add capabilities unavailable through subscription CLIs
  - Only OS-keychain key storage ships; `docs/provider-capabilities.md` lists no direct adapter.
  - Deferred past the alpha on 2026-09-03. `PRODUCT.md` line 41 commits to subscription-backed
    provider CLIs first, so this is not alpha scope.
- [x] Token and cost telemetry normalized per turn, session, provider, and model
- [x] Session token totals and provider-reported cost in the client, with a per-runtime breakdown
  and an explicit count of turns the provider reported no cost for
- [ ] Usage totals across sessions over a time window, such as a today total in the app bar
  - The daemon usage ledger records no turn timestamp, so a windowed sum needs a schema change
    before any client can show one honestly.
  - Deferred past the alpha on 2026-09-03. Per-session totals already ship; a windowed sum adds
    timestamp migration, window semantics, an aggregation RPC, and client work for an analytics
    readout rather than for the alpha workflow.
- [x] Clear handling for provider rate limits, authentication expiry, quota exhaustion, and missing
  model access
  - The Claude adapter keeps a bounded, redacted tail of provider stderr and preserves the
    reported error, so each condition reaches a client as its own classified failure rather than
    unknown/retry. Outgrowing the context window is its own `context-window-exceeded` kind, which
    is not retryable, so no client offers a retry that cannot succeed.

### Permissions and auditability

- [x] Ask, Plan, Build manual, and Build auto controls
- [x] Approval cards with decision receipts and client attribution
- [x] Per-project standing approval rules
- [x] Stop translating a standing approval into provider-native persistence
  - `always-project` currently becomes `acceptForSession` in `apps/daemon/src/codex.ts`, `always`
    in `apps/daemon/src/opencode.ts`, and provider-suggested `updatedPermissions` in
    `apps/daemon/src/claude.ts`. The provider then answers later requests itself, where Domovoi
    cannot see, audit, or revoke the approval. Providers must receive allow-once only, and the
    daemon must own every standing rule. This blocks the fingerprint work below, and it would also
    let a retired rule keep approving through the provider.
- [x] Key standing rules on a fingerprint of the resolved command rather than its text
  - A rule matches on `projectId` and the literal command, so it keeps approving a script whose
    body has since changed. The fingerprint should cover the normalized command, the
    project-relative directory, recursively expanded script bodies, lifecycle scripts such as
    `pretest`, and the validated runner arguments. A command whose resolution is ambiguous stays
    reviewable but cannot be reused. Rules carry no fingerprint today, so this changes the
    approval and rule schemas.
  - The digest proves the command resolved to the same text, not that the same code runs. An
    unchanged `pnpm test` still executes whatever the runner resolves to, so a changed config,
    plugin, setup file, or dependency binary stays invisible to it. That gap is unresolved decision
    3 and this item does not close it.
  - Decided 2026-09-03: existing text-only rules stop matching but are kept. They stay visible and
    auditable as inactive rules and need explicit reapproval. They are never deleted and never keep
    approving anything silently. A rule going inactive has to be legible to the person who granted
    it, so that a returning approval prompt reads as a deliberate revocation rather than a bug.
- [x] Enforce hard gates that Build auto cannot bypass
  - `f137506` gates secret reads through Git, and `apps/daemon/src/permission-policy.ts` checks
    hard-gate patterns and skill installs before any Build-auto allowance.
  - The general claim is now tested rather than sampled. `apps/daemon/src/permission-policy.test.ts`
    asserts that a hard gate found anywhere in a resolved script graph is refused, across direct
    commands, `pre` and `post` lifecycle scripts, chained commands, and recursively expanded
    scripts, and that Build auto refuses every unresolved execution reason.
  - Writing that test found a real hole: a safe-looking raw command could override an unresolved
    execution record under Build auto. The resolver's verdict is now authoritative, so Build auto
    asks whenever the resolver cannot prove what a command expands to.
- [x] Add a searchable audit log with redaction and export
- [x] Add command-level secret redaction before persistence or display
- [x] Add a global emergency stop that cancels all active tools and providers, not only UI state

### Preview and review

- [x] Full-fidelity sandboxed HTML preview
- [x] Picker bridge and structured anchored annotations
- [x] Annotation replies and open/resolved lifecycle
- [x] Detect new plan/design artifacts written inside the worktree without provider-specific events
- [x] Preserve annotation anchors across document revisions with selector, text quote, and bounding-box
  fallbacks
- [x] Capture cropped visual context for an annotation and pass it to vision-capable agents
- [x] Add variant metadata, thumbnail filmstrip, device-width presets, and optional compare layouts
- [x] Add chat-inline Markdown quick views while keeping generated HTML canonical
- [x] Add print/share-safe plan rendering without weakening the preview sandbox

### Skills

- [x] Discover and deduplicate local skills
- [x] Show provenance, scope, exact path, metadata, and source
- [x] Define capability manifests, content digests, signature state, and trust state
- [x] Add a manual-review trust path that binds trust to the reviewed content digest and records
  the reviewing client in the audit log
- [ ] Verify skill signatures and produce a trusted state
  - Cryptographic signatures are still only `unverified`, `unsigned`, or `invalid`; trust currently
    comes only from manual review of an exact content digest.
  - Deferred past the alpha on 2026-09-03. Verification needs a signer registry, trust roots,
    revocation, and key custody decided first. The alpha position is manual digest-bound review
    plus exclusion from Build auto.
- [x] Add reviewed per-project skill enablement
- [x] Inject only enabled skills into provider session context
- [x] Gate terminal-based skill installs through the normal permission system
- [x] Define safe behavior for unsigned skills in Build auto
- [x] Define the skill inventory contract and comparison model without distributing executables
- [x] Fetch inventories from every reachable fleet member and compare them
  - The skills surface dials each paired machine that reports the skills capability and asks for
    its inventory. Metadata only: no skill file crosses a machine boundary.

### Desktop quality

- [x] Shared Claude-handoff workspace and custom window decoration
- [x] Appearance settings with System, Dark, and Light themes that follow the operating system live
- [x] Window decoration choice between the Domovoi title bar and the operating system frame,
  applied when Domovoi next starts
- [x] Persist layout, selected surface, project, and session safely across restarts
- [x] Keyboard command palette for navigation and common session actions
  - Sessions, paired machines, and discovered skills are addressable from it, so a session is
    reachable without the sidebar.
- [x] Native completion, failure, and approval-needed notifications
- [x] OS file dialogs, deep links, clipboard behavior, and external-editor handoff
- [x] First-run provider diagnostics and actionable recovery states
- [x] Accessibility pass for keyboard, focus, screen readers, reduced motion, contrast, and zoom
- [x] Performance budgets for startup, memory, long threads, terminal throughput, and large previews
- [x] Sessions sidebar footer bound to the live machine name and fleet count

### Handoff surfaces not yet built

The desktop handoff specifies these; `main` does not implement them yet.

- [x] Fleet screen with transport order, machine cards, version and `UPDATE` state, and Use,
  Terminal, and Revoke actions
  - The `UPDATE` badge is a patch-level fact and deliberately separate from protocol health: a
    machine one patch behind still speaks the protocol, so it is marked as behind rather than
    reported as a version mismatch. A machine whose version cannot be read is left unmarked, since
    an unreadable version is an unknown and a badge is a claim.
- [x] Settings shell: Appearance & window (System, Dark, and Light theme; window decoration with
  system fallback), Permissions & rules, External editor, and Notifications
- [x] Cost and token readouts in the app bar and session header from `session.usage`
- [x] Context occupancy readout beside those totals
  - `sessionUsageSchema` carries `contextTokens` and `contextWindowTokens`, and both are optional
    so a client shows the readout only when the provider reported the pair. No adapter populates
    them and no client reads them yet.
- [ ] Add-skill flow with declared-capability review and install scope
  - Deferred past the alpha on 2026-09-03, with the skill trust model it depends on. The protocol
    has no install, copy, or distribute RPC, and shipping a convenient installer for arbitrary
    code before the trust model exists is the wrong order.
- [x] Editable working plan with per-step state in the Plan tab
  - Protocol, daemon, and client all ship. Codex, Claude, and ACP report plan structure and
    progress; the daemon owns canonical state, binds a blocked step to its approval, delivers the
    plan at a turn boundary under prepare-then-commit, and keeps a queued or conflicted edit
    through handoff, restart, and archive. The client renders steps, edits, reorders, and discards,
    and pins an edit to the revision it opened against.
  - A person's unaccepted draft never reaches a provider: only canonical steps are delivered.
- [x] Per-file diff review with revert in the Changes tab
- [x] Composer skill chip naming what a turn carries
  - The composer names the project's reviewed skill, or counts them, beside a `+ skill` control
    that opens the Skills surface, matching the two controls in the desktop handoff.
- [x] Say on a sent turn which skills reached the provider and which did not
  - A user thread item carries `providerPromptDelivery`, so the thread reports what was sent and,
    for anything omitted, whether it was cut for room, excluded by a limit, unreadable, dropped
    because its review changed, or refused by permission mode. An absent record means the turn
    predates delivery tracking rather than a turn that carried nothing, and the copy never claims
    the provider used what it received.
- [x] Let a person choose which reviewed skills a single turn carries
  - `session.send` takes an optional `skillSelection` pinning each chosen skill to the content
    digest and capability manifest it was chosen against, so a skill that changed between choosing
    and sending refuses the whole turn instead of quietly substituting itself. The refusal names
    the skill and whether it is no longer enabled, unreadable, changed, or excluded by permission
    mode, and the composer marks that skill.
  - A selection is a subset of what the project already reviewed and enabled, never a second path
    to running unreviewed code. Explicit selections are required context: they never enter the
    budget drop order, and a selection that cannot fit refuses the turn rather than sending fewer
    skills than a person chose.
  - Sending no selection preserves the project-default behaviour exactly, and an empty selection is
    a deliberate "no skills this turn" rather than an absent one.
- [ ] Give the prompt composer a total budget and a documented drop order
  - `apps/daemon/src/prompt-composer.ts` now assembles skills, annotations, working plan, handoff,
    and user text in one place, and `apps/daemon/src/prompt-composition.golden.test.ts` pins all
    sixteen section combinations byte for byte. Each section still truncates against its own limit
    with no knowledge of the others, so five sections that each pass can still compose a prompt
    none of them thought was too large. This is a deliberate behaviour change and needs its own
    tests; do not fold it into a refactor.
- [x] Align the shell to the design-system geometry: 62px rail, 240px sidebar, 760px thread lane,
  280px inspector, and the fixed chrome heights recorded in `DESIGN.md`
  - Sizes live as tokens in `packages/ui/src/styles.css` with a test comparing them against the
    table in `DESIGN.md`, so drift fails in both directions. Claude Design settled the desktop
    chrome as a 38px titlebar and a permanent 62px rail, with no horizontal 62px header.
- [x] Vendor the Claude Design system contract so it lives in the repository
  - `design/design_system_domovoi/` holds the tokens and now `readme.md`, the system's own
    contract: content rules, the colour and type contract, the fixed chrome values, motion,
    interaction states, iconography, and the component inventory. `DESIGN.md` points at it.
  - Specimen cards and per-component prompts stay in the project deliberately. They are static
    mirrors of components this repository does not implement, so vendoring them would add files
    nothing checks against and the recorded revision would then police drift in copies nobody
    reads. Read a component's `.prompt.md` from the project when implementing that component.
- [x] Port the live terminal-pane restyle from the current design revision
  - The chrome moved to the sidebar surface and line spacing opened to 1.85. The revision's
    per-line treatment, a prompt span and a left-border highlight for command, pass, and fail rows,
    is not ported and should not be: the pane renders a real PTY through xterm, so classifying a
    line as a command or a failure would invent structure the stream does not carry.
- [x] Rework the Changes dock as per-file accordions from the current design revision
  - Each file row opens its own diff, with Expand all and Collapse all on the section. The
    protocol carries one worktree diff rather than a diff per file, so the client partitions that
    text on its `diff --git` headers. A file with nothing to show says why, naming a truncated
    transport bound or a binary file, rather than opening empty.
- [x] Prompt-editor modal with prose and Markdown modes, inserts, and draft statistics

## Goal 2: add private machine-fleet operation

Priority: `P1`. Keep code and execution on the selected machine while one client controls the
fleet.

The items below were checked off before Claude Code and Codex began reviewing each other's work.
Three holes found on 2026-09-04 were inside items already marked complete: a paired machine could
read another machine's workspace, concurrent daemon starts raced on machine identity, and a
credential could act as either a machine or a person. A second pass over the fleet surface
underneath the transfer work is queued, weighted toward credential handling and transport
ordering, where a mistake is both reachable from another machine and quiet. The encrypted relay
preflight closed the immediate credential blockers: credentials are fixed-width, exact client or
machine bindings determine the authenticated actor, activity is recorded only after an accepted
hello, and both legacy credential shapes are retired in one migration. That preflight is not the
full second pass. Resume with enrollment, revocation and rotation; transport authentication and
ordering; install and supervision; then WSL discovery and interop. Transfer itself is excluded
because its ownership and recovery contract already received joint review.

One known lifecycle finding remains parked with that audit: `MachineCredentialStore.forget()` has
no production caller, so an outbound machine credential remains in the OS keychain until it is
overwritten. Deletion needs an authoritative revocation, removal, or re-pair event before that
method can be wired safely.

- [x] Define stable machine identity, device credentials, labels, platform facts, versions,
  capabilities, and heartbeat state
- [x] Add device pairing, revocation, and credential rotation to the daemon and protocol
- [x] Expose device revocation and rotation in a client or `domovoid` command
  - `packages/ui/src/client.ts` calls `device.revoke` and `device.rotate`, and the Fleet surface
    drives both. This duplicates the checked entry below it under paired-device management.
- [x] Add a fleet registry and machine selector to the shared protocol and UI
- [x] Implement one transport abstraction with this order:
  1. loopback or OS-private IPC;
  2. WSL interop to a distro daemon on the same machine;
  3. LAN connection;
  4. direct tailnet connection;
  5. SSH tunnel where explicitly configured;
  6. an end-to-end encrypted outbound relay when one is configured.
  - Direct selection and the relay slot ship. Nothing advertises or dials a relay yet; the open
    items below replace the earlier assumption that relay had to wait for the hosted Goal 3
    service.
- [x] Authenticate every connection even inside a tailnet
- [ ] Keep a daemon reachable while its tailnet or network identity changes through the encrypted
  rendezvous in `docs/encrypted-relay.md`
  - The Apache-2.0 daemon and clients dial a public route contract. The official relay app and
    operated service are separately licensed commercial components and see bounded ciphertext
    plus metadata, never Domovoi plaintext or endpoint credentials. A private dogfood deployment
    does not make the official relay a free self-hosted component.
  - Relay admission requires both the current paired-device bearer and proof of its channel key;
    the daemon root token is never valid on relay ingress. Pairing remains direct-only for the
    alpha.
- [ ] Prove the Node and phone crypto codec with deterministic vectors before freezing the Noise
  suite or public-key shape in protocol
- [ ] Make relay routes and capabilities a discriminated protocol contract
  - Relay v1 carries JSON-RPC and terminal traffic. Preview capability remains absent until an
    encrypted artifact-byte path exists, and clients read that absence from the route rather than
    maintaining their own list.
- [ ] Ship the generation-fenced outbound manager and separately licensed commercial relay app
  with bounded pre-authentication input, buffers, streams, idle time, and explicit backpressure
- [x] Bootstrap `domovoid` through a version-pinned install script that checks the archive against
  a caller-supplied SHA-256 and the `SHA256SUMS` the release publishes; signature verification is
  tracked under signed GitHub Release artifacts
- [x] Install and supervise the daemon for the user who asked, through a systemd user unit, a
  launchd agent, and a Windows logon task
  - `domovoid service install`, `status`, and `remove` ship in the daemon package. Nothing is
    written to a system-wide location and no step asks for elevation.
- [x] Implement WSL discovery and a `domovoi open .` Windows interop shim
  - Ships as `domovoid open`; no `domovoi` alias exists yet.
- [x] Keep all WSL filesystem and Git work inside the distro daemon, never through `\\wsl$`
- [x] Add fleet health, reconnect, version mismatch, and upgrade-required states
- [x] Add checkpointed machine transfer with live source and target preflight
- [x] Transfer worktrees through an incremental Git bundle first, with explicit opt-in to a remote
  ref workflow
- [x] Transfer dialog in the client with preflight, method, and what travels, calling
  `session.transfer`
  - `packages/ui/src/transfer-session-dialog.tsx` is wired into the workspace shell and
    `packages/ui/src/client.ts` calls `session.transfer`. This duplicates the checked entry below
    it that describes the same dialog.
- [x] Record transfer receipts and retain the source recovery checkpoint
- [x] Offer the move from the client: a transfer dialog that names the target machine, shows the
  source and target preflight, chooses between the Git bundle and a named remote ref, and states
  what travels with the session and what does not
  - The dialog ships and states what travels. What travels is less than a person would expect, so
    read the line below before trusting this one.
- [x] Carry session state, not only Git bytes, across a machine transfer
  - A move is previewed first and refused unless it carries the contract version and intent
    digest the preview returned, so a session that changed cannot move on a stale description.
    Coverage is reported by the daemon rather than described by the client.
  - Two machines can no longer both hold a writable copy: a target that already has the session
    freezes the source, conflicts record how they were found, and the only exit hands the session
    to the machine holding the verifiable ownership generation while leaving this machine's
    worktree readable. Nothing removes that worktree automatically.
  - An interrupted move is reconciled by the daemon itself. Operator recovery is offered only
    once the daemon records that it cannot reach the target, and the call rechecks the target
    before releasing anything.
  - The versioned transfer contract carries the repository and checkpoint, thread, artifacts and
    promoted artifact sources, annotations and crops, working plan, usage, and runtime settings.
    Provider credentials and state, terminals, approval rules, skill authority, audit history,
    ignored files, external databases, and Auto consent remain machine-local. The daemon reports
    these coverage keys and warnings to the dialog instead of relying on fixed client prose.
- [x] Record every attempted move in the thread as a receipt that names the reason the daemon
  refused rather than a generic failure
- [x] Add a Fleet surface listing machine platform, architecture, version, connection, health,
  capabilities, session count for this machine, and the transport order the dialer would use
- [x] Manage paired devices from the Fleet surface, with revocation behind a confirmation and
  credential rotation that shows the new credential once

Completion proof:

- one session can be controlled across two clients without divergent state;
- Linux, macOS, and Windows daemons pass pairing and reconnect tests; WSL interop is covered only
  by unit tests that stub `wsl.exe`;
- repository bytes never flow through a filesystem sync layer;
- revoked devices lose access promptly;
- a daemon remains reachable from a paired phone across private-network identity changes without
  exposing payload plaintext to the relay, and a bearer or channel key alone cannot enter;
- interrupted transfers recover without losing either worktree;
- a session can be moved to another paired machine from the client, and a refused move names the
  reason the daemon gave;
- paired devices can be revoked and rotated from the client without reaching for a terminal.

## Goal 3: ship hosted web, phone, and tablet control

Priority: `P2`. Make plan review and safe remote control work from iPad, phones, and guest browsers.

### Account and transport services

- [ ] OAuth/passkey account service
- [ ] Account-scoped device registry and short-lived client sessions
- [ ] Hosted, horizontally scalable deployment of the encrypted relay wire
- [ ] Preserve payload-level end-to-end encryption through the hosted relay while adding accounts
  and multitenant routing
- [ ] Relay protocol version negotiation, backpressure, reconnect, and resumable subscriptions
- [ ] Hosted usage, subscription, billing, and relay-entitlement management
- [ ] Device/session revocation and security-event history
- [ ] Recovery flow that does not give the service plaintext provider credentials

### Hosted client

- [ ] Browser `PlatformAdapter` for dialogs, notifications, credentials, clipboard, and install state
- [ ] Supply authenticated daemon credentials without embedding long-lived secrets in the bundle
- [ ] Select any paired machine and resume its daemon-owned sessions
- [ ] Full-fidelity plan/design preview on iPad, tablet, and phone
- [ ] Read, annotate, reply, resolve, and select variants from touch devices
- [ ] Review and decide approvals with every safety fact preserved
- [ ] Touch-capable terminal with explicit ownership transfer
- [ ] Push notifications for completion, failure, and approval-needed events
- [ ] Offline-safe read cache for previously opened plans, without offline command mutation

### Guest sessions

- [ ] Short-lived guest login with passkey or second-factor enforcement
- [ ] No persisted daemon tokens, project content, terminal history, or provider credentials after
  logout
- [ ] Guest session listing and immediate revocation from a paired device
- [ ] Distinct guest attribution in every audit receipt
- [ ] Enforce the approved guest hard-gate capability policy

## Goal 4: package and release the open core

Priority: `P2`. Every install channel must wrap the same immutable release.

### Release engineering and semantic versioning

Release tooling exists; no package is published from this repository yet. Finish this section
before any public package or application publish.

- [ ] Add Changesets and require release metadata for every publishable change before any public
  publish
  - Changesets, the `@getdomovoi/*` fixed version group, `pnpm changeset`, and `pnpm release:status`
    are in place.
  - The blocking pull-request gate lands with the publish workflow.
- [ ] Make `0.1.0-alpha.1` the first public alpha release
- [x] Keep package, app, daemon, protocol, and CLI versions in lockstep through `0.x`, and treat
  compatibility as one release unit
  - A fixed Changesets group moves every workspace version together.
  - `pnpm release:invariants` fails CI when a manifest version drifts.
- [ ] Automate Changesets version PRs, changelogs, Git tags, npm publishing with provenance, and
  GitHub Releases from the same immutable commit
  - `.github/workflows/release.yml` does all of this through Changesets and npm trusted
    publishing, gated on the same checks as CI, with the protocol published before the daemon.
  - It stays inert until the `RELEASE_PUBLISHING` repository variable is set; the npm
    organisation and trusted publishers do not exist yet. See `docs/distribution.md`.
- [ ] Add Homebrew and AUR publishing later, after signed and checksummed GitHub Release artifacts
  are stable

### Distribution and packaging

- [ ] Define compatibility, deprecation, and release-support policy
- [x] Verify npm artifacts install and run through npm, pnpm, and Bun
  - `pnpm test:install` packs the protocol package, installs the tarball with each package manager,
    and imports it; a missing package manager fails CI.
- [ ] Build signed desktop installers for macOS, Windows, and Linux
- [ ] Add macOS signing/notarization and Windows code signing
- [ ] Publish SHA-256 checksums and SBOMs for release artifacts
  - `pnpm release:artifacts` generates the tarballs, per-artifact CycloneDX SBOMs, and `SHA256SUMS`,
    and runs on Linux in CI.
  - The release workflow attaches them to each published package's GitHub release once enabled.
- [ ] Add a Windows package-manager manifest after installer signing is stable
- [ ] Choose and publish the Linux AppImage/native package set
- [ ] Add daemon and desktop update checks with explicit user control
- [ ] Add rollback and compatibility handling for daemon/client protocol mismatches
- [x] Pin GitHub Actions by immutable commit SHA, verified by `pnpm release:invariants`
- [x] Replace the no-op lint gate with real TypeScript/React linting
- [ ] Remove the artifact preview revision race in `apps/daemon/src/server.test.ts`
  - The signed print URL pins an artifact revision. Rewriting `preview.html` to exercise the
    nesting limit can raise the revision through the file watcher before the fetch arrives, so
    the daemon answers `404 not_found` instead of the expected `413 artifact_limit`.
  - Observed on macOS CI for pull request #221 on 2026-09-03; the same commit passed on `main`.
    Re-authorize after each write, or assert on whichever revision the daemon currently holds.
- [ ] Review or replace dependencies whose licenses do not fit the public daemon
  - `pnpm license:audit` holds the publishable production graph to a permissive allowlist in CI.
  - One recorded exception remains: the proprietary Claude Code agent SDK. See
    [docs/licensing.md](docs/licensing.md) for the removal options.
- [x] Move build-time tooling such as the shadcn CLI out of production dependency graphs

## Goal 5: public product and ecosystem

Priority: `P3`. Start only after the app surfaces and real product captures exist.

- [ ] Run a new design-studio exploration for the public site
- [ ] Approve positioning, information order, responsive behavior, light/dark treatment, and real
  product captures before implementation
- [ ] Build the marketing site at `domovoi.sh`
- [ ] Publish architecture, threat model, protocol, daemon installation, provider, and contributor
  documentation
- [ ] Publish an extension contract for tools and MCP integrations
- [ ] Add a reviewed skill directory only after the trust model is implemented
- [ ] Add opt-in diagnostics and crash reporting with local redaction controls
- [ ] Define contribution governance, maintainer policy, release signing custody, and cloud/core
  compatibility guarantees

## Post-MVP expansion

These are valuable but must not displace the secure single-user fleet workflow:

- [ ] encrypted client-side provider-key vault sync
- [ ] team organizations, roles, shared projects, policies, and audit retention
- [ ] hosted relay regions and enterprise self-hosting
- [ ] native iOS and Android shells where PWA limitations justify them
- [ ] native tablet multitasking and platform notification extensions
- [ ] provider routing policies based on cost, context, capability, and availability
- [ ] parallel agents in isolated worktrees with explicit merge/review workflows
- [ ] reusable session templates and automation schedules
- [ ] plugin marketplace and signed third-party integration bundles

## Unresolved product decisions

These remain decisions, not implementation tasks. Resolve them through an issue or RFC before the
dependent work starts.

1. **Provider handoff disclosure:** required pre-switch loss disclosure, safe-boundary behavior,
   and the warning difference between switch and fork.
2. **Skill signature authority:** choose the trusted signer registry, revocation source, and key
   custody model. Current `.sig` declarations are content-digest-bound but are not
   cryptographically verified, so a signature alone never grants trust. Manual review is the
   interim trust path: a person reviews an exact content digest on one machine, the daemon records
   that decision with the reviewing client, and the skill becomes trusted only while its content
   digest still matches. Any content change drops it back to untrusted. Cryptographic verification
   is still blocked on this decision, and an invalid signature stays blocked regardless of review.
   Deferred past the alpha on 2026-09-03: manual digest-bound review plus exclusion from Build auto
   is the alpha position, so the registry, revocation source, and custody model can be settled
   after it.
3. **Build auto execution boundary:** whether Build auto authorizes repository-controlled code to
   run unattended inside a containment boundary. An allowlisted runner executes files the
   repository owns, so a standing rule for `pnpm test` whose body stays `vitest run` still permits
   a changed `vitest.config.ts`, setup file, plugin, or test file to run with the daemon user's
   permissions, and no command pattern can see that. If the answer is yes, bounded has to mean
   bounded by sandbox and capabilities rather than by a list of trusted command names. If it is no,
    every package manager command is a hard gate and Build auto is narrower than this roadmap
    describes.
4. **Guest hard gates:** whether guest clients may approve migrations, deploys, or secret reads and
   whether each decision requires a second factor.
5. **Account requirement:** which local capabilities, if any, require a Domovoi account after the
   hosted service exists.
6. **Public site direction:** architecture-led or folklore-led narrative after real product
   screenshots are available.
7. **Packaging formats:** final Linux package set and Windows package-manager targets.
8. **Support policy:** stable release cadence, supported versions, protocol compatibility window,
   and security backport duration.

## Resolved architecture decisions

- Electron is the desktop shell; the shared React UI remains browser-capable.
- pnpm manages the monorepo; published ESM packages remain npm and Bun compatible.
- WebSocket JSON-RPC is the client/daemon protocol; gRPC is not required for the current surfaces.
- The daemon owns sessions, Git, tools, terminals, credentials, and canonical state.
- Code stays on its execution machine; Domovoi does not add a filesystem sync layer.
- Remote connectivity prefers direct private-network transport, then a configured end-to-end
  encrypted relay. The route protocol and daemon connection manager are Apache-2.0; the official
  relay implementation and operated service are separately licensed commercial components.
- SQLite is owned directly by the daemon; an ORM is not currently justified.
- Domovoi is open-core. The daemon, protocol, clients, and local transports are Apache-2.0; the
  official relay implementation and hosted account, billing, vault, and team services are
  separately licensed commercial components.
- Claude Design's app and brand handoffs remain the design source of truth.
- A session transfer is refused at the moment it is requested rather than queued, so a session never
  changes hands later and unattended. Transfer preflight refuses an unreachable target, a target
  that is not answering, a target on an incompatible protocol in either direction, a target that
  needs an upgrade, a target that does not run sessions, and the machine already holding the
  session. This resolves open question 1 in the signed design handoff, whose `UNREACHABLE` and
  unselectable treatment of offline machines already showed this path.

## First public alpha definition of done

The alpha is ready only when all of these are proven:

- Goal 0 is complete.
- Goal 1 is complete except direct API adapters that duplicate a capable subscription CLI.
- A signed desktop build can install, start, update, and remove its supervised local daemon.
- A new user can open a repository, start an agent, review tool activity, annotate a plan, approve
  or deny consequential work, restore a checkpoint, and reopen the session after restart.
- Every supported provider failure produces an actionable state without losing the worktree.
- No product surface claims remote fleet, hosted relay, mobile control, or account behavior that is
  not yet implemented.
- Installation and recovery documentation has been tested on Linux, macOS, and Windows.
