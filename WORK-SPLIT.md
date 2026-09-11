# Domovoi v2 — remaining work, split two ways

Working document for a two-agent session. **Codex** owns the daemon and protocol.
**Claude Code** owns the clients and the repo's own tooling. Anything that crosses that
line is split into two commits, protocol first.

Task ids are stable. Reference them in commits and in chat (`CX3`, `CC7`).

---

## Ownership

| Area | Owner |
|---|---|
| `apps/daemon/src/**` | Codex |
| `packages/protocol/src/**` | Codex |
| `packages/ui/src/**` | Claude Code |
| `apps/mobile/**`, `apps/web/**` | Claude Code |
| `scripts/**`, `design/**`, `eslint.config.mjs` | Claude Code |
| `docs/**` | whoever changes the behaviour being documented |

### Rules that exist because they were already broken once

1. **One agent per file per session.** The mixed `+808 -41` tree cost a manual split.
   Declare the files you are about to touch before touching them.
2. **Protocol lands before the UI that reads it.** A client cannot be reviewed against a
   schema that is not on `main`.
3. **`graft callers` before editing any builder or enum.** `launcher-entries.test.ts`
   pinned a contract its filename could not reveal — Domovoi names test files for the
   behaviour, not the module, so filename search is structurally unable to find them.
4. **A mutation probe only counts against a tree you would ship.** A stray collected file
   invalidates the run you read.
5. **Never regenerate a digest in the same commit as the change it covers.** Verify against
   the previous manifest first, and say which state you verified against.
6. **Read the reviews, not the check row.** `Review rate limited` and `Review completed`
   both render as pass and both carry `state: success`. Only the description differs.
7. **The agent that owns this file ticks every box in it, including the other agent's.**
   This file sits in Claude Code's half of the tree but describes both halves, which rule 1
   did not anticipate. Codex ticking `CX1` here would put two agents in one file to record
   work that is already recorded in a commit. So the owner ticks, citing the other agent's
   sha, and ownership and evidence both survive.
8. **Every `[x]` names the commits that make it checkable.** `pnpm release:invariants` runs
   `scripts/tick-citations.mjs`, which fails a ticked box with no `(<sha>)` and fails a sha
   that is not an ancestor of this branch — a sha can exist in another ref and still fail. Ticks that predate the rule are exempted in
   `scripts/tick-citations-allowlist.json`; that list only shrinks, through `pnpm ticks:prune`.
   A plan written outside the repository is a claim with no evidence attached, the same shape
   as an undated tick: three of this file's boxes were already done on the day it was written.

---

## The blocked chain

Everything else is parallel. This is the only hard sequence, and it is three deep:

```
CX1  usage accounting + dedup + coverage        2-4 d
      └── CX2  turn records, ordinals, associations   2-3 d
            └── CC1  grow the turn meta line to four fields
```

`CX1` landing does **not** unblock `CC1`. The row cannot draw `3 tools · 12.4k tokens`
until the durable history-to-turn link exists, which is `CX2`. Write the pending comment
so the first landing does not read as the unblock.

---

## Codex

### CX1 · Usage accounting, dedup and coverage — 2-4 d
- [ ] Normalize adapter token reporting. Two undercount: `claude.ts:487`, `opencode.ts:506`.
- [ ] `acp.ts:296` gives `totalTokens` and `contextTokens` the same `update.used` value.
- [ ] Capture the model at dispatch. `server.ts:6903` writes usage against
      `session.runtime.model`, and `server.ts:5835` can change it on a same-provider update,
      so the record must keep requested model distinct from provider-reported.
- [ ] Persist accounting plus its dedup and coverage state across restart and transfer.
- [ ] Five hazards, all in scope: duplicate events, late events, failures, restart, transfer.
- [ ] Never infer a turn link from a timestamp or row position.
- Out of scope: new turn records, ordinals, message associations. Those are `CX2`.

### CX2 · Turn records, ordinals, message associations — 2-3 d
- [ ] Durable per-turn record with an ordinal.
- [ ] Associate messages with turns. Two dispatch paths: `server.ts:6504` steers an active
      turn, `server.ts:6595` appends another user message — a message is not a turn.
- [ ] Expose the history-to-turn link so a history row can name its turn.

### CX3 · Approval execution duration — 1 field
- [ ] Record how long the approved command ran, distinct from `decided in`.
      Decision latency answers "how long was the agent blocked"; execution duration answers
      "what did the approval cost". The design asks for the second and the UI currently
      shows the first.

### CX4 · Report the manifest defect upstream
- [ ] `_adherence.oxlintrc.json` marks `--transition-control` as `"color"`, after five
      correctly-marked `"other"` motion tokens. It is the **last key in `tokenKinds`**,
      which is a generator signature rather than a typo — report it as "the final entry's
      kind may be systematically wrong", since other manifests from the same emitter would
      carry it. Harmless to a font-size generator; a colour generator would accept it.

---

## Claude Code

### CC1 · Finish the history row — blocked on CX2 for the last part
- [ ] `<pre>` out of the row, meta on one line, body in a collapsed `details`.
- [ ] Checkpoint title drops the sha; title names the checkpoint, meta names the commit.
- [ ] Fork wired on checkpoint rows only, with a confirm stating both halves.
- [ ] The card: `1px --border`, `--radius`, rows separated by a border. Currently a bare div.
- [ ] Left **42px mono time column**. Time currently sits right of the title with no width.
- [ ] Replace the raw `span` dot with `StatusDot`, coloured by outcome rather than
      `bg-primary` on every row.
- [ ] Grow the turn meta to `turn 9 · sonnet-4.6 · 3 tools · 12.4k tokens` — **after CX2**.
- [ ] Record execution duration as an unfilled design field, not a satisfied one.

### CC2 · StatusDot takes an invisible label
- [ ] The label stops being visible; it does not stop being required. Meaning derives from
      `status` and `decision`, nothing invented.
- [ ] Any row whose title does not state its outcome gets the outcome word in the meta —
      failures especially. Colour is never the sole carrier.
- Own commit. Touches the atom, so it lands before `CC1`'s dot swap.

### CC3 · Revert the Handoffs label, add the transfers filter
- [ ] `6f2f875` renamed `handoffs` to Transfers. `handoffs` holds **provider** handoffs —
      `server.ts:461` selects rows starting `Handed off `, written at `server.ts:5812`.
      Revert the label to Handoffs.
- [ ] Add the `transfers` filter now that `560eca5` records machine transfers.
- [ ] Eight filters, drawn five leading:
      Everything, Turns, Approvals, Checkpoints, Transfers, then Handoffs, Tools,
      Annotations, Tests.

### CC4 · Vendor the v2 designs — do this first
- [ ] `Domovoi Desktop V2.dc.html` and the eight other v2 files are **not** in the vendored
      handoff, so the repo cannot read them and every design fact in the last week arrived
      through chat. That is the bottleneck, and it is the fork-not-a-copy deferral showing
      its real cost.
- [ ] Vendor them as data under `design/`, digested, using
      `pnpm design:revision --accept-new=<path>` per file.
- [ ] Then a grep of `design/` answers presence **and** absence *within the recorded
      revision* — which is the only absence it can ever answer. It says nothing about the
      live project, and it cannot prove the export was complete. State that scope wherever
      the claim is repeated; see `D1`, where the same snapshot is one of three copies that
      nothing keeps in step.

### CC5 · The four screens that are already partly built
Not eight unstarted screens. Reconcile these four against their designs rather than
building them:
- [ ] **Phone v2** — `apps/mobile/src/screens/` already has nine: approval, artifact,
      deny-explain, fleet, review, session, sessions, settings, unpaired. Design has 19
      frames. Diff the sets before writing anything.
- [ ] **Web v2** — `apps/web/src/` exists with browser platform, client kind, credential,
      daemon pairing. Design adds the six-step flow including Design review.
- [ ] **Onboarding** — `desktop-first-run-persistence.ts` plus first-run and recovery tests.
- [ ] **Skills** — `skill-browser-*.tsx`, and `skills` is a real `WorkspaceSurface`.

### CC6 · The three that genuinely have no code
- [ ] **Tablet v2** — nothing in the repo.
- [ ] **Cloud** — nothing named cloud; one Desktop mention, as a transport.
- [ ] **Team** — nothing; closest is fleet admission and pairing.
- `WorkspaceSurface` is `"workspace" | "providers" | "skills" | "fleet" | "audit"`. Any new
  desktop surface extends that union, which makes it a protocol-adjacent change worth
  flagging to Codex even though the file is Claude Code's.

### CC7 · States are cross-cutting, not a screen
- [ ] Empty, loading skeleton, failed-to-load, no-results and nothing-run-yet, applied to
      each existing surface rather than built as one screen.
- [ ] The rule the design encodes: **a partial thread reads like a finished one**, so a
      failed read renders nothing and states what is still true.
- [ ] No-results and not-searched are different answers. Never round one into the other.

### CC8 · `apps/mobile`'s eight sub-floor type sites
- [ ] Four in `screens/session.tsx`, two in `screens/artifact.tsx`, one each in
      `components/tab-bar.tsx` and `components/ui/badge.tsx`.
- [ ] Mechanical now: widening the lint rule's files glob is what lands it. The config
      comment already says so.

---

## Needs a decision before it can be worked

### D1 · `design/` holds a fork, not a vendored copy
`design/design_system_domovoi/readme.md` is a condensed 127-line summary in a different
voice against upstream's ~300 lines, missing Sources, Content fundamentals, Iconography,
Index and Caveats. It cannot be diffed against upstream, so drift in it is invisible by
construction — which is how the stale type-floor sentence survived, and why `CC4` exists.

Two ways: carry upstream verbatim and keep the summary beside it as a separate authored
document, or accept the fork and stop calling it vendored. Not a coding task until decided.

**A signed file's content can change, and I nearly recorded the opposite. Found 2026-09-11.**
The review of this pull request found a contradiction inside the signed v2 handoff:
`HANDOFF-V2.md:20` lists `Domovoi Phone v2.dc.html` and `:187` describes its nineteen frames,
while the known-gaps list said "No phone surface in v2." Both cannot be true.

I edited the vendored file, the gate refused it — "A signed file is never edited here" — and I
concluded the correction had nowhere to go, on two false premises.

The first was that a signed file's content cannot change. It can. `18dc495` re-vendored
`Domovoi Desktop V2.part2-logic.html`, a content change to a signed file with no `--accept-new`
and the digest regenerated in the same commit, and the invariants passed. The gate refuses a *hand
edit*; it has always allowed a re-export followed by a regenerate. That distinction is the entire
purpose of the digest, and I read the refusal as a prohibition on the outcome rather than on the
method.

The second was that no upstream existed. `list_projects` returned only `design_handoff_domovoi` and
`_brand`, and I read that as absence. It filters to design-system projects, and the source of record
is a plain project — `a3b4404e-4d0c-451e-8dd2-203116a76c06`, named in `design/REVISIONS.json`, the
same project `18dc495`'s re-export came from. `get_project` reaches it and `list_files` shows
`HANDOFF-V2.md` and `Domovoi Phone v2.dc.html` sitting in it. A filtered list answering "no" is a
fact about the filter.

Fixed the way `18dc495` was: corrected upstream in `a3b4404e`, read back, re-vendored, regenerated.
Four steps, no local authorship, digest intact.

**What the entry is really about, then.** Not that signed content is immutable — it is not — but
that the path to change it runs through a project this repository cannot see from its own tooling,
named only inside a generated file, reachable only by an id nobody would guess. `REVISIONS.json`
records `source`; nothing checks it is still reachable, and nothing would notice if it stopped
being.

### D2 · Origin-generated `REVISIONS.json` — recommendation is not now
Recorded with its flip condition: if vendoring ever comes from an artefact the repo can
re-read at check time — a downloaded bundle with its own digest, rather than a live project
reachable only through a tool — the caveat disappears and it becomes strictly better than
`--accept-new`. Until then it is a trusted file in a derived file's clothes.

### D3 · `Thread`'s prop surface
Three separate flags against it, and `pendingTransferTargetId` /
`onPendingTransferTargetChange` added two more to avoid a second route to the same consent
dialog. At some point it earns a context or a state object. Not inside feature work.

---

## Sequencing, if both agents start now

**Codex** starts `CX1`, which is the long pole and touches nothing Claude Code owns.

**Claude Code** starts `CC4`, because it removes the human oracle from the loop and makes
every later design question answerable from the repo. Then `CC2` and `CC3`, which are small
and self-contained. Then `CC5`'s diff work, which is reading rather than writing and
produces the estimates for everything after.

**Neither** starts `CC6` until `CC4` lands. Building Tablet, Cloud or Team from a design
nobody in the repo can read is how the last five divergences happened.
