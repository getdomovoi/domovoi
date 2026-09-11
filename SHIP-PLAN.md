# Domovoi — road to shipped

Companion to `WORK-SPLIT.md`. That file holds the remaining v2 design reconciliation.
This one holds everything between here and a paid launch.

**Codex** owns the daemon, the protocol and the relay server. **Claude Code** owns the
clients and the repo's own tooling. `[H]` marks work only a human can do — a decision, a
legal document, a vendor account, a certificate.

Task ids are stable and phase-prefixed (`S2.3`) so they cannot collide with
`WORK-SPLIT.md`'s (`CX1`, `CC4`).

---

## How the two agents work this file

Same six rules as `WORK-SPLIT.md` — one agent per file per session, protocol before the UI
that reads it, `graft callers` before editing an enum, mutation probes only against a
shippable tree, never regenerate a digest in the commit it covers, read the reviews not the
check row. Three more that this file needs:

1. **An `[H]` gate stops the work, not the thinking.** When you reach one, draft the
   decision as options with consequences and stop. Do not pick. A gate reached with a
   written options doc costs a human minutes; a gate reached with an assumption already
   coded costs a rewrite.
2. **`WORK-SPLIT.md` finishes or gets parked before Phase 3.** Claude Code cannot reconcile
   v2 designs and build new surfaces in the same files in the same week. Park explicitly, in
   writing, with what was left.
3. **Long-lead items start out of order.** Certificates and an audit booking have calendar
   cost, not engineering cost. They sit in Phases 4 and 6 and they begin in Phase 0.

---

## Milestones, so there is something to cut against

| | Ships when | Excludes |
|---|---|---|
| **M1 · local alpha** | daemon installs as a service, loopback only | relay, billing, mobile |
| **M2 · connected beta** | tailnet and relay transports work, invite-only, phone answers gates | billing, teams, phone parity |
| **M3 · launch** | paid, metered, signed, audited | teams, tablet |
| **M4 · teams** | seats, org machines, org policy | — |

If a task does not serve the next milestone, it waits.

---

## Phase 0 — the gates

Cheap now, expensive later. **Nothing in Phase 2 starts without S0.2 and S0.6.**

- [ ] **S0.1 [H] The open-core line.** Which capabilities are Apache 2.0 and which are paid.
      Hard to reverse once published.
- [ ] **S0.2 [H] Relay crypto design, written and reviewed.** "Carries encrypted payloads it
      cannot read" is the product's central claim. Key exchange, forward secrecy, what the
      relay sees in the clear (it must see routing metadata), rotation, and recovery when a
      device is lost. Cannot be retrofitted.
      *Agents may draft: threat model, two or three candidate designs with tradeoffs, and
      what each implies for device loss.*
- [ ] **S0.3 [H] What the relay retains.** Billing by machine requires knowing which
      machines were active and for how long. "Payloads unreadable" and "nothing recorded"
      are different claims. State both halves publicly.
- [ ] **S0.4 [H] How tier enforcement is trusted.** Free is JSON-RPC only and the *daemon*
      refuses the terminal, so the daemon must learn its tier and verify it. Signed tier
      claims the daemon checks, or the refusal is advisory and the paywall is decorative.
- [ ] **S0.5 [H] The four open product decisions** in `HANDOFF-NOTES.md`: transfer to an
      offline target, what the handoff UI may promise, skill install trust, guest browser
      session scope.
- [ ] **S0.6 [H] Where the relay lives.** Follows S0.1. Until it is answered, the relay has
      no directory and Phase 2 cannot be scaffolded — `apps/relay` in this monorepo and a
      separate private repo are different answers about what ships open.
- [ ] **S0.7 [H] Start the long-lead clock.** Apple Developer enrolment, Windows
      code-signing certificate, and a first conversation with an audit firm. Weeks of
      calendar, zero engineering.

## Phase 1 — the daemon becomes an installed service — M1

Parallel with Phase 0. Touches nothing the gates decide.

- [ ] **S1.1 [CX]** Service lifecycle per platform: launchd, systemd, Windows service, and
      WSL's init gap.
- [ ] **S1.2 [CX]** Version negotiation. A v0.9 client against a v1.2 daemon refuses
      clearly rather than half-working.
- [ ] **S1.3 [CX]** Crash recovery: an interrupted turn, a half-written worktree, an
      orphaned transfer lease.
- [ ] **S1.4 [CX]** Auto-update, signed and verified. A self-updating daemon holding your
      credentials is a supply-chain target, so signature verification and reproducible
      builds ship *with* it, not after.
- [ ] **S1.5 [CX]** Log rotation, and the count-based audit retention (10k activity, 1k
      pre-auth) proven across restart.
- [ ] **S1.6 [CX, not CC]** CLI to parity: install, status, pair, doctor, skill push, logs.
      **Reassigned 2026-09-10, and Codex agreed (`257830e`).** The binary is `domovoid`, declared at
      `apps/daemon/package.json:20` against `apps/daemon/dist/index.js`, and every CLI file is
      under `apps/daemon/src/` — Codex's half by `WORK-SPLIT.md`'s ownership table, so `[CC]`
      contradicts rule 1. Codex accepted it as `CX` and corrected the scope: `domovoid service
      install` and `domovoid service status` already exist (`index.ts:86`), so what is missing
      there is top-level aliases rather than the commands. `doctor`, `logs` and `skill push` do
      not exist and their behaviour is undefined. The naming is **settled, not open**: fetzy decided
      on 2026-09-10 that `domovoi` is the user-facing CLI and `domovoid` is the daemon process,
      with every human command moving off `domovoid` and the lifecycle noun being `daemon`. It was
      never a preference to be asked about — the design sources already specified it. Evidence in
      [`docs/cli-parity-decision.md`](docs/cli-parity-decision.md).
- [ ] **S1.7 [CX]** The accounting and turn-record work from `WORK-SPLIT.md` (`CX1`, `CX2`)
      lands here — it is daemon bookkeeping and it unblocks UI in Phase 3.

## Phase 2 — the relay — M2, critical path

Everything paid depends on this and it is the least built. **Blocked on S0.2 and S0.6.**

- [ ] **S2.1 [CX]** Machine registration and identity: device credentials, rotate, revoke —
      and revocation that reaches a machine which was offline when you revoked it.
- [ ] **S2.2 [CX]** Transport routing in the stated order — loopback, tailnet, relay — plus
      honest reporting of which route was chosen and why. `fleet.clientRoute` is already
      wired and has no surface.
- [ ] **S2.3 [CX]** NAT traversal and fallback. Tailscale covers the tailnet case; the relay
      covers the rest.
- [ ] **S2.4 [CX]** Degraded and queued behaviour under real packet loss, not just as drawn.
- [ ] **S2.5 [CX]** Metering: machine-hours, emitted so billing can reconcile it and a user
      can audit it.
- [ ] **S2.6 [CX]** Abuse controls. A relay forwarding arbitrary encrypted bytes between
      machines is attractive infrastructure to someone else.
- [ ] **S2.7 [H]** Regions, latency targets, and an uptime commitment you can meet.
- [ ] **S2.8 [CX]** Load and soak with sessions held open for days, which is the real usage
      shape.
- [ ] **S2.9 [CX]** Tier claim verification in the daemon, per S0.4.

## Phase 3 — clients to parity — M2 and M3

Starts when the protocol is stable, and after `WORK-SPLIT.md` is done or parked.

- [ ] **S3.1 [CC]** Desktop: `WORK-SPLIT.md`'s `CC1`–`CC3`, then the remaining surfaces.
- [ ] **S3.2 [CC]** Web: the six-step flow, always over the relay, with capability-refused
      real rather than drawn. **Partly blocked on Phase 2**, so this is not a fully parallel
      Phase 3 surface: "pick a machine to attach to" cannot land before the relay or a tailnet
      route, because a browser has no way to reach a second machine without one. Two of six
      steps are built; 6-8 days, and that step is inside the estimate rather than beside it.
- [ ] **S3.3 [CC]** Mobile: 19 designed frames against nine existing screens. 13-15 days for
      all of it. **On M2 this is the gate path only** — frames 02-05, the gate and its outcomes,
      which are already built. 3-4 days rather than 13-15 on the critical path. The rest follows
      after M2. Decided by fetzy 2026-09-10: the phone exists to answer gates, so shipping it
      that way is the phone doing its job rather than a cut-down version of it.
- [ ] **S3.4 [CC]** Push notifications for gates. This is the phone's whole reason to exist.
      Needs APNs and FCM, and a payload carrying no session content — which means the
      notification says a gate is waiting and never what it is asking for.
- [ ] **S3.5 [CC]** Tablet: nothing exists yet. **Cut from M3, decided by fetzy 2026-09-10.**
      It is the only one of the nine that is pure new build with no reconciliation to reuse, and
      the only surface with no unique job: the phone owns gates away from the desk, the desktop
      owns the work, and the tablet is a larger phone or a smaller desktop depending on the
      frame. Neither is a reason to ship it before people are paying.
- [ ] **S3.6 [CC]** Cloud and Team surfaces; the cross-cutting states (`CC7`).
- [ ] **S3.7 [CC]** Accessibility: focus order, screen-reader labels, and the StatusDot rule
      — colour is never the sole carrier — enforced everywhere.
- [ ] **S3.8 [CC]** Offline and reconnect on every client, including unconfirmed work on
      return.
- [ ] **S3.9 [CC]** Any new `WorkspaceSurface` member. **Corrected 2026-09-10: this said
      `[CX]` on a false premise.** The union is `"workspace" | "providers" | "skills" | "fleet"
      | "audit"`, and it was called protocol-adjacent — but it is declared at
      `packages/ui/src/workspace-persistence.ts:23`, and `graft grep` finds its fourteen uses
      across five `packages/ui` files and none in `packages/protocol`. It is a UI persistence
      type. Being a union does not move a file out of its owner's half; if a surface ever has
      to cross the wire, that is a separate `CX` protocol commit, and this one stays `[CC]`.

## Phase 4 — distribution and signing — M1 onward

- [ ] **S4.1 [H]** Certificates, from S0.7.
- [ ] **S4.2 [CC]** macOS notarization and stapling; Windows signing; Linux packages.
- [ ] **S4.3 [CC]** Homebrew tap, winget, apt and rpm repos, and a `curl | sh` you are
      willing to defend in public.
- [ ] **S4.4 [H]** App Store and Play Store listings, review, and privacy disclosures that
      match the architecture exactly rather than approximately.
- [ ] **S4.5 [CC]** TestFlight, and an internal desktop update channel.
- [ ] **S4.6 [CX]** Release provenance: SBOM, reproducible builds, published digests.

## Phase 5 — accounts and billing — M3 and M4

- [ ] **S5.1 [H]** Payment provider, tax handling, invoicing, dunning.
- [ ] **S5.2 [CX]** Account and org model: seats, machine grants, and the rule that a seat
      reaches nothing until the org grants it a machine.
- [ ] **S5.3 [CX]** Metered billing reconciled against relay usage, with a user-visible
      breakdown.
- [ ] **S5.4 [CX]** Org policy enforcement, including that an unreachable machine keeps
      enforcing the last policy it received.
- [ ] **S5.5 [CX]** Cross-person history: records decisions, carries no prompt, diff or
      thread.
- [ ] **S5.6 [CC]** Team and billing surfaces wired to real data. Split at the layer
      boundary — S5.2 lands before this.

## Phase 6 — security proof and operations — M3

The product's argument is trustworthiness. Asserting it is not shipping it.

- [ ] **S6.1 [H]** Third-party audit of the relay and the crypto design. Publish the result.
      Book in Phase 0.
- [ ] **S6.2 [H]** Threat model and a vulnerability disclosure policy.
- [ ] **S6.3 [CX]** Observability that cannot leak session content: an error taxonomy
      carrying codes, routes and timings, never payloads. The tension is real — you cannot
      debug what you refuse to see — so the taxonomy is designed up front rather than grown
      from incidents.
- [ ] **S6.4 [H]** Status page, on-call rotation, incident comms template.
- [ ] **S6.5 [H]** ToS, privacy policy and a team DPA that match the architecture rather
      than the marketing.
- [ ] **S6.6 [CX]** Backup and restore for the only stateful thing you own: the account and
      machine registry.

## Phase 7 — docs, site, launch — M3

- [ ] **S7.1 [CC]** Docs: install per platform, pairing, the permission model, skills trust,
      transfer semantics, and what the relay does and does not see.
- [ ] **S7.2 [CC]** The marketing site. The design system flags it as WIP and needing
      another pass.
- [ ] **S7.3 [H]** Pricing page consistent with S0.1 and S0.3.
- [ ] **S7.4 [CC]** In-product first run: install to first approved command without docs.
- [ ] **S7.5 [H]** Beta cohort on real machines. WSL and remote dev servers especially,
      since that is where the transport story is hardest.

---

## Critical path

```
S0.2 crypto design  →  S0.6 relay location  →  Phase 2 relay  →  M3 paid launch
```

Phases 1, 3 and 4 run alongside. S0.7 and S6.1 are calendar, not engineering, and start
immediately.

## If both agents start today

**Codex** takes Phase 1, which is real work that no gate blocks, beginning with `S1.7`
since `WORK-SPLIT.md`'s UI is already waiting on it. In parallel it drafts S0.2's candidate
designs without choosing one.

**Claude Code** finishes `WORK-SPLIT.md` — `CC2`, `CC3`, then `CC5`'s read-only diff work,
which produces the estimates for all of Phase 3. Then Phase 3's surfaces. `S1.6` used to sit here
and does not: it is `[CX]`, and leaving it in this paragraph is how a reassignment survives at the
top of a file and dies at the bottom.

**Neither** scaffolds the relay until S0.6 is answered. Its directory is a statement about
what ships open, and moving it later moves its whole history.
