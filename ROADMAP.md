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
- [ ] Clear handling for provider rate limits, authentication expiry, quota exhaustion, and missing
  model access
  - A failure classifier exists, but the Claude adapter drops the failure reason and provider
    stderr is discarded, so authentication and rate-limit failures surface as unknown/retry.

### Permissions and auditability

- [x] Ask, Plan, Build manual, and Build auto controls
- [x] Approval cards with decision receipts and client attribution
- [x] Per-project standing approval rules
- [ ] Stop translating a standing approval into provider-native persistence
  - `always-project` currently becomes `acceptForSession` in `apps/daemon/src/codex.ts`, `always`
    in `apps/daemon/src/opencode.ts`, and provider-suggested `updatedPermissions` in
    `apps/daemon/src/claude.ts`. The provider then answers later requests itself, where Domovoi
    cannot see, audit, or revoke the approval. Providers must receive allow-once only, and the
    daemon must own every standing rule. This blocks the fingerprint work below, and it would also
    let a retired rule keep approving through the provider.
- [ ] Key standing rules on a fingerprint of the resolved command rather than its text
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
- [ ] Enforce hard gates that Build auto cannot bypass
  - The recorded defect is fixed. `f137506` gates secret reads through Git, and
    `apps/daemon/src/permission-policy.ts` checks hard-gate patterns and skill installs before any
    Build-auto allowance. Do not redo that work.
  - This line stays open for the general claim, not the recorded example. Coverage today is a
    pattern list plus the skill-install check, and the tests at
    `apps/daemon/src/permission-policy.test.ts` and `apps/daemon/src/server.test.ts` cover examples
    rather than the invariant. Closing it needs a test asserting that no Build-auto path returns
    `allow` while a hard-gate pattern matches, including recursively resolved commands.
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

- [ ] Fleet screen with transport order, machine cards, version and `UPDATE` state, and Use,
  Terminal, and Revoke actions
  - Transport order, machine cards, pairing, revocation, and credential rotation ship in
    `packages/ui/src/fleet-view.tsx`. The Use and Terminal actions on a machine card are the
    remaining work.
- [x] Settings shell: Appearance & window (System, Dark, and Light theme; window decoration with
  system fallback), Permissions & rules, External editor, and Notifications
- [x] Cost and token readouts in the app bar and session header from `session.usage`
- [ ] Context occupancy readout beside those totals
  - `sessionUsageSchema` carries `contextTokens` and `contextWindowTokens`, and both are optional
    so a client shows the readout only when the provider reported the pair. No adapter populates
    them and no client reads them yet.
- [ ] Add-skill flow with declared-capability review and install scope
  - Deferred past the alpha on 2026-09-03, with the skill trust model it depends on. The protocol
    has no install, copy, or distribute RPC, and shipping a convenient installer for arbitrary
    code before the trust model exists is the wrong order.
- [ ] Editable working plan with per-step state in the Plan tab
- [x] Per-file diff review with revert in the Changes tab
- [ ] Composer skill chip
- [ ] Align the shell to the design-system geometry: 62px rail, 240px sidebar, 760px thread lane,
  280px inspector, and the fixed chrome heights recorded in `DESIGN.md`
- [ ] Vendor the Claude Design system tokens, specimen cards, and component prompts so the contract
  lives in the repository rather than only in the project
- [ ] Port the live terminal-pane restyle from the current design revision
- [x] Prompt-editor modal with prose and Markdown modes, inserts, and draft statistics

## Goal 2: add private machine-fleet operation

Priority: `P1`. Keep code and execution on the selected machine while one client controls the
fleet.

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
  6. outbound relay fallback after hosted services exist (slot reserved; nothing advertises or
     dials a relay until Goal 3 ships the service).
- [x] Authenticate every connection even inside a tailnet
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
- interrupted transfers recover without losing either worktree;
- a session can be moved to another paired machine from the client, and a refused move names the
  reason the daemon gave;
- paired devices can be revoked and rotated from the client without reaching for a terminal.

## Goal 3: ship hosted web, phone, and tablet control

Priority: `P2`. Make plan review and safe remote control work from iPad, phones, and guest browsers.

### Account and transport services

- [ ] OAuth/passkey account service
- [ ] Account-scoped device registry and short-lived client sessions
- [ ] Outbound daemon connection manager and horizontally scalable relay
- [ ] Payload-level end-to-end encryption between client and daemon
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
  - Attaching them to a GitHub Release waits on the release workflow.
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
- Remote connectivity prefers direct private-network transport and later uses an outbound relay.
- SQLite is owned directly by the daemon; an ORM is not currently justified.
- Domovoi is open-core. The daemon, protocol, clients, and local transports are Apache-2.0; hosted
  account, billing, relay, vault, and team services may remain separate.
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
