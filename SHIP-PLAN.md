# Domovoi — road to shipped

The one plan. It absorbed `ROADMAP.md` (the goal-by-goal delivery record, 2026-08-28 to
2026-09-14) and the task half of `WORK-SPLIT.md` on 2026-09-14, because three files that each
read as a backlog had already cost a measuring pass: usage accounting was `[x]` in one while the
other named four live defects in it. The rules, ownership and deferred decisions that
`WORK-SPLIT.md` earned survive verbatim in [`docs/working-rules.md`](docs/working-rules.md),
which is not a plan and holds no task ids. `PRODUCT.md`, `DESIGN.md` and the Claude Design
handoffs remain what this plan implements, not what it replaces.

**Codex** owns the daemon, the protocol and the relay server. **Claude Code** owns the
clients and the repo's own tooling. `[H]` marks work only a human can do — a decision, a
legal document, a vendor account, a certificate.

Task ids are stable and phase-prefixed (`S2.3`). They are cited outside this file, in commit
messages, pull request bodies and `getdomovoi/relay`'s `docs/server-boundary.md`, so an id is
never renumbered or reused. The roadmap's goals (`Goal 0` to `Goal 5`) folded into the phases
below; their ticked bullets keep their text and citations under the phase they served.

---

## Ticks are claims with a date

- `[x]` implemented and verified in the repository, citing the commit that verified it. A tick
  is a claim with a date: `[x] … (1b683d6)` is checkable by reading what that commit did;
  `[x]` alone is checkable only by trusting the prose beside it. `scripts/tick-citations.mjs`
  refuses a new tick without a citation and refuses a citation that is not an ancestor of the
  branch; `release:invariants` runs it on every push. Ticks that predate the rule are listed in
  `scripts/tick-citations-allowlist.json`, which only ever shrinks.
- A citation must resolve on a fresh clone of `main`. This repository merges by squash as well
  as by merge commit, and a squash replaces every in-PR sha, so a tick never cites a commit from
  the pull request that lands it: tick in a follow-up, citing the squash sha. A sha handed
  between agents names the ref it is reachable from, because a sha reachable only from a
  feature branch passes the checker on that checkout and fails everywhere else.
- A tick written by whoever did the work wants a second reader by default. On 2026-09-14 a peer
  read of the Phase 1 ticks found four errors, every one optimistic.
- `[ ]` not complete. An untrue `[ ]` is the sharper error: it sends an agent to start work that
  is finished.
- `[H]` a decision, document, account or certificate only a person can supply.

---

## How the two agents work this file

The rules that were earned by being broken live in [`docs/working-rules.md`](docs/working-rules.md):
one agent per file per session, protocol before the UI that reads it, `graft callers` before
editing an enum, mutation probes only against a shippable tree, never regenerate a digest in the
commit it covers, read the reviews not the check row, and the rest. Three more that this file
needs:

1. **An `[H]` gate stops the work, not the thinking.** When you reach one, draft the
   decision as options with consequences and stop. Do not pick. A gate reached with a
   written options doc costs a human minutes; a gate reached with an assumption already
   coded costs a rewrite.
2. **A check before a build.** Where a designed path has never been run end to end (`S3.0`),
   run it on real hardware and report a yes or a defect list before writing feature code for
   it. The answer decides how much of the remaining work matters.
3. **Long-lead items start out of order.** Certificates and an audit booking have calendar
   cost, not engineering cost. They sit in Phases 4 and 6 and they begin in Phase 0.

---

## Milestones, so there is something to cut against

| | Ships when | Excludes |
|---|---|---|
| **M1 · usable local product** | daemon installs as a service; desktop, web and phone reach it over loopback and the tailnet with no hosted service in the path; a phone answers a gate | relay, billing, teams, tablet |
| **M2 · hosted relay** | the relay carries machines that have no tailnet, metered and invite-only | billing, teams |
| **M3 · launch** | paid, metered, signed, audited | teams, tablet |
| **M4 · teams** | seats, org machines, org policy | — |

The MVP is M1: loopback and the tailnet only. A user with Tailscale uses Domovoi
desktop-to-phone with nothing hosted in the path. The hosted relay was always the
monetisation of the open core, added once the software is worth giving people an option that
avoids manual network setup; putting it in front of a usable product was backwards, and the
2026-09-14 restatement moved it behind M1 with its own gates.

If a task does not serve the next milestone, it waits.

### Transport is an ordered list, never a pair of branches

Route selection stays what it is: an ordered list of carriers, loopback then tailnet then
relay, with the daemon reporting which route it chose and why (`S2.2`). Nothing collapses that
into hardcoded loopback and tailnet branches. LAN is deliberately out of M1 and is a future
carrier under the same list, not a rewrite: the Noise IK handshake, identity pinning and
successor recovery built for the relay are exactly what make a LAN carrier cheap later, whereas
the tailnet sidesteps them by borrowing Tailscale's identity and certificates.

---

## Baseline: what the repository already proved

Carried from the roadmap's current baseline. These are the local vertical slice that every
phase below builds on.

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

---

## Phase 0 — the gates

Cheap now, expensive later. **Nothing in Phase 2 starts without S0.2 and S0.6.**

- [x] **S0.1 [H] The open-core line.** Which capabilities are Apache 2.0 and which are paid.
      Hard to reverse once published. **Resolved 2026-09-12: B (c158a4df).** The payload claim rests on
      client-side encryption with a reviewed composition, so closing the relay server costs the
      claim nothing. Record in `S0.2-RELAY-CRYPTO.md` §9. B's tier boundary is per-seat machine
      entitlement; the relay's connected-time meter supports entitlement and abuse control,
      not consumption-based invoice lines. That is why the server stays closed (`S0.6`): an
      open server has no enforcement point, the same argument that moved enforcement off the
      Apache-2.0 daemon in `S0.4`, one layer up. The two decisions depend on each other.
- [ ] **S0.2 [H] Relay crypto design, written and reviewed.** "Carries encrypted payloads it
      cannot read" is the product's central claim. Key exchange, forward secrecy, what the
      relay sees in the clear (it must see routing metadata), rotation, and recovery when a
      device is lost. Cannot be retrofitted.
      *Agents may draft: threat model, two or three candidate designs with tradeoffs, and
      what each implies for device loss.*
      **Design ruled 2026-09-12: suite A, `Noise_IK_25519_ChaChaPoly_SHA256`, our own
      composition reviewed (R-A); `S0.2-RELAY-CRYPTO.md` §9, final.** Stays open until the review lands: budget line $25k to $50k
      estimated (§7a), quote pending the `S0.7` firm conversation. The review is external
      work: its record is a dated engagement letter and a dated report, named here when they
      exist; until then the state is not started, not an unticked box.
- [ ] **S0.3 [H] What the relay retains.** Entitlement, abuse control and audit require
      records of which machines were connected and for how long, not usage-based invoices.
      Machines are priced per seat. "Payloads unreadable" and "nothing recorded"
      are different claims. State both halves publicly.
- [ ] **S0.4 [H] How tier enforcement is trusted.** Free is JSON-RPC only and the *daemon*
      refuses the terminal, so the daemon must learn its tier and verify it. Signed tier
      claims the daemon checks, or the refusal is advisory and the paywall is decorative.
- [ ] **S0.5 [H] The four open product decisions.** External work: the record is a date and
      an artefact, not a box. `HANDOFF-NOTES.md` is a file in the Claude Design project, not in
      this repository, so the four are restated here. 1. Transfer to an offline target:
      not started, no artefact. 2. What the handoff UI may promise: not started, no artefact.
      3. Skill install trust: ruled 2026-09-10 by the maintainer, "a changed skill drops to
      untrusted", recorded under "From the work split: client items" below. 4. Guest browser
      session scope: not started, no artefact.
- [x] **S0.6 [H] Where the relay lives.** Follows S0.1. Until it is answered, the relay has
      no directory and Phase 2 cannot be scaffolded — `apps/relay` in this monorepo and a
      separate private repo are different answers about what ships open. **Resolved
      2026-09-12 (c158a4df): separate private repository for the relay server; `packages/protocol/relay/`
      keeps the wire format and the client side open.** Created 2026-09-13 as
      `github.com/getdomovoi/relay`. **The relay is hosted only, permanently.** Not a preference: the
      tier meter lives in the server, so an open server has no enforcement point, and hosting is
      what funds the project. Trust is unaffected: payload unreadability is a property of the open
      clients under suite A; the metadata claim rests on `S6.1`'s audit. Self-hosting, if ever, is a
      paid licence of the same code with the meter intact, never a source release.
- [ ] **S0.7 [H] Start the long-lead clock.** Apple Developer enrolment, Windows
      code-signing certificate, and a first conversation with an audit firm. Weeks of
      calendar, zero engineering. External work, recorded by date and artefact: Apple
      enrolment, not started, no artefact in the repository; Windows certificate, not started,
      no artefact; audit firm conversation, the maintainer reported it as sent to firms on
      2026-09-14 in the design project's `github.md`, no artefact in this repository. When one
      exists, name it here (an enrolment id, an order reference, a dated quote).

## Phase 1 — the daemon becomes an installed service — M1

Parallel with Phase 0. Touches nothing the gates decide.

- [ ] **S1.1 [CX]** Service lifecycle per platform: launchd, systemd, Windows service, and
      WSL's init gap. Built, not accepted: #367 (617ac46d) carries the per-user LaunchAgent,
      the per-user systemd unit, and on Windows a limited-user `ONLOGON` scheduled task
      registered by `service/install.ts`, with `windows-task.ts` for its status and removal.
      `docs/service-lifecycle-assessment.md` keeps the box open. WSL selection is wired
      into `service install`; its new CLI native proof is pending. The guest-loop
      restart/removal repairs passed native run 35268866928 at b36f4c9f, superseding
      the failed task-managed restart assertion, not erasing it. Actual logon acceptance
      remains open, as do the separate native Windows crash-supervision and Linux
      login/logout/boot policy decisions. Tick when the assessment says so.
- [x] **S1.2 [CX]** Version negotiation. A v0.9 client against a v1.2 daemon refuses
      clearly rather than half-working. The hello refuses with
      `protocolVersionMismatchErrorCode` (56c6dce3, `server.ts`); exact version parsing and
      patch-compatible snapshots in 91b1e157, the same admission checks shared by the daemon
      and its machine socket in 86891409.
- [x] **S1.3 [CX]** Crash recovery: an interrupted turn, a half-written worktree, an
      orphaned transfer lease. Interrupted turns reconcile at startup (00e6c678, #113), interrupted
      and half-written session creation with it (42c4403e, #372), and transfer ownership and
      receive leases recover on retry or release when abandoned (b5b1aa90, a6294547).
      `docs/crash-recovery.md` states the bounds: no provider turn is replayed and no
      uncommitted work is discarded.
- [ ] **S1.4 [CX]** Auto-update, signed and verified. A self-updating daemon holding your
      credentials is a supply-chain target, so signature verification and reproducible
      builds ship *with* it, not after. On `main` as of 2026-09-15: the design with the
      maintainer's four decisions (#411, 9539ba01), the protocol contract (#421, 2b21f855),
      discovery and verification (#422, 800de19e), staging and the bundled installer (#425,
      ef914793). All three code slices had zero callers when they merged: no `update.*`
      handler dispatches them and no scheduler runs them, so as of this line the feature is
      built and unreachable. The handlers are the next slice.
      Two records so they are not rediscovered. Deviation: the verifier in
      `apps/daemon/src/update-verification.ts` is a hand-rolled TUF client where the design
      requires a conforming library; recorded in `docs/daemon-auto-update-design.md`, to be
      removed or explicitly accepted before activation ships. Ownership: reproducible builds
      are named here and in `S4.6`; `S4.6` owns the two-clean-build comparison and its release
      record, and this item consumes it as an activation precondition. Not fixed here.
- [x] **S1.5 [CX]** Log rotation, and the count-based audit retention (10k activity, 1k
      pre-auth) proven across restart. Landed as #374 (c8eb1a93).
- [ ] **S1.6 [CX + CC]** CLI to parity: install, status, pair, doctor, skill push, logs.
      Five of six landed. `domovoid service install` and `domovoid service status` are the
      daemon's (`apps/daemon/src/index.ts`). The user-facing `domovoi` binary is `apps/cli`:
      `pair` and `status` (95711761), `doctor` (83f1406d), `logs` (d81ef5c9), and
      `skill install <path>`, a reviewed local copy. `skill push` is the open sixth:
      `docs/cli-parity-decision.md` says local copying does not establish remote
      distribution, and no push command or RPC exists on `main`. The 2026-09-10 note that no
      `domovoi` binary existed was true when written and is superseded by `apps/cli`.
- [x] **S1.7 [CX]** The accounting and turn-record work lands here — it is daemon bookkeeping and it
      unblocks UI in Phase 3. Usage accounting (4359bcf9) and turn records (e7364720,
      84d90d50, 1991666a); the detail is under "From the work split" below.

### From the roadmap: secure and bound the local core (Goal 0, done)

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

### From the roadmap: the local desktop alpha (Goal 1)

Priority: `P1`. Produce a dependable single-machine Domovoi that can replace a terminal-only agent
workflow without becoming a code editor.

#### Completion-audit remediation ledger

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

#### Sessions and worktrees

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

#### Providers and credentials

- [x] Codex CLI adapter
- [x] Claude Code adapter
- [x] OpenCode adapter
- [x] Kilo adapter
- [x] Cursor Agent adapter
- [x] Grok CLI adapter
- [x] Provider account and readiness settings from the signed handoff
- [x] OS-keychain storage for direct provider API keys and other secrets
- [x] Let a client discover a provider's models and a default runtime before a session exists
  - `runtime.discover` (#326) is read-only, scoped to the execution machine and the provider the
    caller names, and answers with no project open. A ready result carries the provider's models,
    a `defaultRuntime` bound to one of those models and its default reasoning effort, the
    permission modes the adapter supports, and whether Auto is available. Auto requires Build, and
    the returned default always has Auto off.
  - An unavailable result carries one of seven reasons, each with the fixed action, retryability,
    and message the protocol pins to it, so a client shows sign-in, install, retry,
    choose-provider, or configure rather than an unknown failure. Readiness, connection, and
    catalog share one `maximumRuntimeDiscoveryMs` budget of 10 seconds.
  - There is no cross-machine fallback, no global preferred provider, and no project-scoped
    catalog. `packages/protocol/README.md` documents the call for the phone and tablet clients.
- [ ] Direct API adapters where they add capabilities unavailable through subscription CLIs
  - Only OS-keychain key storage ships; `docs/provider-capabilities.md` lists no direct adapter.
  - Deferred past the alpha on 2026-09-03. `PRODUCT.md` line 41 commits to subscription-backed
    provider CLIs first, so this is not alpha scope.
- [x] Token and cost telemetry normalized for Anthropic, per session and provider
      (76a9cb2 · session totals 2508149 · cached-token fold 3d92b6f)
  - [ ] OpenCode undercounts: `tokens.cache.read` lands in `cachedInputTokens`
        and never reaches `inputTokens` or `totalTokens` — the fold is
        Anthropic-key-only by design (`opencode.ts:506`)
  - [ ] `acp.ts:295-296` assigns `totalTokens` and `contextTokens` the same
        `update.used`
  - [ ] Usage is stamped with `session.runtime.model` at write time, so an arrival
        after a same-provider switch gets the new model (`server.ts:6903`,
        switch at `5835`)
  - [ ] Per-turn attribution needs the durable turn link, which does not exist
        (WORK-SPLIT `CX2`)
- [x] Session token totals and provider-reported cost in the client, with a per-runtime breakdown
  and an explicit count of turns the provider reported no cost for
- [x] Usage totals across sessions over a time window, such as a today total in the app bar
  - The ledger stamps each row with the time its turn was first recorded, `usage.window` sums
    tokens, reported cost, turns, and sessions between two instants with one query, and the app
    bar reads today's total in the viewer's local day. Rows recorded before the stamp existed and
    rows imported by a transfer carry no time, so they never count toward a window, and a window
    whose reported costs span more than one currency shows tokens rather than a summed cost.
- [x] Clear handling for provider rate limits, authentication expiry, quota exhaustion, and missing
  model access
  - The Claude adapter keeps a bounded, redacted tail of provider stderr and preserves the
    reported error, so each condition reaches a client as its own classified failure rather than
    unknown/retry. Outgrowing the context window is its own `context-window-exceeded` kind, which
    is not retryable, so no client offers a retry that cannot succeed.

#### Permissions and auditability

- [x] Ask, Plan, Build manual, and Build auto controls
- [x] Approval cards with decision receipts and client attribution
- [x] Per-project standing approval rules
- [x] Stop translating a standing approval into provider-native persistence
  - `always-project` used to become `acceptForSession` in `apps/daemon/src/codex.ts`, `always` in
    `apps/daemon/src/opencode.ts`, and provider-suggested `updatedPermissions` in
    `apps/daemon/src/claude.ts`. The provider then answered later requests itself, where Domovoi
    could not see, audit, or revoke the approval.
  - Providers now receive allow-once only. Every adapter maps both `allow-once` and
    `always-project` to a single accept for that one request, and
    `apps/daemon/src/agents.ts` types the provider decision as
    `Exclude<ApprovalDecision, "always-project">`, so the standing form cannot reach a provider
    at all. The daemon owns every standing rule, and a retired rule stops approving immediately.
- [x] Key standing rules on a fingerprint of the resolved command rather than its text
  - A rule used to match on `projectId` and the literal command, so it kept approving a script
    whose body had since changed. `packages/protocol/src/execution.ts` now defines the resolved
    execution record a rule is keyed on: the normalized command, the project-relative directory,
    recursively expanded script bodies, lifecycle scripts such as `pretest`, and the validated
    runner arguments. A command whose resolution is ambiguous stays reviewable but cannot be
    reused. The record declares its own `command-and-script-text` coverage, which is the honest
    bound on what it proves.
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
  - `audit.query` and `audit.export` bounded their store reads with `agentTimeoutMs`, so a test
    daemon with a 5 ms agent budget timed a real read out on macOS CI. #250 gives them their own
    `auditReadTimeoutMs`, default 30 s, through the same deadline validation, and is merged.
- [x] Add command-level secret redaction before persistence or display
- [x] Add a global emergency stop that cancels all active tools and providers, not only UI state

#### Preview and review

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

#### Skills

- [x] Discover and deduplicate local skills
- [x] Show provenance, scope, exact path, metadata, and source
- [x] Define capability manifests, content digests, signature state, and trust state
- [x] Add a manual-review trust path that binds trust to the reviewed content digest and records
  the reviewing client in the audit log
- [x] Verify skill signatures and produce a trusted state
  - A `SKILL.md.sig` is an Ed25519 signature over the skill's content digest. The daemon verifies
    it when the catalog loads, and again when a skill file, its `.sig`, or the trust file changes,
    against `~/.domovoi/skill-trusted-keys.json`, an owner-only file that only
    `domovoid skill trust` writes. A signature from a listed key yields `trusted`; a key the file
    does not list stays `unverified`; a signature that fails, or content changed since signing, is
    `invalid` and blocked. `domovoid skill keygen` and `domovoid skill sign` make and apply keys.
  - Selection is unchanged: Build auto still requires `trusted` and other modes still refuse
    `blocked`. The delivery record on a sent turn now names the trust state each skill carried.
  - Still open under unresolved decision 2: a signer registry, a revocation source, and key
    custody beyond a local file. Trust is per machine and per trust file until those are decided.
- [x] Add reviewed per-project skill enablement
- [x] Inject only enabled skills into provider session context
- [x] Gate terminal-based skill installs through the normal permission system
- [x] Define safe behavior for unsigned skills in Build auto
- [x] Define the skill inventory contract and comparison model without distributing executables
- [x] Fetch inventories from admitted reachable fleet members and compare them
  - Opening Skills calls `collectFleetInventories` through separate, verified client credentials.
    Each reader checks machine identity and the pinned device receipt, with a bounded connect
    and read. No machine keychain secret reaches the client. Unadmitted or unavailable members
    remain `unknown` or `unreachable`; metadata only travels, never skill files or trust.
  - `fleet-client-smoke.mjs` drives the real Desktop renderer against two production-built
    daemons and checks the admitted inventory exchange and rendered machine comparison.
    Linux execution is proven locally; the same proof is in the Desktop launch check for CI.

#### Desktop quality

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

#### Handoff surfaces from the desktop handoff

The desktop handoff specifies these and `main` implements them. Where a surface stops short of
the mockup on purpose, the note under it says so.

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
    so a client shows the readout only when the provider reported the pair. The Codex, Claude, and
    ACP adapters report the pair, and `SessionUsageFooter` in `packages/ui/src/workspace-shell.tsx`
    renders it beside the session totals.
- [x] Add-skill flow with declared-capability review and install scope
  - `skill.installPreview` reads a folder on the execution machine and returns its manifest,
    digests, signature and trust state, files, and per-scope targets; `skill.install` copies it
    into `~/.domovoi/skills` or `<project>/.domovoi/skills` only when the folder's digest still
    matches the preview, refusing a blocked skill, a link that leaves the folder, and a name that
    already exists with different files. The copy is staged and renamed inside the root, and every
    install is audited. The Skills surface reviews the capabilities, trust, and scope before
    Install, and `domovoid skill add` does the same from a terminal.
  - Still local only: no bundle, URL, installer command, or other-machine source, and no fleet
    push. Installing grants nothing; enablement review and trust are unchanged.
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
- [x] Give the prompt composer a total budget and a documented drop order
  - `apps/daemon/src/prompt-composer.ts` assembles skills, annotations, working plan, handoff, and
    user text in one place, and `apps/daemon/src/prompt-composition.golden.test.ts` pins all
    sixteen section combinations byte for byte. Since #257 the composer measures the whole rendered
    prompt against one budget rather than each section against its own limit, and drops one item at
    a time in the exported `elasticPromptDropOrder`: project-default skills, open annotations, then
    handoff history, annotations, and artifacts.
  - Required sections are measured first, so a turn whose user text and explicit selections alone
    exceed the budget is refused with those sections and their remedies named rather than quietly
    trimmed. `apps/daemon/src/server-prompt-budget.test.ts` drives a real daemon over a socket and
    asserts both the reported budget and that refusal.
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

### From the roadmap: private machine-fleet operation over the tailnet (Goal 2)

Priority: `P1`. Keep code and execution on the selected machine while one client controls the
fleet.

The second pass found that the protocol, stores, views, and unit-tested helpers are real, but the
production assembly has never enrolled or refreshed a second machine. A checked component is not
completion evidence for an outcome. Six green-test gaps exposed the pattern: a component never
rendered; CLI tests stubbed the socket handshake; fleet tests seeded remote rows; Desktop smoke
bypassed its daemon; service tests replaced OS managers; and WSL tests replaced `wsl.exe`. Goal 2
remains open until production-boundary acceptance proofs exercise those assemblies.

#244 closed the headline gap on 2026-09-05. `apps/daemon/src/fleet-production.test.ts` builds two
daemons through the production factory, with no seeded fleet row and no mocked registry or socket,
and takes them through code issuance, enrollment, refreshed target facts after restart, revocation
health, and a session move. The OS keyring and provider readiness are injected there, so it is not
evidence of platform keychain behaviour or cross-host TLS, and no two physical machines have been
paired.

The parked `MachineCredentialStore.forget()` finding is closed with it: `fleet.forget` stages the
removal, attempts a bounded revocation on the target, then removes the row and the keychain entry,
and the receipt says whether the target confirmed before replying.

Audit item G2 now has a real Electron launch proof. `pnpm --filter @getdomovoi/desktop test:launch`
uses normal Desktop acquisition and the production factory in a fresh profile on an ephemeral
loopback port. The renderer pairs a client, authenticates it, reads the workspace and revokes it;
the runner independently checks the persisted device record and released owner after exit.
This covers Desktop assembly, IPC, CSP and local authenticated RPC, not native machine-keychain
enrollment, cross-host transfer or a provider turn. See `docs/desktop-launch-smoke.md` for limits.

#### Assembly remediation ledger

Live-verified against `getdomovoi/domovoi` on 2026-09-05 (America/Boise):

- [#244](https://github.com/getdomovoi/domovoi/pull/244) `Enroll a second machine end to end`
  `MERGED`: daemon-to-daemon enrollment through `fleet.enroll`, `fleet.forget`, `fleet.heartbeat`,
  and the uncoalesced `fleet.changed` snapshot; the route pairing used is stored as a
  source-verified route and dialed first; admission is capped at 128 machines and display at 512
  entries, where a larger keychain refuses `fleet.list` with a typed overflow error and
  `domovoid fleet-keychain` is the local escape; `pairing-required` and
  `credential-store-unavailable` health states. Protocol `0.4.0`.
- [#245](https://github.com/getdomovoi/domovoi/pull/245) `Claim bundle restores before any git work`
  `MERGED`: a process-local reservation plus an exclusive `.restore-claims/<session-id>` file
  holding an ownership token, so two restores of one session cannot both succeed; cleanup failures
  surface as `SessionRestoreClaimCleanupError` without hiding the restore outcome.
- [#246](https://github.com/getdomovoi/domovoi/pull/246)
  `Stop starving daemon tests on the Windows runner` `MERGED`: `maxWorkers` 2 on win32, trimmed
  heavy fixtures, and every default `vi.waitFor` in the daemon suite routed through `waitForDaemon`,
  bounded at 10 s on Windows and 3 s elsewhere, with a guard test that refuses new direct waits.
  Test only.
- [#249](https://github.com/getdomovoi/domovoi/pull/249) `Bound the enrollment test waits`
  `MERGED`: the four waits #244 added that the #246 guard caught once both were on `main`. Test
  only.
- [#247](https://github.com/getdomovoi/domovoi/pull/247)
  `Bound pairing claims and isolate pre-auth audit retention` `MERGED`: audit item A2. Claims are
  admitted before code validation, 3 per source and 30 per listener within 60 seconds, and
  unauthenticated audit events keep their own 1000-entry class so refused claims cannot evict
  authenticated receipts.
- [#248](https://github.com/getdomovoi/domovoi/pull/248)
  `Add device.rename for paired device labels` `MERGED`: label only, 1 to 128 characters shared
  with the pairing label limit, audited like `device.revoke`.
- [#250](https://github.com/getdomovoi/domovoi/pull/250) `Give audit reads their own deadline`
  `MERGED`: `audit.query` and `audit.export` read under their own `auditReadTimeoutMs` instead of
  `agentTimeoutMs`, after a macOS run of #245 timed a real audit read out under a 5 ms agent budget.

Every ledger entry is now merged.

- [x] Define stable machine identity, device credentials, labels, platform facts, versions,
  capabilities, and heartbeat state
  - The schemas, `machine.json` identity, and local facts exist, and since #244 the daemon keeps
    one authenticated socket per remote row with a fifteen-second heartbeat. One production
    factory now serves both entry points: Desktop reaches a daemon only through
    `acquireLocalDaemon`, which builds the same runtime from the same `machine.json`, so no
    separate Desktop fallback identity remains. Startup reconciliation refuses to start when the
    stored workspace names a different machine, and on a match it replaces the stored name,
    platform, architecture, and version with this executable's current facts while keeping
    provider readiness. `apps/daemon/src/fleet-production.test.ts` restarts a peer over its own
    real profile through that factory and asserts the source sees the renamed label.
    `apps/daemon/src/fleet-machine-facts.test.ts` gives the first production boot older OS and
    build facts, verifies it persisted them, then restarts the same profile with current facts.
    Platform, architecture and version refresh in the local workspace, local fleet row, enrolled
    peer heartbeat and persisted snapshot, while `machine.json` and the machine ID stay stable.
    Removing each field's refresh independently makes this proof fail.
- [x] Add device pairing, revocation, and credential rotation to the daemon and protocol
  - Audit item F5: machine claims now grant only a five-minute confirmation capability. The
    source journals and reads back its keychain token before confirmation activates it; a lost
    confirmation reply is replayable after restart. Pending tokens cannot authenticate or retire
    previous machine authority, and expired claims never activate. Protocol 0.5 requires updated
    peers but leaves existing active pairings intact. Production-socket tests cover failed local
    storage, target restart, expiry, and source recovery after a committed but unanswered confirm.
  - Audit item F3. `domovoid pair` and `domovoid open` spend one 15-second deadline across
    connect, `system.hello`, and the call, so a listener that accepts the socket and then says
    nothing is refused with the address waited on and a remedy rather than holding the terminal.
    Both a complete reply and a refusal drop the one-shot transport, without a new close-handshake
    wait after the command deadline clears. Real child-process tests require natural exit against
    a stalled TLS handshake and against a peer that answers RPC but withholds its close reply.
- [x] Bound pairing claim admission and keep pre-auth noise out of authenticated audit history
  - Audit item A2, closed by #247. Claims are admitted before code validation: 3 per TCP source
    and 30 per listener within 60 seconds, and reconnects, forwarding headers, new codes, and
    bearer greetings cannot reset them. Unauthenticated audit events keep their own 1000-entry
    class. The five wrong guesses rule stays, and throttling cannot guarantee pairing availability
    against hostile peers.
- [x] Expose device revocation and rotation in a client or `domovoid` command
  - `packages/ui/src/client.ts` calls `device.revoke` and `device.rotate`, and the Fleet surface
    drives both. This duplicates the checked entry below it under paired-device management.
- [x] Add a fleet registry and machine selector to the shared protocol and UI
  - Closed by #244. `fleet.enroll` owns the claim and target facts, then confirms and authenticates
    on a new socket only after durable local storage; the heartbeat refreshes the row; and the two-daemon
    production test takes enrollment through restart without registry seeding. Each enrollment
    and forget is journaled by credential digest and promoted or rolled back on restart, because
    SQLite and the OS keychain cannot be atomic.
- [x] Admit a client to an enrolled remote daemon before enabling Fleet Use or Terminal
  - Authenticated fleet enrollment establishes daemon-to-daemon authority only. It does not
    grant the initiating desktop a remote client credential. Authorize this client explains the
    separate target command and full ordinary session, approval and terminal authority. Use and
    Terminal enable only after the machine identity and kind-bound client receipt verify.
  - Desktop main verifies the enrolled route through the home daemon, then grants one exact
    worker socket origin. The packaged app uses an explicit bundled-resource origin so CSP is
    enforced. Real Electron proofs cover origin refusal, Use, Terminal, inventory and removal.
    App-memory retention does not revoke on the target; the UI names its Devices list. Remote
    HTTP previews need a separate verified frame path and remain explicitly unavailable.
    Direct phone-to-daemon client pairing is unchanged. See `docs/fleet-client-admission.md`.
- [ ] Implement one transport abstraction with this order:
  1. loopback or OS-private IPC;
  2. WSL interop to a distro daemon on the same machine;
  3. LAN connection;
  4. direct tailnet connection;
  5. SSH tunnel where explicitly configured;
  6. an end-to-end encrypted outbound relay when one is configured.
  - Direct selection and the relay slot ship. Nothing advertises or dials a relay yet; the open
    items below replace the earlier assumption that relay had to wait for the hosted Goal 3
    service.
  - The base schema, preference order, and bounded client/daemon fallback loops exist. Production
    now produces local, LAN and explicitly configured TLS tailnet advertisements. Source-local
    configured SSH forwards follow direct candidates without becoming target-authored facts or
    permanent remembered routes. Production socket tests cover TLS descriptor publication,
    transfer over a configured loopback endpoint, forget masking and configuration removal.
    They do not prove an external tailnet or an SSH process. Windows now produces source-local
    WSL candidates only after a paired daemon answers with the expected identity. The required
    hosted WSL 2 job proves real enrollment, heartbeat, authenticated dialing, stale-endpoint
    refusal and stopped-distro refusal: fifteen proofs passed, zero skipped, in run 34017787075.
    This closes the WSL producer part of D3/I6, not multi-distro routing, guest service supervision,
    mirrored networking, VPNs or a session transfer through that route. Relay stays
    deferred under Goal 3. Client and daemon dialers reserve a share of the remaining overall
    deadline for each eligible route. Real socket tests prove fallback after silent upgrade and
    hello, with typed timeout refusals and losing-attempt cancellation. These bounds and their
    runtime disposal limits are documented in `docs/fleet-routing.md`.
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
- [x] Prove the Node and phone crypto codec with deterministic vectors before freezing the Noise
  suite or public-key shape in protocol (531a46b6)
  - **Frozen 2026-09-13 at `531a46b6` (#376):** suite A, `Noise_IK_25519_ChaChaPoly_SHA256`, one
    noble composition published at `@getdomovoi/protocol/relay`. The wire format is pinned by
    committed static fixtures (`packages/protocol/relay/testing/wire-layout.json`,
    `wire-frames.json`) whose digests are recorded in `docs/relay-wire-format.md` and asserted by
    test; a byte change fails the suite. The `node:crypto` backend is a test-only second reader.
    P-256 and AES-GCM paths are removed. External cryptographic review of that head is
    outstanding (`S0.2-RELAY-CRYPTO.md` §7a, §9). Real Hermes or on-device execution, relay
    admission, framing and key storage remain open.
  - Phone-side key custody is proven for P-256. `apps/mobile/modules/domovoi-device-key` generates
    the static key inside the platform key service and never returns it, and the probe in
    `apps/mobile/src/lib/device-key.ts` checks the key by agreeing against a software key and
    requiring both shared secrets to match. On a Pixel 10 running GrapheneOS the run reported
    `strongbox` custody, a 65 byte public point, a handle that survived a reopen, and a 32 byte
    shared secret identical on both sides. An Android emulator on API 36 passes the same steps and
    reports `software`, which is what an emulator can offer.
  - Building that probe found the divergence the vector work is for: Hermes has no WebCrypto, so a
    pure JS codec calling `crypto.getRandomValues` throws on a phone while passing under Node. The
    probe takes its randomness from the platform key service instead. Vectors run by two Node
    runners cannot catch this class of defect.
  - Still unproven: iOS. Secure Enclave needs an Xcode 26 build, Expo SDK 57 is written in Swift
    6.2, and Xcode 26 requires Apple Silicon, so the Intel Mac available here cannot build the app
    at all. One Android device is also not a fleet.
  - Node 22 measurements compare option A's X25519/ChaChaPoly with option C's P-256/AES-GCM
    using built-in crypto, published A/B fixtures and explicitly derived P-256 fixtures. Full IK,
    daemon responder and established-frame costs are recorded for one Intel Linux host in
    `docs/relay-node-benchmarks.md`. Phone costs and protected key-service latency remain open;
    this does not freeze a suite or supply real phone-runtime evidence.
- [ ] Make relay routes and capabilities a discriminated protocol contract
  - Relay v1 carries JSON-RPC and terminal traffic. Preview capability remains absent until an
    encrypted artifact-byte path exists, and clients read that absence from the route rather than
    maintaining their own list.
  - Capability policy does not depend on the crypto choice, but an accepted relay descriptor must
    validate its suite and responder pin. The existing kind discriminator keeps relay unavailable
    with no capabilities. The complete route contract waits for a reviewed production Noise
    integration and evidence for phone native key operations to settle the suite/key constraints;
    a capability list or permissive channel placeholder does not close this item. See the exact
    unblock conditions in `docs/encrypted-relay.md`, Public route descriptor.
  - The approved September 7 priority moves this relay work ahead under Goal 3 while Goal 2 stays
    open. The remaining Goal 2 evidence is not solely hardware: its Windows logon task still has
    no crash restart. That supervision gap is recorded separately from the physical-machine and
    cross-host TLS proofs.
- [ ] Ship the generation-fenced outbound manager and separately licensed commercial relay app
  with bounded pre-authentication input, buffers, streams, idle time, and explicit backpressure
- [x] Install a frozen daemon runtime from a version-pinned release archive, checked against a
  caller-supplied SHA-256 and the `SHA256SUMS` the release publishes; signature verification is
  tracked under signed GitHub Release artifacts
  - `node scripts/bootstrap-daemon.mjs <version> <baseUrl> <destination> <expectedSha256>` streams
    and verifies the archive into `<destination>/v<version>`, stages it privately, materialises its
    embedded integrity lock as `package-lock.json`, runs bundled npm 10.0.0 or newer with `npm ci`,
    verifies the installed graph, permits only the reviewed `node-pty` native build, and publishes
    a `runtime.json` receipt naming the installed directory. Same-release protocol bytes are bound
    inside the archive; provider SDKs are fetched, not bundled. Download, installation, native
    build, verification, and publication share five minutes. Removing an unpublished staging tree
    afterwards runs under its own fresh 30 seconds, never the exhausted budget.
  - HTTPS downloads add a 30-second byte-progress inactivity allowance within that total.
    Redirects and empty chunks do not renew it; local disk backpressure spends only the total.
    Deterministic and real HTTPS regressions reject silent or late responses. Refusal does not
    promise immediate socket disposal: Node may retain a stalled TLS connection until its own
    connect timeout, delaying CLI exit. See the transport limits in `docs/distribution.md`.
  - Fresh musl or unknown-libc Linux installs force the reviewed node-pty source build rather
    than selecting an unqualified Linux prebuild. Native loading is checked before publication
    and on reuse. Ubuntu CI's pinned Node 22 Alpine smoke installs the real archive, opens a PTY,
    and authenticates against the production daemon; other musl architectures remain unproven.
  - What lands is an installed runtime tree, not an installed command. The result's `runtimePath`
    is run as `node <runtimePath>/dist/index.js`. Nothing creates a `domovoid` entry on `PATH`,
    starts the daemon, configures daemon state, or installs supervision. The separately exported
    `bootstrapDaemon` download step on its own only publishes a verified archive and installs
    nothing.
  - Manual npm, pnpm, or Bun adds of the daemon are not frozen. Native compilation and the
    external toolchain remain reproducibility limits. The protocol library keeps all three
    package managers. Tests drive the real bootstrap CLI with an isolated changing registry, and
    `scripts/bootstrap-real-daemon.test.mjs` packs the real archive, installs it, then runs the
    installed tree on all three CI platforms: version and help, a real `node-pty` and keyring load,
    a `~/.domovoi` the daemon writes itself in an isolated home, an authenticated `system.hello`,
    and a withdrawn endpoint after a signalled stop. A clean-machine PATH entry and a supervised
    service lifecycle stay unproven and are not performed by bootstrap. That test injects the
    download step and the real-HTTPS test installs a fixture package, so no test yet fetches the
    real archive over HTTPS. No release is published yet, so this path cannot be run against a real
    release today. See `docs/distribution.md`, and `docs/clean-machine-setup.md` for the operator
    steps that surround it.
- [ ] Install and supervise the daemon for the user who asked, through a systemd user unit, a
  launchd agent, and a Windows logon task
  - Unit and task generators plus `service install`, `status`, and `remove` exist, and nothing is
    written to a system-wide location. Since #256 installation records the validated non-secret
    settings in `~/.domovoi/service.json` and replays them as the supervised environment: host,
    port, credential and identity paths, TLS material, advertised and tailnet hosts, SSH
    forwards, allowed origins, and the remote-transport opt-in. It refuses to retain
    `DOMOVOI_AUTH_TOKEN` rather than silently changing authority. Since #261 Desktop no longer
    contends for the port: it attaches to the verified local owner, and it refuses to start a
    fallback daemon at all when a service configuration is present.
  - The Windows logon task still has no crash restart, where the systemd unit has
    `Restart=on-failure` and the launchd agent has `KeepAlive`. CI reaches a real manager on all
    three legs. `apps/daemon/src/service/windows-task.native.test.ts` registers, stops, and removes
    a real scheduled task under a throwaway name on the Windows runner.
    `apps/daemon/src/service/systemd-unit.native.test.ts` installs, reports, and removes a real
    systemd user unit on the Linux runner, then crashes its main process through the manager and
    reads `NRestarts`, `ActiveState`, and a new `MainPID` back off it to require exactly one
    restart, with a deliberate stop and a clean exit both required to stay stopped. The Linux job
    starts the user manager and asserts its private socket, so a runner without one fails rather
    than skipping the proof.
  - `apps/daemon/src/service/launchd-agent.native.test.ts` (#306) is the macOS counterpart and has
    now run. It bootstraps a throwaway agent into the per-user `gui` domain the installer targets,
    crashes it through the manager, and requires launchd's own run count to increment, with a clean
    exit required to stay exited past launchd's throttle. The macOS job asserts that domain before
    the suite, and the test refuses to skip on a CI darwin leg, so an unreachable domain fails by
    name rather than disappearing from the run. The `macos-latest` leg of run 34016224755 ran all
    nine of its tests with none skipped, so `KeepAlive` supervision is proven against a real
    launchd. See `docs/daemon-services.md`.
  - `docs/clean-machine-setup.md` gives the operator sequence from an uninstalled machine through
    installation, first start, TLS, supervision, pairing, and recovery, and names what remains
    unproven per platform.
- [x] Implement WSL discovery and a `domovoid open` Windows interop shim
  - Since #262 `domovoid wsl list` discovers each distribution and whether a daemon answers there,
    the daemon reports its own WSL facts on its machine descriptor, and `domovoid open` places a
    Windows path inside the distro. A `wsl.exe` that cannot answer is classified as absent,
    denied, timed out, unavailable, or corrupt rather than reported as a missing distribution or
    daemon. Unit tests drive them with a fake `wsl.exe`. A corrupt listing returns no partial
    discovery: unreadable rows after a valid header and torn UTF-16 bytes propagate a corrupt
    classification and remedy through both CLI commands. The `wsl-native` workflow in
    `.github/workflows/wsl.yml` is path-filtered and nightly, and it provisions one throwaway
    Ubuntu 24.04 WSL 2 guest from an image pinned by URL and `sha256`. `scripts/wsl-ci.mjs` names
    all fifteen proofs and requires exactly those to pass with none skipped, pending, or failed,
    so the job is red rather than green when a proof cannot run.
    `apps/daemon/src/wsl-windows.test.ts` and the proofs it registers skip by name off Windows or
    on a Windows machine without a guest, and refuse to skip once the job names a required
    distribution. Run 34017787075, on WSL sources and a workflow byte-identical to the merged
    ones, passed all fifteen: real CLI discovery, open through both the `wsl$` and
    `wsl.localhost` spellings, guest project ownership and real Git, authenticated fleet routing,
    a graceful daemon restart with the project and pairing intact, and refusal of a stale endpoint
    and of a stopped distribution. `docs/wsl-ci.md` records the run, timings, and limits. WSL
    routes are source-local candidates produced only after the guest answers with the enrolled
    identity; WSL is not a fleet candidate. Every proof runs against that single guest built from
    that single pinned image, so two distributions at once have never been exercised, and
    multi-distro arbitration, service-launch WSL facts, mirrored networking, VPNs, and a `domovoi`
    alias are unclaimed.
- [x] Keep all WSL filesystem and Git work inside the distro daemon, never through `\\wsl$`
  - The open shim and the git runner both ask the distribution's own `wslpath` which Windows path
    a placed path reads back as, so a Windows drive is refused wherever the distribution mounts
    it, with a fake `wsl.exe` covering a custom automount root and a drive mounted by hand. The
    dedicated native job now proves the custom automount case at `/domovoi-ci-drives/`, including
    refusing a valid Windows Git repository through the real Windows open shim and Git-command
    preparation without changing either daemon's project. It also proves the Windows daemon
    refuses both WSL share spellings with the boundary-specific remedy, while the guest owns the
    native project and executes real Git in a path carrying spaces and literal shell
    metacharacters. Hand-mounted drive paths and repository-selecting Git arguments remain
    unit-tested, not native-tested. The proofs run as root in that one distribution, so non-root
    guest permissions, a second distribution, and a session transfer are not proven.
- [x] Add fleet health, reconnect, version mismatch, and upgrade-required states
  - #244 adds the production remote row and refresh path these states run on, plus
    `pairing-required` for a target that refused this machine's credential and
    `credential-store-unavailable` for a keychain that could not be read. The two-daemon test
    covers revocation health and reconnect after a restart.
  - `apps/daemon/src/fleet-production-health.test.ts` (#255) grades a restarted peer as
    `version-mismatch` or `upgrade-required` between two production daemons, refuses the move each
    way with the matching reason, refuses re-pairing on the wire, and returns the row to healthy on
    upgrade without a new pairing. The other release is a different `advertisedProtocolVersion` on
    the same build rather than a second daemon build, so the states are proven, not a real
    cross-release deployment.
- [x] Add checkpointed machine transfer with live source and target preflight
- [x] Transfer worktrees through an incremental Git bundle first, with explicit opt-in to a remote
  ref workflow
  - Since #245 a bundle restore claims the session before any Git work: a process-local
    reservation taken before the first await, plus an exclusive `.restore-claims/<session-id>`
    file holding an ownership token so a second daemon on the same worktree root is excluded too.
    Contention fails at once; nothing waits, steals a timed-out claim, or removes another owner's
    file. A claim left by a killed process is named in the error and removed by hand with every
    Domovoi process stopped.
- [x] Give restore claim release a deadline and a lifecycle
  - Close, ownership read, and unlink share a fresh ten-second release deadline. Expiry returns
    the restore outcome and quarantines pending I/O; no later cleanup step starts after expiry,
    and exclusion ends only when that I/O settles. Replacement claims survive late close/read
    completions, and pending unlink excludes a successor even when the pathname is absent.
    `workspace.test.ts` proves late success and failure for all three phases. Recovery requires
    stopped daemons before removing a confirmed stale claim. See `docs/restore-claims.md`.
- [x] Stop transfer chunk directory cleanup failing with `EPERM` on Windows
  - `transfer-transactions.test.ts` "handles concurrent retries of the same chunk" failed once on
    the Windows job of #245 (run 33938587480) with `EPERM: operation not permitted, rmdir` on the
    chunk directory, under the old 256-retry fixture that #246 later trimmed to 16. #251 merged a
    guard: `apps/daemon/src/transfer-transactions.ts` reserves each chunk path in
    `activeMemberReceives` before the first await and refuses a second concurrent receive.
    Receives now also share a process-owned SQLite lease through publication and removal. Two
    real daemon processes over one journal prove refusal while a chunk descriptor is open and
    recovery after completion or process death, without synthetic filesystem errors. Independent
    receives within the owning process share one permanent lease outside disposable journals; see
    `docs/transfer-receive-leases.md`. Native Windows `pnpm test` passed in
    [run 34171599299](https://github.com/getdomovoi/domovoi/actions/runs/34171599299/job/101892809299)
    at `c37da78`, including both process-lifecycle cases without a platform skip.
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
  - Since #244 a move runs between two production daemons in `fleet-production.test.ts`,
    preserving files, thread, and plan while freezing the source. That test found a real defect
    on its first run: an optional working-plan field serialised as `undefined`, which JSON cannot
    carry, so every portable-state fixture now round-trips through the exact encoder and the
    exact target schema. No move has run between two physical machines.
- [x] Record every attempted move in the thread as a receipt that names the reason the daemon
  refused rather than a generic failure
- [x] Add a Fleet surface listing machine platform, architecture, version, connection, health,
  capabilities, session count for this machine, and the transport order the dialer would use
- [x] Manage paired devices from the Fleet surface, with revocation behind a confirmation and
  credential rotation that shows the new credential once
- [x] Rename a paired device from the Fleet surface
  - `device.rename` (#248) changes the label and nothing else: never hostname, machine identity,
    platform facts, or credential material. The label is 1 to 128 characters, the pairing limit.
    Rename is allowed on revoked rows because the record is kept for audit; rotate stays refused
    there. There is no device change event, so clients update from the returned device.
- [x] Give Undo on a rename an expected-label precondition
  - `device.rename` takes an optional `expectedLabel` (#253), and the daemon renames only the row
    that still carries it, refusing otherwise with a typed mismatch that returns the row as it
    stands. Undo always sends the label it opened against, so a rename by another client in the
    meantime is reported rather than overwritten.

Completion proof. Current evidence first, then what closing actually requires.

Covered today:

- two production daemons taken from code issuance to a fleet row, a heartbeat refresh after
  restart, revocation health, and a session move, with no seeded registry;
- one session controlled across two clients on one machine without divergent state;
- revocation, rotation, and rename paths exist in the client;
- transfer safety is tested against constructed remote facts, and against a production peer in the
  fleet, transport, and version-health production tests;
- repository bytes never flow through a filesystem sync layer.

Not covered, and the reason this goal is open:

- the two-daemon test injects the OS keyring and provider readiness, so platform keychain
  behaviour and cross-host TLS are unproven, and no two physical machines have been paired;
- native service managers are driven for real on all three legs, with a crash restart proven on a
  real systemd user unit and on a real launchd agent, but the Windows logon task has no crash
  restart to test at all;
- a project is opened and Git is executed over the WSL route, but only inside one throwaway guest
  built from one pinned image and only as root, and no session has been transferred over it;
- a client is admitted to a remote daemon and drives Use and Terminal, but only between two
  production daemons on one machine under `fleet-client-smoke.mjs`. Credentials stay in app
  memory, so retention does not revoke on the target, and remote preview frames still have no
  verified path.

Required to close: two physical machines taken from pairing to a fleet row on real keychains, a
bounded ordered dial, a session move, reconnect, restart, revocation, and removal. A daemon must
also remain reachable from a paired phone across private-network identity changes without exposing
payload plaintext to the relay, and a bearer or channel key alone must not be enough to enter.

### From the work split: daemon items (done)

#### Usage accounting, dedup and coverage — 2-4 d
Ticked here under rule 7: Codex did the work, this file is Claude Code's, so the citation
carries Codex's sha rather than a second agent's edit.
- [x] Normalize adapter token reporting. One of the two was already fixed when this line was
      written: `claude.ts` by 33b2737 on 2026-09-07. OpenCode's `tokens.cache.read` and
      `.write` now fold into `inputTokens` in `usage.ts` (4359bcf9).
- [x] `acp.ts:296` gives `totalTokens` and `contextTokens` the same `update.used` value.
      Fixed by deleting the total rather than guessing one; the record says
      `tokens: "unavailable"` (4359bcf9).
- [x] Capture the model at dispatch. `server.ts:6903` writes usage against
      `session.runtime.model`, and `server.ts:5835` can change it on a same-provider update,
      so the record must keep requested model distinct from provider-reported (4359bcf9).
- [x] Persist accounting plus its dedup and coverage state across restart and transfer
      (4359bcf9).
- [x] Five hazards, all in scope: duplicate events, late events, failures, restart, transfer
      (4359bcf9).
- [x] Never infer a turn link from a timestamp or row position. OpenCode's turn id now comes
      from `info.parentID` rather than the active turn, so a late message lands on the turn
      that produced it (4359bcf9).
- [x] Not in the original list, found by Codex reproducing an inference rather than
      inheriting it: `opencode.ts` called `normalizeProviderUsage` unguarded where
      `claude.ts` wrapped it, so a cache read above the input count threw out of `#receive`.
      It now emits a record marked `invalid` instead (4359bcf9).
- Out of scope: new turn records, ordinals, message associations. Those are `CX2`.
- What Claude Code verified directly: the four defects are addressed in the diff, and
  `usage.test.ts`, `acp.test.ts` and `opencode.test.ts` pass, 59 tests. The accounting
  persistence across restart and transfer rests on Codex's own full-suite run, not on a
  check run here.

#### Turn records, ordinals, message associations — 2-3 d
Ticked under rule 7: Codex's work, Claude Code's file, so the citation carries Codex's shas.
- [x] Durable per-turn record with an ordinal (e7364720, 84d90d50).
- [x] Associate messages with turns. Two dispatch paths: `server.ts:6504` steers an active
      turn, `server.ts:6595` appends another user message — a message is not a turn (1991666a).
- [x] Expose the history-to-turn link so a history row can name its turn (84d90d50). `CC1`'s
      meta draws it in f3252e50.
- Legacy history stays unnumbered rather than defaulted, and `coverage` says how much of a
  turn the daemon actually saw, so the client can refuse to present a floor as a total.

#### Approval execution duration — 1 field
- [ ] Record how long the approved command ran, distinct from `decided in`.
      Decision latency answers "how long was the agent blocked"; execution duration answers
      "what did the approval cost". The design asks for the second and the UI currently
      shows the first.

#### Record the session-start checkpoint — accepted and landed
Raised 2026-09-10 while working `CC1`, accepted by Codex the same day (2adb1171, f9cf76bb), and
`docs/checkpoint-reasons.md` is the contract. Codex caught a second failure in the original
ask that Claude Code had missed: `baseCommit` is mutable, so comparing against it does not
just collide, it changes meaning over time.
- [x] Push a checkpoint thread item when a session worktree is created, carrying the
      `baseCommit` that `createSessionWorkspace` already returns (f9cf76bb).
- [x] Give the checkpoint thread item a `reason`, and make `session-start` its seventh value.
      Landed with eight reasons and legacy rows left absent rather than defaulted (2adb1171).
      The schema is `{ kind: "checkpoint", label, commit?, createdAt }` (`schema.ts:502-505`);
      the reason exists already but only inside the label prose — `forked checkpoint`,
      a user's own words, `before restore`, `before revert <path>`, `before provider
      handoff`, `before provider recovery`, and the archive site's. Promoting it to a field
      names a concept the daemon already has rather than adding one, and every client stops
      reading prose to learn why a checkpoint exists.
- Not `commit === baseCommit`. That equality is coincidental, not semantic: a checkpoint
  taken before a revert that returns the worktree to base carries the same commit, and then
  two rows both answer to session start.
- Why it is worth a protocol change rather than a client heuristic: the client cannot infer
  it from position either. History is paged, so the oldest row loaded is not the oldest row.

#### Report the manifest defect upstream
- [ ] `_adherence.oxlintrc.json` marks `--transition-control` as `"color"`, after five
      correctly-marked `"other"` motion tokens. It is the **last key in `tokenKinds`**,
      which is a generator signature rather than a typo — report it as "the final entry's
      kind may be systematically wrong", since other manifests from the same emitter would
      carry it. Harmless to a font-size generator; a colour generator would accept it.

---

## Phase 2 — the hosted relay — M2, behind M1, its own gates

Restated 2026-09-14. The relay is not on the critical path to a usable product: M1 is loopback
and the tailnet, and the relay is the monetisation of the open core once that product exists.
Everything paid still depends on it. **Blocked on S0.2 and S0.6**, both resolved; not blocked
on the tailnet product and never in front of it. The forwarding core exists in
`getdomovoi/relay` (`2ec1e24a`): bounded opaque forwarding, durable registration generations,
replacement fencing, crash-safe ownership, queue accounting, machine-time export. The WSS
carrier adapter was stopped on 2026-09-14 so Codex's queue is M1; it resumes here.

- [ ] **S2.1 [CX]** Machine registration and identity: device credentials, rotate, revoke —
      and revocation that reaches a machine which was offline when you revoked it.
- [ ] **S2.2 [CX]** Transport routing in the stated order — loopback, tailnet, relay — plus
      honest reporting of which route was chosen and why. `fleet.clientRoute` is already
      wired and has no surface. The loopback and tailnet legs are M1 work and are proved by
      `S3.0`; the relay leg lands here. The list stays a list: LAN is a later carrier under the
      same handshake, and no client hardcodes two branches.
- [ ] **S2.3 [CX]** NAT traversal and fallback. Tailscale covers the tailnet case; the relay
      covers the rest.
- [ ] **S2.4 [CX]** Degraded and queued behaviour under real packet loss, not just as drawn.
- [ ] **S2.5 [CX]** Metering: connected machine-hours for entitlement and abuse control,
      emitted so records can be reconciled and audited. Machines are priced per seat, not by
      observed duration; byte counters are never silently substituted for machine-hours.
      The meter exists in the forwarding core as settlement-ordered
      machine-time export (`getdomovoi/relay` `docs/registration-and-usage.md`); what is
      open is the account-issued registration credential and the tier meter in front of it.
- [ ] **S2.6 [CX]** Abuse controls. A relay forwarding arbitrary encrypted bytes between
      machines is attractive infrastructure to someone else.
- [ ] **S2.7 [H]** Regions, latency targets, and an uptime commitment you can meet.
- [ ] **S2.8 [CX]** Load and soak with sessions held open for days, which is the real usage
      shape.
- [ ] **S2.9 [CX]** Tier claim verification in the daemon, per S0.4.
- [ ] **S2.10 [CX, then H]** Restart continuity on the single-node authority. A launch gate,
      not an operational detail. What the relay does today, read 2026-09-16 from
      `getdomovoi/relay` `docs/registration-and-usage.md` at `2ec1e24`: the authority is one
      process holding an exclusive SQLite ownership lock, so there is one of it; on startup every
      interval left open becomes `interrupted` at its last durable observation. Connected time
      after that observation is missing from the durable record; downtime is not connected time. So every
      restart, planned or not, ends every relayed session, and the time between a route's last
      `sweep()` observation and the restart is a record-continuity gap, not lost revenue.
      Measure the actual observation gap and downtime separately; a configured sweep interval
      alone does not establish a hard upper bound under process or disk stalls. The sweep
      interval is the network adapter's choice and the adapter is not written (`S2.2`). Nobody
      owns the client side either: what a daemon or phone does when the relay drops it is the
      carrier adapter's reconnect behaviour, also unwritten. Gate, before any hosted deployment,
      all three: (1) the sweep interval fixed and published as a number, so the observation-gap budget
      is a stated figure and not "small"; (2) product copy that says a relay restart ends relayed
      sessions and what the client does next, written where the transport list is shown; (3) a
      restart drill on the deployed shape, N routes connected, restart, measured: seconds to
      first reconnect, seconds to last, missing connected-time milliseconds with the error
      bound alongside each result, and the daemon's own session
      state after it (the worktree and thread live on the machine and must be untouched). A
      restartable authority that keeps sessions is the other answer; it contradicts the
      single-process design in `docs/server-boundary.md` and is not chosen here. Recorded
      2026-09-14, written out 2026-09-16.
      Framing correction, 2026-09-16: the earlier "unbilled" wording was withdrawn.
      It survived into this gate and the relay design and wrongly implied a usage-based price.
      Machines are priced per seat; this meter supports entitlement and abuse control, not
      invoice lines. The loss is a gap in the observed-time record. Bounded deployed results
      keep their error ranges, and exact deterministic tests cover crashes between observation
      and settlement and during settlement, including commit-before-acknowledgement.
      Design answer: [relay restart and ledger recovery](https://github.com/getdomovoi/relay/blob/f41500c4de14851184f99b74140d4422affbc015/docs/restart-and-ledger-recovery.md),
      S2.10 section, proposed in [relay #2](https://github.com/getdomovoi/relay/pull/2).
      Chosen approach, costs, exclusions and numbered measurements; not implementation evidence.
- [ ] **S2.11 [CX, then H]** Backup and retention of the SQLite ledger that holds connected-time
      records. A launch gate. What exists, same source and commit: the ledger is the usage
      database plus a separate ownership database, "the service directory and SQLite sidecars
      must stay together", local filesystem only, "not a shared-filesystem or multi-replica
      authority"; usage export reads settled intervals after a caller-supplied settlement
      sequence, ordered, at most 1,000 a page (`src/authority.mjs` `usage()`), and that
      sequence is an ordering, not a receipt: nothing persists that a consumer took a page,
      so the store has no record of what was read out. Retention and archival remain an
      operational policy, not silent eviction; the original source's billing framing is
      superseded by the dated S2.10 correction above. The store holds
      more than intervals: accounts with enabled and machine-cap fields, routes with machine
      and account bindings and a credential digest, and account and machine ids on every
      interval (`src/authority.mjs` schema). So: one copy of the meter and of the relay's own
      authorization records, on one disk, with no backup, no restore drill, no retention period,
      no purge, and no acknowledgement of export. Losing the disk loses every interval not yet
      taken downstream, and nothing today can say which those are. Gate,
      before any hosted deployment: (1) an owner named, the person and the runbook; (2) a
      backup that copies a consistent database without taking the ownership
      lock, the SQLite online backup API or WAL streaming against a second connection, on a
      schedule with a stated recovery point, and the exclusive-lock behaviour checked against
      it rather than assumed; (3) a restore drill run once on the deployed shape, restoring
      to a fresh directory and starting the authority against it, with the last settled
      interval and the acknowledgement below compared before and after; (4) a durable,
      account-scoped export acknowledgement written after the downstream commit, backed up and
      restored with the ledger, because a settlement sequence or a returned page authorises
      nothing; (5) a retention period written as a number, a purge that removes only intervals
      older than it and acknowledged under (4), and an archive of what it removes if entitlement
      disputes need it; (6) the hosted account and device registry in `S6.6` stays a separate
      store; the relay keeps the authorization and metering records it already holds, accounts,
      routes, credential digests and interval attribution, and does not grow into that
      registry. Recorded 2026-09-14, written out 2026-09-16, corrected 2026-09-16 against
      `src/authority.mjs` at `2ec1e24`.
      Design answer: [relay restart and ledger recovery](https://github.com/getdomovoi/relay/blob/f41500c4de14851184f99b74140d4422affbc015/docs/restart-and-ledger-recovery.md),
      S2.11 section, proposed in [relay #2](https://github.com/getdomovoi/relay/pull/2).
      Operational owner: fetzy. The design and owner assignment do not close the launch gate.

### From the roadmap: account and transport services (Goal 3, hosted half)

- [ ] OAuth/passkey account service
- [ ] Account-scoped device registry and short-lived client sessions
- [ ] Hosted, horizontally scalable deployment of the encrypted relay wire
- [ ] Preserve payload-level end-to-end encryption through the hosted relay while adding accounts
  and multitenant routing
- [ ] Relay protocol version negotiation, backpressure, reconnect, and resumable subscriptions
- [ ] Hosted usage, subscription, billing, and relay-entitlement management
- [ ] Device/session revocation and security-event history
- [ ] Recovery flow that does not give the service plaintext provider credentials

## Phase 3 — clients to parity — M1 for loopback and the tailnet, M2 for the relay

The client work that reaches a daemon over loopback or the tailnet is M1. Anything that needs
the hosted relay waits for Phase 2. Starts when the protocol is stable.

- [x] **S3.0 [CC + H]** The check before the build. Ran 2026-09-16 on real hardware: an
      iPhone on 5G over the tailnet with TLS, against a daemon built from `4ddf93f5`. Answer
      is yes. Four proofs: (1) tailnet transport with TLS; (2) a `client/phone` credential
      earned by spending a one-use code the machine drew (3c2ae09c, #451); (3) sessions listed
      and attached on the phone; (4) a gate raised by a session started in the browser,
      answered on the phone, the desktop receipt reading `decided from phone`. Nine defects
      found. Five fixed on the run, each its own PR: origin check refused every client that
      sent an `Origin`, same-host admission on TLS sockets only (2c9ffc10, #453);
      `FloatingSurface` clipped its own first rows, mode list unreachable (5c17e887, #454); a
      mode change before the first turn resumed a conversation that never existed, a failed
      reopen destroyed the thread, and a session once in Ask could never write again
      (5a14da7c, #455); the phone rendered markdown raw (2e30deb5, #456, not yet seen on the
      device); pairing refusals hid the socket's own reason (ccc9dd1d, #457). Three open:
      `project.open` and
      `session.send` answer "Internal daemon error" for every cause, a policy decision on what
      detail leaves the daemon; `session.tsx` keyboard avoidance lacks
      `keyboardVerticalOffset` and the thread does not autoscroll; a daemon built from `main`
      quarantined a live profile's stored snapshot on first start and reset the workspace,
      with nothing telling the user. Phone credential revoked at the end of the run.
- [x] **S3.1 [CC]** Desktop: the 2026-09-15 audit's v2 gap list is closed on `main`, and
      that is the whole of this claim; v2 is not landed. Each gap went in as its own slice,
      built to the v2 arrangement and sitting in the v1 chrome: Checkpoints tab (e535558c,
      #427), usage chip in the composer (1f50a698, #429), plan edit strip with the queued-edit
      notice (2cda8329, #432), model popover with discovery and rediscover (91589000, #433),
      Session tab removed and Comments drawn under the preview (951fa879, #435), Rules tab on
      the Rules protocol (e4783bf7, #436, on 9d94da3e, #431), sessions drawer as a column with
      row actions (3a84912f, #437). The dock's tab list is v2's seven. What is still v1 chrome,
      and is S3.10: the thread header carries Think, the mode toggle and Auto where v2 puts them
      on the composer; the app bar carries a usage readout and the dock a usage footer where v2
      has the one chip. Deviations each PR body states: no step file scope in the protocol, the
      provider's rate window not observable (today's count instead), no deferred harness change
      (the daemon refuses one during a turn), no worktree-delete RPC, no per-session durations,
      the design system's 240px sidebar token over the template's 268px, hard-gate chips from
      `permission.hardGates` rather than the design's prose. Measured 2026-09-16 against
      `design/design_handoff_domovoi_v2/designs/Domovoi Desktop V2` and the dock, composer and
      drawer sources named in those PRs. Earlier: #386 to #401 (41e675ab) landed v2's
      corrections to the v1 layout. The work-split items under "From the work split: client
      items" below are the rest of the detail.
- [ ] **S3.10 [CC]** Desktop chrome: move the three v1 leftovers to where v2 draws them, so the
      surface looks like the design rather than containing its parts. (a) Think, the mode
      toggle and Auto leave the thread header for the composer's action row beside the model
      chip (`permChipStyle`, part1-template line 948). (b) The app bar's usage readout goes;
      the chip is the one usage surface. (c) The dock's usage footer goes for the same reason.
      One PR each, each body stating what moved and what the design draws that the protocol
      cannot; no new RPCs expected.
- [ ] **S3.2 [CC]** Web: the six-step flow over loopback and the tailnet, with
      capability-refused real rather than drawn. Over the relay once Phase 2 lands.
  - [x] Step 3, what a browser tab can and cannot do, measured against the browser rather
        than drawn (ad121ceb, #471). Seen in a real browser 2026-09-17: headless Brave over
        CDP against a daemon from `ad121ceb`, pairing, the panel and `Open project` all real.
  - [ ] Step 6, Design review, unchecked: the shell is shared with the desktop, so it should
        run over loopback with `parentOrigin` on the `:5178` allow-list, but a session needs a
        signed-in provider, the sign-in is Keychain-bound to the real `HOME`, and the daemon
        infers its profile from `HOME`. So the check either runs against the live profile or
        not at all. fetzy chose not at all until the daemon takes a profile directory it is
        told (`DOMOVOI_PROFILE_DIR`), which makes any such run reproducible by someone who is
        not the user at their own machine. Ask 3 in
        `~/.agents/plans/2026-09-17-domovoi-daemon-asks.md`, handed to Codex.
  - [ ] Over the tailnet there is no web app to reach: vite serves loopback only. Decided
        2026-09-17: the daemon serves the built web app under the certificate the phone
        already trusts, as a separate artifact beside the daemon rather than compiled in, so a
        web regression is not a daemon release. Ask 4 in the same file, after Phase 1's own
        items. Steps 1 and 5 are relay states and wait on Phase 2.
- [ ] **S3.3 [CC]** Mobile: 19 designed frames against nine existing screens. In order:
      pairing by camera first, which is in the not-built list and is the thing standing
      between a phone and a daemon; then the gate path end to end on a real device.
  - [x] Pairing by camera (3c2ae09c, #451; fe7968f9, #442) and the gate path on a real
        device (`S3.0`, d14addde).
  - [x] Sixteen of nineteen frames on `main` by 2026-09-17, one PR each, test-first: 01
        grouped sessions (b26506d9), 03 receipt facts (9cb178ae), 15 plan edit (c50c37d2),
        16 and 17 render fetched with a grant (37b3fa00), 18 comment on an element
        (1469846a), 19 pinned plan (d5e75503, 55492e93), thread follows a reply
        (d7139a4b), markdown (2e30deb5). "Built" here means what `jest-expo` proves:
        text, order, roles and wiring against protocol fixtures. None of it has been seen
        on a device since the `S3.0` run; the WebView render, the bridge under the
        render's opaque origin, and the keyboard offset are `unverified` there.
  - [x] Frames 13 and 14, attachments. Decided 2026-09-17 as images only, the annotation
        bound reused (`~/.agents/plans/2026-09-17-domovoi-phone-protocol-asks.md`);
        the bound went into the drawing first (22304e4d, #472); protocol half
        `session.send.attachments` with `system.hello.sessionImageAttachments` (0c88e11a,
        #474); phone half, picker and camera, queue of two, the size line, the daemon's
        refusal shown as it states it (cac2e63d, #475). Not seen on a device.
  - [ ] Frame 04 waits on `terminal.watch`, decided as option A after Phase 1's own items,
        in the same file. Three affordances the phone credential refuses left the design
        instead (b6116b7e, #465): revert, take the shell, build on a variant. A phone
        answers what a machine proposed.
- [ ] **S3.4 [H]** Push notifications need a decision, not code. Over loopback and the
      tailnet a closed app cannot be woken. Two options, consequences stated, no choice made:
      (a) the product says plainly that you open the app to see a waiting gate; the phone is a
      pull surface and the copy must never imply otherwise; nothing hosted in M1.
      (b) push becomes the first hosted piece and arrives before the relay: an APNs and FCM
      relay that carries a payload with no session content, only "a gate is waiting", which
      means an account, a hosted service and its operations arrive in M1 for one feature.
      The plan said this is the phone's whole reason to exist; that claim is what the decision
      weighs.
- [ ] **S3.5 [CC]** Tablet: nothing exists yet.
- [ ] **S3.6 [CC]** Cloud and Team surfaces; the cross-cutting states.
- [ ] **S3.7 [CC]** Accessibility: focus order, screen-reader labels, and the StatusDot rule
      — colour is never the sole carrier — enforced everywhere.
- [ ] **S3.8 [CC]** Offline and reconnect on every client, including unconfirmed work on
      return.
- [ ] **S3.9 [CX]** Any new `WorkspaceSurface` member. The union is
      `"workspace" | "providers" | "skills" | "fleet" | "audit"`, so a new desktop surface is
      a protocol-adjacent change even though the file is Claude Code's.

### From the roadmap: the hosted client (Goal 3, client half)

- [x] Browser `PlatformAdapter` for dialogs, notifications, credentials, clipboard, and install state
  - `apps/web/src/browser-platform.ts` answers the host questions the desktop answers through its
    preload bridge, and `WorkspaceShell` takes it as `platform`. Workspace notifications now reach
    the browser, so the Notifications pane is no longer three switches with nothing behind them: it
    names the browser's permission and install state, and a browser that will not raise them
    disables the kinds instead of recording a preference it cannot honour. The clipboard copies the
    worktree path and reports its own refusal. A folder picker refuses, because a File System
    Access handle names a folder on the device holding the browser rather than one on the execution
    machine. Every refusal is typed and takes its copy from one table in
    `apps/web/src/platform-refusals.ts`. A notification click focuses the tab; it does not open the
    session the way the desktop deep link does.
- [ ] Supply authenticated daemon credentials without embedding long-lived secrets in the bundle
  - The browser no longer keeps the daemon's root bearer. It spends the pasted credential once on
    `device.pair` and stores only the client-bound device credential that came back, which
    `device.revoke` can withdraw on its own from a paired client, and it drops the bearer an
    earlier build had parked in session storage. What remains needs the protocol and the daemon:
    there is no client-bound pairing code, so the root bearer still passes through the browser
    once, `device.claim` binds a machine rather than a client, a device credential has no expiry,
    and `device.revokeCurrent` is machine-only, so this browser cannot withdraw itself at sign out.
- [ ] Select any paired machine and resume its daemon-owned sessions
- [ ] Full-fidelity plan/design preview on iPad, tablet, and phone
- [ ] Read, annotate, reply, resolve, and select variants from touch devices
- [ ] Review and decide approvals with every safety fact preserved
- [ ] Touch-capable terminal with explicit ownership transfer
- [ ] Push notifications for completion, failure, and approval-needed events
- [ ] Offline-safe read cache for previously opened plans, without offline command mutation
- [x] Give the native phone app the design's fonts and one token source
  - #234 started the Expo app. #236 loads Instrument Sans and JetBrains Mono through `expo-font`
    behind a 3000 ms gate that falls back to the platform face, and `scripts/mobile-tokens.mjs`
    generates the phone's colours and radii from `packages/ui/src/styles.css`, checked by
    `pnpm release:invariants`. Glyph rendering on a device is unverified.
- [x] Render the phone's screens under test
  - #235 renders the real approval, sessions, and settings screens with protocol fixtures under
    jest-expo. It proves text, order, roles, and handler wiring, not pixels, styling, or a device
    boot. The first render found the approval screen omitting the operation, estimate, and
    checkpoint, which is fixed.
- [x] Guard the phone's fleet list loader by request generation
  - `apps/mobile/src/fleet-load.ts` (#244) bumps a generation per load so a stale response cannot
    replace a newer list.
- [ ] Give the phone's Fleet tab the facts the mockup shows
  - Building the tab against the mockup found four gaps: the protocol has no paused fact for a
    fleet machine, no wake RPC, and no per-machine session or tool counts, and the phone has no
    pairing flow of its own; it takes a daemon address and pairing token in Settings.

### From the work split: client items

#### Finish the history row — blocked on CX2 for the last part
- [x] `<pre>` out of the row, meta on one line, body in a collapsed `details` (f3252e50).
- [x] Checkpoint title drops the sha; title names the checkpoint, meta names the commit
      (f3252e50).
- [x] Fork wired on checkpoint rows only, with a confirm stating both halves
      (f3252e50, f3252e50).
- [x] The card: `1px --border`, `--radius`, rows separated by a border (f3252e50).
- [x] Left **42px mono time column**, pinned by `history-row.dom.test.tsx` (f3252e50).
- [x] Replace the raw `span` dot with `StatusDot`, coloured by outcome rather than
      `bg-primary` on every row (f3252e50).
- [x] Grow the turn meta to `turn 9 · sonnet-4.6 · 3 tools · 12.4k tokens` — after CX2
      (e7364720, 1991666a, 84d90d50 by Codex; drawn in f3252e50). The row also repeats what the
      turn says about its own completeness: pending reads `running`, unavailable says so, and
      partial is marked rather than passing its floor off as a total.
- [x] Record execution duration as an unfilled design field, not a satisfied one:
      `sessionHistoryEntryDetail`'s field 4 names it and says why only decision latency
      can be measured today (f3252e50).
- [x] The session-start checkpoint gets **no** fork (2adb1171, f9cf76bb by Codex; drawn in
      f3252e50). Fork is absent rather than disabled, because a disabled control still says the
      decision exists, and the meta reads `session start · nothing to revert past this`.
      Restore stays: going back to it is exactly what it is for. A legacy checkpoint carries no
      reason and is never guessed into this branch.
- [x] Turn-row fork is **closed as a design error**, not left open as a daemon request
      (f3252e50 keeps fork checkpoint-only). fetzy's earlier "blocked on `CX2`" ruling was wrong,
      and so was its reasoning: the obstacle was never turn identity. Fork restores a worktree
      and turns do not each have one — most turns write nothing, so forking "from turn 8" and
      "from turn 9" lands on identical filesystem state, and `session.fork` does not replay
      conversation either. The affordance would promise a precision it cannot deliver, which is
      the same failure as forking from a turn's nearest preceding checkpoint. `CX2` gave a turn
      an identity; it did not give it a state. The design changed rather than the client:
      Desktop V2's three turn rows are now `fork: false`, the two checkpoint rows keep
      `fork: true`, and the reasoning sits above `historyRows` in the design file itself so the
      drawing carries its own why. Re-vendored, `part2-logic` 133,178 to 133,451 bytes. Nothing
      to raise with Codex: `session.fork` taking a checkpoint id is right as it stands.
  - The export `README.md` is vendored at `design/design_handoff_domovoi_v2/designs/README.md`
    (18dc495 for the parts, this commit for the README). Its byte table is gone rather than
    corrected: a restated byte count goes stale on every re-export, which is the same shape as
    an undated `[x]` or prose restating a token. What replaces it is checkable after any
    re-export, and was checked here rather than taken on the README's word — part 1 ends
    `</x-dc>` with zero trailing bytes, part 2 opens `\n<script` and ends `</html>\n`, and the
    seam is adjacent bytes with no separator. The correction list is closed.

#### StatusDot takes an invisible label
- [x] The label stops being visible; it does not stop being required. Meaning derives from
      `status` and `decision`, nothing invented (59b11f1c).
- [x] Any row whose title does not state its outcome gets the outcome word in the meta —
      failures especially. Colour is never the sole carrier (f3252e50).
- Landed as its own pull request (#388) before the dot swap in #397, as planned.

#### Revert the Handoffs label, add the transfers filter
- [x] `6f2f875` renamed `handoffs` to Transfers. `handoffs` holds **provider** handoffs —
      `server.ts:461` selects rows starting `Handed off `, written at `server.ts:5812`.
      Label reverted to Handoffs (f3252e50).
- [x] Add the `transfers` filter now that `560eca5` records machine transfers (f3252e50).
- [x] Eight filters, drawn five leading:
      Everything, Turns, Approvals, Checkpoints, Transfers, then Handoffs, Tools,
      Annotations, Tests (f3252e50).

#### Vendor the v2 designs — done
**Written while the files were absent, and left saying so after they landed.** The first two
boxes describe work that this branch itself did; the section went on claiming the v2 files were
missing and scheduling the vendoring as future work. `scripts/tick-citations.mjs` checks only
`[x]` items, so an unticked box that is actually done bypasses the citation rule completely —
the checker cannot fail what never claims to be finished. Found by CodeRabbit reviewing this
pull request, and corrected here rather than left as a task nobody would start.

- [x] `Domovoi Desktop V2.dc.html` and the eight other v2 files were **not** in the vendored
      handoff, so the repo could not read them and every design fact that week arrived through
      chat. That was the bottleneck, and it was the fork-not-a-copy deferral showing its real
      cost. (`42cd0af`)
- [x] Vendor them as data under `design/`, digested, using
      `pnpm design:revision --accept-new=<path>` per file. Nine `.dc.html` files plus the two
      exported Desktop V2 parts, fourteen entries in `design/REVISIONS.json`.
      (`42cd0af` · Desktop V2 as its two parts `02459d6`)
- [x] Then a grep of `design/` answers presence **and** absence *within the recorded
      revision* — which is the only absence it can ever answer. It says nothing about the
      live project, and it cannot prove the export was complete. State that scope wherever
      the claim is repeated; see `D1`, where the same snapshot is one of three copies that
      nothing keeps in step. (`42cd0af`)

#### The four screens that are already partly built
Not eight unstarted screens. Reconcile these four against their designs rather than
building them:
- [ ] **Phone v2** — `apps/mobile/src/screens/` already has nine: approval, artifact,
      deny-explain, fleet, review, session, sessions, settings, unpaired. Design has 19
      frames. Diff the sets before writing anything.
  - [x] The diff is done, read-only, 2026-09-10 (7f24d8c7). Eight frames built, eight partial,
        three with nothing: 09 pairing by camera, 13 and 14 attachments, 19 pinned plan sheet.
        Estimate for the rest of Phone v2 is 13-15 days, which is what `SHIP-PLAN.md`'s `S3.3`
        line costs. Full table in `~/.agents/plans/2026-09-10-domovoi-cc5-phone-v2-diff.md`.
  - [x] No frame is blocked on Codex (34282f89). Checked before raising a request, and the
        request was not warranted: `terminalOwnershipNotificationSchema` (`rpc.ts:918`) already
        carries `owner: { client, clientId }` for frame 04, and `annotationAnchorSchema`
        (`schema.ts:762`) already takes a `bbox` beside the selector and quote for frame 18.
        Both were called blocked from grepping `apps/mobile/src` without reading the protocol.
  - Method note, both directions. `camera|BarCode|qrcode|scanner` and
    `attachment|Picker|photo|image` each match exactly one line in `apps/mobile/src`, and both
    matches are comments about work not done: a presence grep answered yes where the code says
    no. The reverse cost a wrong row in the same pass — frame 01 was written up from grepping
    `needs|Needs|group`, which missed `attention`, `approvalLead`, `waitingCount` and
    `ApprovalLeadCard` because the concept is there under other words. `graft` found them in one
    call. Use it for "is this concept here"; a keyword search only answers "is this string here".
  - Found while correcting that: `groupSessions` and `sessionsNeedingYou`
    (`packages/ui/src/session-groups.ts:24,72`) have no callers outside their own test. The
    desktop already models the three groups the phone design draws, and nothing renders them.
    Belongs to `CC7` rather than Phone v2.
- [x] **Web v2** — diffed 2026-09-10 (34282f89). Two of six steps built, one partial, three with
      nothing: picking a machine, carrying on without the terminal, and Design review. 6-8 days.
      The machine picker stays in `S3.2` and is **marked blocked on Phase 2** rather than moved:
      a browser cannot reach a second machine without the relay or a tailnet route, so part of
      Web v2 cannot land before the relay and Web is not a fully parallel Phase 3 surface.
- [x] **Onboarding** — diffed 2026-09-10 (34282f89). Two of five steps built. 4-5 days for the
      client half. One gap, and one contradiction that turned out not to exist.
  - **There was never a contradiction here. Do not re-open it.** "Install it for me" is Domovoi
    installing **its own** daemon — `Download domovoi 0.9.4 → /usr/local/bin/domovoi`, with the
    manual command and a Copy control beside it. `providerFirstRunRecovery` is about **third-party
    agents**, and the design says the same thing it does: the aider card at
    `Domovoi v2 Onboarding.dc.html:645` reads "Not installed here. Domovoi will not install agents
    for you, it only runs what is already on the machine", its button is `Install guide`, and its
    detail is `$ pipx install aider-chat` — a command to run yourself, not an action Domovoi
    takes. Two different installers. The earlier ruling matched on the word "install" and not on
    the subject, which is the same error as the handoffs/Transfers rename, and it was made from
    this report rather than from the file.
  - [ ] "Sign in to Domovoi Cloud" needs an account service that does not exist. `S0.1`/`S5.1`,
        not client work.
- [x] **Skills** — diffed 2026-09-10 (34282f89). Nearly done: install preview, scope, trust,
      `SKILL.md` view, fleet inventory comparison and per-turn selection all real. 3-4 days,
      almost all of it the one missing surface — "read the diff and re-review".
  - [ ] **Blocking, not a gap. Ruled 2026-09-10 by fetzy.** A changed skill drops to untrusted and
        re-approving shows nothing, so the person approves a digest rather than a change. That is
        a consent flow that cannot state what it is asking for — the same shape as a check row
        reading pass when nothing ran. It is load-bearing for the whole skills trust story rather
        than polish on a 3-4 day surface, and it gates `S3.x` Skills rather than sitting inside
        it.

**All four diffs are done. `CC5`'s estimate half is complete: 26-32 days for four of Phase 3's
nine `S3.x` items, with Tablet, Cloud, Team, cross-cutting states and accessibility uncounted.
A whole-phase figure of 45-60 days is the honest shape. Two milestone questions are raised in
`~/.agents/plans/2026-09-10-domovoi-cc5-remaining-diffs.md` and are fetzy's to answer: whether
`S3.5` Tablet leaves M3, and whether M2 is phone-gates-only rather than phone-parity.**

#### The three that genuinely have no code
- [ ] **Tablet v2** — nothing in the repo.
- [ ] **Cloud** — nothing named cloud; one Desktop mention, as a transport.
- [ ] **Team** — nothing; closest is fleet admission and pairing.
- `WorkspaceSurface` is `"workspace" | "providers" | "skills" | "fleet" | "audit"`. Any new
  desktop surface extends that union, which makes it a protocol-adjacent change worth
  flagging to Codex even though the file is Claude Code's.

#### States are cross-cutting, not a screen
- [ ] Empty, loading skeleton, failed-to-load, no-results and nothing-run-yet, applied to
      each existing surface rather than built as one screen.
- [ ] The rule the design encodes: **a partial thread reads like a finished one**, so a
      failed read renders nothing and states what is still true.
- [ ] No-results and not-searched are different answers. Never round one into the other.

#### `apps/mobile`'s sub-floor type sites — closed
Three of this item's premises were wrong, checked before widening anything. fetzy ruled
2026-09-10: no new role below `machine`, the sites move onto existing variants, and the phone's
floor is **higher** than the desktop's rather than lower.

- [x] **Nineteen sites, not eight** (eedb10cd for nine, this commit for ten more). Four in `screens/session.tsx` (56, 86, 90, 139), two in
      `screens/artifact.tsx` (32, 42), one each in `components/tab-bar.tsx` (56) and
      `components/ui/badge.tsx` (48) — and `screens/fleet.tsx:48` at `text-[8.5px]`, which the
      inventory missed and which is the smallest of them.
- [x] **The three role names did not resolve in `apps/mobile`** (eedb10cd). The rule's message says to use
      `text-eyebrow`, `text-mono-xs` or `text-micro`. `apps/mobile/tailwind.config.js` has no
      `fontSize` at all — it reads only `colors`, `fontFamily` and `radius` from
      `tokens.generated.js`, and that file carries no type scale. Widening the glob would flag
      nine sites and offer three utilities that resolve to nothing in nativewind, so every fix
      it prompted would be wrong.
- [x] **The phone's scale is deliberately not the desktop's** (eedb10cd)., so emitting the desktop floor
      into mobile is not the fix either. `components/ui/text.tsx:22` says why: "A phone is read
      at arm's length rather than desk distance, so the scale is tighter than the desktop's."
      Its nine `Text` variants are the phone's real role system, bottoming out at
      `machine` 10px and `note`/`label` 10.5px.
- [x] **The design question is answered** (eedb10cd). does the phone have a floor, and
      what is it? Either the nine sites take an existing `Text` variant, or the phone's scale
      gains a named role below `machine`. Both are decisions about the phone's type system.
      Until one is answered, widening the glob turns a real question into nine lint errors with
      no correct fix.
- Restating the desktop's scale in raw px is the same shape the token pipeline exists to stop.
  `scripts/mobile-tokens.mjs` derives colours and radii from `packages/ui/src/styles.css`; the
  type scale is the one part still written out by hand on both sides.

#### `--transition-control` is still a colour in the vendored manifest
- [x] The live `tokens/motion.css` annotates all seven motion tokens `@kind other`. The
      seventh, `--transition-control`, was written upstream on 2026-09-13; its value names
      `border-color` and `color`, so unannotated it classified as a colour and the generated
      type-floor rule read a transition as one. Re-vendored in #395 (6f729747).
- [ ] Second pass, easy to lose: the classification lives in the compiled manifest, not the
      source. `design/design_system_domovoi/_adherence.oxlintrc.json` still carries
      `"--transition-control": "color"` under `x-omelette.tokenKinds`, and will until the
      design app recompiles the manifest and the file is re-vendored. What does not trigger
      that recompile, tried 2026-09-13: opening the project, and two DesignSync writes to
      `_ds/.../tokens/motion.css` (the annotation, then a same-bytes touch), each followed by
      a read of the live manifest. So the self-check runs inside the Claude Design app, on
      its own edits, and this item's owner is whoever next edits the design system in the
      app itself. Done when this reads `other`:
      `grep -n '"--transition-control"' design/design_system_domovoi/_adherence.oxlintrc.json`
      Then `pnpm design:revision` and `node scripts/design-rule.mjs` to regenerate the rule.

---

## Phase 4 — distribution and signing — M1 onward

- [ ] **S4.1 [H]** Certificates, from S0.7.
- [ ] **S4.2 [CC]** macOS notarization and stapling; Windows signing; Linux packages.
- [ ] **S4.3 [CC]** Homebrew tap, winget, apt and rpm repos, and a `curl | sh` you are
      willing to defend in public.
- [ ] **S4.4 [H]** App Store and Play Store listings, review, and privacy disclosures that
      match the architecture exactly rather than approximately.
- [ ] **S4.5 [CC]** TestFlight, and an internal desktop update channel.
- [ ] **S4.6 [CX]** Release provenance: SBOM, reproducible builds, published digests. Owns
      the reproducible build: two clean builds from one commit, byte-compared before
      publication, with the comparison in the release record (`S1.4`'s design names the
      shape). `S1.4` consumes it. SBOM and `SHA256SUMS` exist in `scripts/release-artifacts.mjs`
      (b2e58881); the comparison does not, and no artefact has been published to attach any of
      it to.

### From the roadmap: package and release the open core (Goal 4)

Priority: `P2`. Every install channel must wrap the same immutable release.

#### Release engineering and semantic versioning

Release tooling exists; no package is published from this repository yet. Finish this section
before any public package or application publish.

- [x] Add Changesets and require release metadata for every publishable change before any public
  publish
  - Changesets, the `@getdomovoi/*` fixed version group, `pnpm changeset`, and `pnpm release:status`
    are in place.
  - CI runs `release:metadata` against each pull request's base. New source or lockfile changes
    require a new note, not an accumulated note from another PR. Real Changesets CLI fixture tests
    cover generated version PRs, whose content-only exemption cannot smuggle source or dependencies.
  - That step is conditioned on the pull-request event in `ci.yml`, so it covers changes that
    arrive through a pull request, not every commit. A commit pushed straight to `main` skips the
    step, and a skipped step is not a job failure, so the release gate below still passes for it.
- [ ] Make `0.1.0-alpha.0` the first public alpha release
  - Changesets pre-release mode numbers from zero and the workflow never sets a version by
    hand, so the first tag the tooling produces is the one that ships. `docs/distribution.md`
    records the same number. No public version or prerelease state is committed yet.
- [x] Keep package, app, daemon, protocol, and CLI versions in lockstep through `0.x`, and treat
  compatibility as one release unit
  - A fixed Changesets group moves every workspace version together.
  - `pnpm release:invariants` fails CI when a manifest version drifts.
- [ ] Automate Changesets version PRs, changelogs, Git tags, npm publishing with provenance, and
  GitHub Releases from the same immutable commit
  - Repository mechanisms are implemented, not yet proven by a hosted publication.
    `release.yml` opens version PRs, packs once, verifies downloaded archives, and publishes the
    protocol before the daemon. Alpha uses its own npm channel. A single canonical `v<version>`
    GitHub release matches the bootstrap URL and stays a draft until all asset hashes are checked.
    Local tests cover real Changesets versioning, artifact binding and API refusal/order behavior;
    account admission, provenance and the first public install still need a hosted release.
  - Its `gate` job runs `pnpm release:gate`, and `scripts/release-gate.mjs` refuses to continue
    until the `ci` run for that exact commit has concluded success with every one of its jobs
    concluded success too. A run reporting no job at all, and a job that was skipped rather than
    run, are refusals rather than passes. A release therefore inherits the Linux, macOS, and
    Windows matrix, the packed-daemon musl check, and the production dependency audit instead of
    re-running a Linux-only subset of them. While a run is still going, and while no run exists
    for the commit at all, the gate polls every 30 seconds for up to 45 minutes and then fails, so
    an absent or unfinished verdict is a refusal rather than a publish.
    `scripts/release-gate.test.mjs` covers each of those outcomes.
  - Nothing else gates the release: `main` carries no branch protection and no ruleset, so there
    is no required status check anywhere and this workflow is the whole gate.
  - `wsl.yml` is path filtered and scheduled rather than run on every commit, so it is not part
    of that gate. Making a path-filtered workflow a per-commit requirement would leave it
    pending on every commit outside its paths.
  - `RELEASE_PUBLISHING=version-only` permits version PRs without publication; `enabled` permits
    publication too. Missing or unknown values permit neither. Initial public alpha admission
    requires an explicit manual request and a temporary protected-environment token because npm
    requires existing packages before OIDC setup. Normal runs never receive that token.
  - On 2026-09-06, read-only checks found the variable and `npm` environment absent, Actions PR
    creation disabled, and both npm packages missing. npm organization ownership was not proved.
    Repository read-only token defaults can stay. The ordered maintainer-only setup and first-run
    proof requirements are in `docs/release-setup.md`.
- [ ] Add Homebrew and AUR publishing later, after signed and checksummed GitHub Release artifacts
  are stable

#### Distribution and packaging

- [ ] Define compatibility, deprecation, and release-support policy
- [x] Verify npm artifacts install and run through npm, pnpm, and Bun
  - `pnpm test:install` packs the protocol package, installs the tarball with each package manager,
    and imports it; a missing package manager fails CI.
- [ ] Build signed desktop installers for macOS, Windows, and Linux
  - `pnpm package:desktop` builds the host platform's installers with electron-builder from the
    same electron-vite output the launch smoke runs, then proves the result with
    `apps/desktop/scripts/package-smoke.mjs`.
  - Linux is built and verified. The AppImage and the deb keep node-pty and the keyring binding
    outside the asar, the packaged application loads both from the archive on the main thread and
    in a worker thread, starts the production daemon, and renders its window.
  - macOS and Windows are configured and unbuilt. Neither target has run on its own platform, so
    the dmg, the zip, and the NSIS installer are unproven.
  - Nothing is signed, so this item stays open until the line below closes.
- [ ] Add macOS signing/notarization and Windows code signing
  - The shared packaging policy enables mandatory Developer ID signing and notarization on
    macOS, or Azure/PFX signing on Windows, only with complete credentials. Partial or broken
    configuration fails. No credentials still permits an explicit development build.
  - `desktop-signing.yml` is a manual, main-only native build behind the exact-commit CI verdict
    and separate protected platform environments. It verifies signatures and the Mac application
    ticket before uploading installers, and has no release publishing permission.
  - This remains open: Apple/Microsoft accounts and credentials, the first native signing runs,
    clean-machine launch and trust checks are unproven. See `docs/desktop-signing.md` for exact
    setup, credential custody, bounded CI waits and evidence limits.
- [ ] Publish SHA-256 checksums and SBOMs for release artifacts
  - `pnpm release:artifacts` generates the tarballs, per-artifact CycloneDX SBOMs, and `SHA256SUMS`,
    and runs on Linux in CI.
  - E2 completeness fix: membership and SHA-512 component hashes come from the packed
    all-platform runtime lock, including optional non-host binaries and the embedded protocol.
    The separate protocol artifact is byte-bound to that lock and reports only its closure.
    Offline pinned CycloneDX 1.6 validation and a real-archive completeness regression cover
    generation. Host license observations annotate exact versions only; missing observations
    remain empty. External toolchains and unfrozen manual installs are outside this inventory.
  - The release workflow attaches them to the canonical `v<version>` GitHub release once enabled.
- [ ] Add a Windows package-manager manifest after installer signing is stable
- [ ] Choose and publish the Linux AppImage/native package set
- [ ] Add daemon and desktop update checks with explicit user control
- [ ] Add rollback and compatibility handling for daemon/client protocol mismatches
- [x] Pin GitHub Actions by immutable commit SHA, verified by `pnpm release:invariants`
- [x] Replace the no-op lint gate with real TypeScript/React linting
- [x] Remove the artifact preview revision race in `apps/daemon/src/server.test.ts`
  - A signed URL pins one artifact revision, so rewriting the file it addresses moves the artifact
    to its next revision and the daemon refuses the pinned capability with `404 not_found`. That
    refusal is the contract: the signature covers a revision whose content the file no longer
    holds, and the daemon reads the file at fetch time.
  - The test reused capabilities across its own writes and passed only while it beat the watcher
    debounce. It now injects the artifact watcher, delivers each change itself, authorizes the
    revision the daemon holds, and asserts that the stale capability is refused.
- [ ] Review or replace dependencies whose licenses do not fit the public daemon
  - `pnpm license:audit` holds the publishable production graph to a permissive allowlist in CI.
  - One recorded exception remains: the proprietary Claude Code agent SDK. See
    [docs/licensing.md](docs/licensing.md) for the removal options.
- [x] Move build-time tooling such as the shadcn CLI out of production dependency graphs

## Phase 5 — accounts and billing — M3 and M4

- [ ] **S5.1 [H]** Payment provider, tax handling, invoicing, dunning.
- [ ] **S5.2 [CX]** Account and org model: seats, machine grants, and the rule that a seat
      reaches nothing until the org grants it a machine.
- [ ] **S5.3 [CX]** Per-seat billing reconciled against seat entitlements, with a user-visible
      breakdown. Relay connected-time reporting remains separate, for entitlement and abuse
      control, not invoice lines; corrected by the 2026-09-16 framing record at S2.10.
- [ ] **S5.4 [CX]** Org policy enforcement, including that an unreachable machine keeps
      enforcing the last policy it received.
- [ ] **S5.5 [CX]** Cross-person history: records decisions, carries no prompt, diff or
      thread.
- [ ] **S5.6 [CC]** Team and billing surfaces wired to real data. Split at the layer
      boundary — S5.2 lands before this.

## Phase 6 — security proof and operations — M3

The product's argument is trustworthiness. Asserting it is not shipping it.

- [ ] **S6.1 [H]** Third-party audit of the relay and the crypto design. Publish the result.
      Book in Phase 0. External work, recorded by date and artefact: see `S0.2`; not started
      as of 2026-09-15, no engagement letter in the repository.
- [ ] **S6.2 [H]** Threat model and a vulnerability disclosure policy.
- [ ] **S6.3 [CX]** Observability that cannot leak session content: an error taxonomy
      carrying codes, routes and timings, never payloads. The tension is real — you cannot
      debug what you refuse to see — so the taxonomy is designed up front rather than grown
      from incidents.
- [ ] **S6.4 [H]** Status page, on-call rotation, incident comms template.
- [ ] **S6.5 [H]** ToS, privacy policy and a team DPA that match the architecture rather
      than the marketing.
- [ ] **S6.6 [CX]** Backup and restore for the account and machine registry. It was called
      the only stateful thing you own; the relay's connected-time ledger is the other, and it has its
      own gate at `S2.11`. The two stores stay separate.

## Phase 7 — docs, site, launch — M3

- [ ] **S7.1 [CC]** Docs: install per platform, pairing, the permission model, skills trust,
      transfer semantics, and what the relay does and does not see. Windows install docs must
      say scheduled task, not service: the current Windows implementation registers a
      per-user scheduled task in `service/install.ts`, and the word "service" there would be
      a promise nothing provides.
- [ ] **S7.2 [CC]** The marketing site. The design system flags it as WIP and needing
      another pass.
- [ ] **S7.3 [H]** Pricing page consistent with S0.1 and S0.3.
- [ ] **S7.4 [CC]** In-product first run: install to first approved command without docs.
- [ ] **S7.5 [H]** Beta cohort on real machines. WSL and remote dev servers especially,
      since that is where the transport story is hardest.

---

### From the roadmap: public product and ecosystem (Goal 5)

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

---

## Post-MVP expansion

These are valuable but must not displace the secure single-user fleet workflow:

- [ ] encrypted client-side provider-key vault sync
- [ ] team organizations, roles, shared projects, policies, and audit retention
- [ ] hosted relay regions and enterprise self-hosting
- [ ] native iOS and Android shells where PWA limitations justify them; the phone app under
  Goal 3 is that shell's start, not its finish
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
   custody model. Since 2026-09-04 a `.sig` declaration is verified as an Ed25519 signature over
   the content digest against the local trust file, so a signature from a key a person added to
   that file grants trust on that machine alone. Manual review remains the other trust path: a
   person reviews an exact content digest on one machine, the daemon records that decision with
   the reviewing client, and the skill stays trusted only while its content digest still matches.
   Any content change drops it back to untrusted, and an invalid signature stays blocked
   regardless of review. Still undecided: where trusted keys come from beyond a person adding them
   by hand, how a key is revoked, and who holds signing keys. Deferred past the alpha on
   2026-09-03; the local trust file is the interim position, so the registry, revocation source,
   and custody model can be settled after it.
3. **Build auto execution boundary:** whether Build auto authorizes repository-controlled code to
   run unattended inside a containment boundary. An allowlisted runner executes files the
   repository owns, so a standing rule for `pnpm test` whose body stays `vitest run` still permits
   a changed `vitest.config.ts`, setup file, plugin, or test file to run with the daemon user's
   permissions, and no command pattern can see that. If the answer is yes, bounded has to mean
   bounded by sandbox and capabilities rather than by a list of trusted command names. If it is no,
    every package manager command is a hard gate and Build auto is narrower than this roadmap
    describes.
4. **Account requirement:** which local capabilities, if any, require a Domovoi account after the
   hosted service exists.
5. **Public site direction:** architecture-led or folklore-led narrative after real product
   screenshots are available.
6. **Packaging formats:** final Linux package set and Windows package-manager targets.
7. **Support policy:** stable release cadence, supported versions, protocol compatibility window,
   and security backport duration.

## Resolved architecture decisions

- Electron is the desktop shell; the shared React UI remains browser-capable.
- pnpm manages the monorepo; published ESM packages remain npm and Bun compatible.
- WebSocket JSON-RPC is the client/daemon protocol; gRPC is not required for the current surfaces.
- The daemon owns sessions, Git, tools, terminals, credentials, and canonical state.
- Code stays on its execution machine; Domovoi does not add a filesystem sync layer.
- No credential grants control of a machine whose owner did not grant it, and membership of an
  organization is never itself a grant. A machine is owned by a person or by an organization,
  and only an organization's own machines, such as a shared development server or an
  on-premises inference machine, can be granted to other people. This holds at every price;
  there is no tier that reaches another person's machine.
- Remote connectivity prefers direct private-network transport, then a configured end-to-end
  encrypted relay. The route protocol and daemon connection manager are Apache-2.0; the official
  relay implementation and operated service are separately licensed commercial components.
- SQLite is owned directly by the daemon; an ORM is not currently justified.
- Domovoi is open-core. The daemon, protocol, clients, and local transports are Apache-2.0; the
  official relay implementation and hosted account, billing, vault, and team services are
  separately licensed commercial components.
- Claude Design's app and brand handoffs remain the design source of truth.
- Guest sessions are not a product feature. Short-lived guest access existed to keep early daemon
  development from locking itself out, and that need is gone. Domovoi sells reachability to a
  person's own machines, so a guest login, guest attribution, and a guest hard-gate policy are
  out of scope. The signed design handoff still names guest browsers; it is not edited here and
  a future handoff has to settle that difference.
- A session transfer is refused at the moment it is requested rather than queued, so a session never
  changes hands later and unattended. Transfer preflight refuses an unreachable target, a target
  that is not answering, a target on an incompatible protocol in either direction, a target that
  needs an upgrade, a target that does not run sessions, and the machine already holding the
  session. This resolves open question 1 in the signed design handoff, whose `UNREACHABLE` and
  unselectable treatment of offline machines already showed this path.

## M1 definition of done

Carried from the roadmap's first public alpha definition, restated for M1. M1 is ready only
when all of these are proven:

- Phase 1 is complete: the roadmap's Goal 0 and Goal 1 blocks below it are ticked, except
  direct API adapters that duplicate a capable subscription CLI.
- `S3.0` answered yes: a paired phone attaches to a desktop session over the tailnet route
  and answers a gate on real hardware.
- A signed desktop build can install, start, update, and remove its supervised local daemon.
- A new user can open a repository, start an agent, review tool activity, annotate a plan, approve
  or deny consequential work, restore a checkpoint, and reopen the session after restart.
- Every supported provider failure produces an actionable state without losing the worktree.
- No product surface claims a hosted relay, push notifications, or account behaviour that is
  not yet implemented.
- Installation and recovery documentation has been tested on Linux, macOS, and Windows.

## Critical path

```
Phase 1 daemon as a service  →  S3.0 tailnet check  →  S3.3 phone pairing and gate  →  M1
                                                        S1.4 update  →  Phase 4 signing  ↗
Phase 2 relay (own gates)  →  Phase 5 accounts and billing  →  M3 paid launch
```

Phase 4 runs alongside Phase 1. S0.7 and S6.1 are calendar, not engineering, and started in
Phase 0.

## Where each agent is, 2026-09-14

**Codex**: `S1.4` to completion (protocol layer first), then `S1.1`'s open acceptance, then
the protocol half of `skill push` for `S1.6`. The relay adapter waits.

**Claude Code**: `S3.0`, the check before the build, on real hardware. Then `S3.3` in the
order it states. `S3.4` goes to the maintainer as two options.

**Neither** adds a carrier by adding a branch. The transport list is the only place a new
route goes.
