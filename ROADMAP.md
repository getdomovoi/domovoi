# Domovoi roadmap

This roadmap turns the signed product handoff, product contract, distribution contract, and the
2026-08-28 repository audit into an ordered delivery plan. It describes outcomes, dependencies,
and proof of completion. It does not replace `PRODUCT.md`, `DESIGN.md`, or the Claude Design
handoffs.

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
- [x] custom desktop window decoration with native platform fallback
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
- [ ] Recover Codex cleanly after its subprocess exits
- [ ] Add browser RPC response deadlines and cancellation
- [ ] Return stable public RPC errors while keeping internal exception detail in redacted logs
- [ ] Validate daemon environment configuration at runtime
- [ ] Tighten protocol aggregate references and JSON-RPC response invariants

Completion proof:

- adversarial authentication and authorization tests;
- timeout and race tests with late completions;
- bounded long-session measurements;
- clean shutdown recovery tests;
- Linux, macOS, and Windows CI.

## Goal 1: finish the local desktop alpha

Priority: `P1`. Produce a dependable single-machine Domovoi that can replace a terminal-only agent
workflow without becoming a code editor.

### Sessions and worktrees

- [x] Open a local Git repository and create a session worktree
- [x] Send, steer, stop, persist, and resume agent turns
- [x] Create and restore checkpoints with a recovery checkpoint
- [x] Change providers/models through a documented checkpointed handoff
- [ ] Prevent manual checkpoint creation while an agent is mutating the worktree
- [ ] Add a complete session history with filters for messages, tools, approvals, handoffs,
  checkpoints, annotations, and tests
- [ ] Expose worktree diff, changed-file details, and test evidence from real Git/tool state
- [ ] Add session archive and deliberate cleanup without deleting the source repository
- [ ] Add explicit fork-with-model beside switch-here behavior

### Providers and credentials

- [x] Codex CLI adapter
- [x] Claude Code adapter
- [x] OpenCode adapter
- [x] Kilo adapter
- [ ] Cursor Agent adapter
- [ ] Grok CLI adapter
- [ ] Provider account and readiness settings from the signed handoff
- [ ] OS-keychain storage for direct provider API keys and other secrets
- [ ] Direct API adapters where they add capabilities unavailable through subscription CLIs
- [ ] Token and cost telemetry normalized per turn, session, provider, and model
- [ ] Clear handling for provider rate limits, authentication expiry, quota exhaustion, and missing
  model access

### Permissions and auditability

- [x] Ask, Plan, Build manual, and Build auto controls
- [x] Approval cards with decision receipts and client attribution
- [x] Per-project standing approval rules
- [ ] Enforce hard gates that Build auto cannot bypass
- [ ] Add a searchable audit log with redaction and export
- [ ] Add command-level secret redaction before persistence or display
- [ ] Add a global emergency stop that cancels all active tools and providers, not only UI state

### Preview and review

- [x] Full-fidelity sandboxed HTML preview
- [x] Picker bridge and structured anchored annotations
- [x] Annotation replies and open/resolved lifecycle
- [ ] Detect new plan/design artifacts written inside the worktree without provider-specific events
- [ ] Preserve annotation anchors across document revisions with selector, text quote, and bounding-box
  fallbacks
- [ ] Capture cropped visual context for an annotation and pass it to vision-capable agents
- [ ] Add variant metadata, thumbnail filmstrip, device-width presets, and optional compare layouts
- [ ] Add chat-inline Markdown quick views while keeping generated HTML canonical
- [ ] Add print/share-safe plan rendering without weakening the preview sandbox

### Skills

- [x] Discover and deduplicate local skills
- [x] Show provenance, scope, exact path, metadata, and source
- [ ] Define capability manifests, content digests, signature state, and trust state
- [ ] Add reviewed per-project skill enablement
- [ ] Inject only enabled skills into provider session context
- [ ] Gate terminal-based skill installs through the normal permission system
- [ ] Define safe behavior for unsigned skills in Build auto
- [ ] Compare skill availability across machines without silently distributing executables

### Desktop quality

- [x] Shared Claude-handoff workspace and custom window decoration
- [ ] Persist layout, selected surface, project, and session safely across restarts
- [ ] Keyboard command palette for navigation and common session actions
- [ ] Native completion, failure, and approval-needed notifications
- [ ] OS file dialogs, deep links, clipboard behavior, and external-editor handoff
- [ ] First-run provider diagnostics and actionable recovery states
- [ ] Accessibility pass for keyboard, focus, screen readers, reduced motion, contrast, and zoom
- [ ] Performance budgets for startup, memory, long threads, terminal throughput, and large previews

## Goal 2: add private machine-fleet operation

Priority: `P1`. Keep code and execution on the selected machine while one client controls the
fleet.

- [ ] Define stable machine identity, device credentials, labels, platform facts, versions,
  capabilities, and heartbeat state
- [ ] Add device pairing, revocation, and credential rotation
- [ ] Add a fleet registry and machine selector to the shared protocol and UI
- [ ] Implement one transport abstraction with this order:
  1. loopback or OS-private IPC;
  2. LAN or direct tailnet connection;
  3. SSH tunnel where explicitly configured;
  4. outbound relay fallback after hosted services exist.
- [ ] Authenticate every connection even inside a tailnet
- [ ] Bootstrap `domovoid` through a version-pinned, checksummed install script
- [ ] Install and supervise the daemon through systemd, launchd, and Windows Services
- [ ] Implement WSL discovery and a `domovoi open .` Windows interop shim
- [ ] Keep all WSL filesystem and Git work inside the distro daemon, never through `\\wsl$`
- [ ] Add fleet health, reconnect, version mismatch, and upgrade-required states
- [ ] Add checkpointed machine transfer with live source and target preflight
- [ ] Transfer worktrees through an incremental Git bundle first, with explicit opt-in to a remote
  ref workflow
- [ ] Record transfer receipts and retain the source recovery checkpoint

Completion proof:

- one session can be controlled across two clients without divergent state;
- Linux, macOS, Windows, and WSL daemons pass pairing and reconnect tests;
- repository bytes never flow through a filesystem sync layer;
- revoked devices lose access promptly;
- interrupted transfers recover without losing either worktree.

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

- [ ] Establish versioning, compatibility, deprecation, and release-support policy
- [ ] Publish `@getdomovoi/protocol`, daemon, and CLI packages to npm with provenance
- [ ] Verify npm artifacts install and run through npm, pnpm, and Bun
- [ ] Build signed desktop installers for macOS, Windows, and Linux
- [ ] Add macOS signing/notarization and Windows code signing
- [ ] Publish SHA-256 checksums and SBOMs for release artifacts
- [ ] Add Homebrew formulae from immutable GitHub release artifacts
- [ ] Add AUR source and binary packages from immutable GitHub release artifacts
- [ ] Add a Windows package-manager manifest after installer signing is stable
- [ ] Choose and publish the Linux AppImage/native package set
- [ ] Add daemon and desktop update checks with explicit user control
- [ ] Add rollback and compatibility handling for daemon/client protocol mismatches
- [ ] Pin GitHub Actions by immutable commit SHA
- [ ] Replace the no-op lint gate with real TypeScript/React linting
- [ ] Review or replace dependencies whose licenses do not fit the public daemon
- [ ] Move build-time tooling such as the shadcn CLI out of production dependency graphs

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

1. **Offline machine transfer:** refuse immediately or queue with TTL, cancellation, source
   write-lock behavior, and divergence rules.
2. **Provider handoff disclosure:** required pre-switch loss disclosure, safe-boundary behavior,
   and the warning difference between switch and fork.
3. **Skill trust:** capability vocabulary, signature authority, privileged installation, unsigned
   Build-auto behavior, and fleet declaration semantics.
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
