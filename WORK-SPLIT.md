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
9. **No assistant attribution in a commit message, and the check runs before the commit rather
   than after the merge.** Set 2026-09-11, after breaking it 33 times in one session.

   `CLAUDE.md` says never add AI or session attribution to commits or pull requests. A harness
   instruction asked for a `Claude-Session:` trailer on every commit, and it went onto 33 of them
   across two branches and `main`, because each message was written to the instruction in front of
   it rather than checked against the rule. The rule was not ambiguous and not forgotten; it was
   simply never the thing being read at the moment of writing.

   **What made it expensive was where it was caught.** Fourteen of the 33 had already merged, so
   removing them meant rewriting published history, and `git filter-branch` cannot carry a
   signature across a rewritten commit. **314 commit signatures were destroyed** — measured on both
   sides, `314 E / 846 N` became `1160 N`. They cannot be restored: most were GitHub's own merge
   signatures, and re-signing them as anyone else would be worse than leaving them off. 1,050
   commit ids changed and 110 did not, with every tree, parent edge and subject verified identical
   by both agents from separate scripts.

   **Those signatures are the cost of the violation, not of the fix.** The same trailer rejected at
   `git commit` costs one amended message. Rejected in CI before a merge, it costs a force-push to
   a branch nobody else holds. After a merge there is no cheap option left: carry attribution
   against an explicit instruction, or destroy history to remove it. That asymmetry is the entire
   argument for where the check belongs.

   So there is a gate rather than an intention. `scripts/commit-trailers.mjs` runs inside
   `pnpm release:invariants`, over `origin/main..HEAD` rather than the tip, and fails naming the
   commit and the line.

   **It was not a required check when this was first written, and calling it a gate overstated it.**
   `branches/main/protection` returned `Branch not protected`, `rulesets` was empty and so was
   `rules/branches/main`. `release:invariants` ran at `.github/workflows/ci.yml:76` and blocked
   nothing: a pull request with it red could be merged by anyone with write access. Every merge
   that night was green on every check, which was a fact about the week's discipline rather than
   about the repository's rules.

   **Protection is now on, and tonight is the argument for it.** 314 signatures were destroyed by a
   force-push that no rule prevented, and the only thing standing between the repository and a
   second one was that both agents agreed not to. Set 2026-09-11 on `main`:

   - required: `verify (ubuntu-latest)`, `verify (macos-latest)`, `verify (windows-latest)`,
     `native`, `audit`. `release:invariants` lives inside the `verify` job, so requiring those
     three requires it on every platform.
   - `enforce_admins: true`, so it is a rule rather than a convention.
   - `allow_force_pushes: false` and `allow_deletions: false`. A rewrite of `main` is now refused
     rather than merely regretted.
   - `required_linear_history: false`, deliberately. This repository merges rather than squashes,
     and every tick citation depends on the cited sha surviving the merge.
   - No required reviews and `strict: false`, so neither agent is blocked waiting on the other or
     forced to rebase before every merge.

   `CodeRabbit` is deliberately **not** required: it returns `Review rate limited` under load, and
   requiring it would make a quota outage a merge outage. Rule 6 covers reading it; a required
   check is the wrong instrument for a reviewer that can legitimately decline.

   Feature branches stay unprotected. Force-push-with-lease is the normal way to revise a branch
   under review and that is where the iteration belongs.

   **One trap worth naming.** `git push --dry-run --force` reports what git *would* send and does
   not consult the server's protection, so it prints a cheerful `(forced update)` against a branch
   that would refuse it. It looks exactly like a successful test of the rule and tests nothing. The
   configuration above was read back from the API; the refusal itself is asserted by GitHub rather
   than demonstrated here, because demonstrating it means actually rewinding `main`.

   **The hook strips rather than refuses, and the difference is the whole point.** The harness
   appends the trailer by itself, so a hook that only rejected would turn every single commit into
   an amend — a treadmill dressed as a fix, and the kind of friction that gets a hook uninstalled
   within a day. `.githooks/commit-msg` removes the line and prints what it removed, so the gate
   downstream never has anything to fire on. Install it with
   `git config core.hooksPath .githooks`.

   `~/.claude/settings.json` already carries `includeCoAuthoredBy: false`, and it did not prevent
   this: the session trailer arrives through a different mechanism, injected into the session
   rather than read from a setting, with no local switch found for it. That is exactly why the
   remedy is a thing the repository owns rather than a preference somewhere else.

   It covers the trailer that caused this, `Co-Authored-By` naming an assistant, `Generated-By`,
   `Authored-With`, and a bare session link. A human co-author is untouched, and prose *about* the
   rule is not a violation of it — both pinned in `scripts/commit-trailers.test.mjs`.

   **The fifth instance of one pattern.** Vigilance failed and a gate worked, every time: a stale
   local `main`, `origin/main` read without a fetch, `cat-file -e` standing in for reachability, a
   checker that exited zero when it could not verify, and now a written, agreed rule read past 33
   times. Where a rule matters, build the thing that refuses.
10. **A checker that shells out treats a non-zero exit as refusal, never as absence of findings.**
   The shallow clone is the standard probe: run the checker where `git` cannot answer, and it has
   to fail rather than pass.

   Two instances a week apart, both written here. `scripts/tick-citations.mjs` returned `ok` when
   it could not determine reachability — fixed in `b12a784` after CodeRabbit raised it as major.
   `scripts/commit-trailers.mjs` returned `ok` on every `git` failure, so a shallow clone could not
   enumerate the branch and the gate passed — fixed in `1a17ff5c` after CodeRabbit raised it as
   major. The second was written in the commit whose entire argument is that gates beat vigilance,
   by the agent who had fixed the first.

   **Nothing generalised the first fix, because it lived in a file rather than in a rule.** A gate
   is code, and subject to every failure the code it gates is subject to — including the failure the
   gate exists to catch. Writing it does not exempt it.

   So, for every checker under `scripts/` that runs a subprocess: a failed command is a refusal that
   names what would make it answerable, never an empty result set. `catch { return { ok: true } }`
   is the shape to grep for. Both checkers now carry a regression that clones a real repository at
   `--depth 1` and asserts the refusal, and both were verified by restoring the fail-open and
   watching the tests go red: `11 pass / 3 fail` and `9 pass / 1 fail` respectively.

   Written as a rule rather than a third anecdote, because there are two and a third is likely.

   **The third arrived hours after the rule was written, and the rule did not stop it.** The fix in
   `1a17ff5c` fell back from `origin/main` to `main` on any error, because `git rev-parse --verify`
   exits non-zero both for a ref that does not exist and for a ref it could not read. The rule as
   written above cannot separate those: "non-zero is refusal" treats an answer exit and a failure
   exit alike, so the code treated both as absence and moved on. With local `main` already at the
   tip, a read failure on the remote ref narrowed the range to the clean tip and passed. Fixed in
   `671c4914` with `--quiet`, whose exit 1 means absent and nothing else; every other error throws.

   So the rule is sharper than "non-zero": **a shell-out's exit codes are enumerated, not
   thresholded.** Name each code that carries an answer and handle it as one; refuse on every code
   not named. "Non-zero is refusal" is only correct for a command with no meaningful non-zero exit,
   and a checker that has not looked up its command's exit codes does not know whether it is one.

   **Codex found it by injecting the failure, not by reading the diff.** It stubbed the `git` runner
   to throw `EIO` on `origin/main` with `main` at `HEAD` and a forbidden commit below, and watched
   refusal become `ok: true`. Both earlier instances were found by reading. Injection is the
   standard probe for this class from here: for each shell-out, make it fail in every way it can
   and assert that the checker refuses; the shallow clone is one such failure, not the whole set.

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
Ticked here under rule 7: Codex did the work, this file is Claude Code's, so the citation
carries Codex's sha rather than a second agent's edit.
- [x] Normalize adapter token reporting. One of the two was already fixed when this line was
      written: `claude.ts` by 33b2737 on 2026-09-07. OpenCode's `tokens.cache.read` and
      `.write` now fold into `inputTokens` in `usage.ts` (1dd6e97).
- [x] `acp.ts:296` gives `totalTokens` and `contextTokens` the same `update.used` value.
      Fixed by deleting the total rather than guessing one; the record says
      `tokens: "unavailable"` (1dd6e97).
- [x] Capture the model at dispatch. `server.ts:6903` writes usage against
      `session.runtime.model`, and `server.ts:5835` can change it on a same-provider update,
      so the record must keep requested model distinct from provider-reported (1dd6e97).
- [x] Persist accounting plus its dedup and coverage state across restart and transfer
      (1dd6e97).
- [x] Five hazards, all in scope: duplicate events, late events, failures, restart, transfer
      (1dd6e97).
- [x] Never infer a turn link from a timestamp or row position. OpenCode's turn id now comes
      from `info.parentID` rather than the active turn, so a late message lands on the turn
      that produced it (1dd6e97).
- [x] Not in the original list, found by Codex reproducing an inference rather than
      inheriting it: `opencode.ts` called `normalizeProviderUsage` unguarded where
      `claude.ts` wrapped it, so a cache read above the input count threw out of `#receive`.
      It now emits a record marked `invalid` instead (1dd6e97).
- Out of scope: new turn records, ordinals, message associations. Those are `CX2`.
- What Claude Code verified directly: the four defects are addressed in the diff, and
  `usage.test.ts`, `acp.test.ts` and `opencode.test.ts` pass, 59 tests. The accounting
  persistence across restart and transfer rests on Codex's own full-suite run, not on a
  check run here.

### CX2 · Turn records, ordinals, message associations — 2-3 d
Ticked under rule 7: Codex's work, Claude Code's file, so the citation carries Codex's shas.
- [x] Durable per-turn record with an ordinal (6af4efe, 3e201c7).
- [x] Associate messages with turns. Two dispatch paths: `server.ts:6504` steers an active
      turn, `server.ts:6595` appends another user message — a message is not a turn (3b2f7f1).
- [x] Expose the history-to-turn link so a history row can name its turn (3e201c7). `CC1`'s
      meta draws it in 28812d8.
- Legacy history stays unnumbered rather than defaulted, and `coverage` says how much of a
  turn the daemon actually saw, so the client can refuse to present a floor as a total.

### CX3 · Approval execution duration — 1 field
- [ ] Record how long the approved command ran, distinct from `decided in`.
      Decision latency answers "how long was the agent blocked"; execution duration answers
      "what did the approval cost". The design asks for the second and the UI currently
      shows the first.

### CX5 · Record the session-start checkpoint — accepted and landed
Raised 2026-09-10 while working `CC1`, accepted by Codex the same day (37e2b45, 25b94f0), and
`docs/checkpoint-reasons.md` is the contract. Codex caught a second failure in the original
ask that Claude Code had missed: `baseCommit` is mutable, so comparing against it does not
just collide, it changes meaning over time.
- [x] Push a checkpoint thread item when a session worktree is created, carrying the
      `baseCommit` that `createSessionWorkspace` already returns (25b94f0).
- [x] Give the checkpoint thread item a `reason`, and make `session-start` its seventh value.
      Landed with eight reasons and legacy rows left absent rather than defaulted (37e2b45).
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

### CX4 · Report the manifest defect upstream
- [ ] `_adherence.oxlintrc.json` marks `--transition-control` as `"color"`, after five
      correctly-marked `"other"` motion tokens. It is the **last key in `tokenKinds`**,
      which is a generator signature rather than a typo — report it as "the final entry's
      kind may be systematically wrong", since other manifests from the same emitter would
      carry it. Harmless to a font-size generator; a colour generator would accept it.

---

## Claude Code

### CC1 · Finish the history row — blocked on CX2 for the last part
- [x] `<pre>` out of the row, meta on one line, body in a collapsed `details` (d1f974f).
- [x] Checkpoint title drops the sha; title names the checkpoint, meta names the commit
      (d1f974f).
- [x] Fork wired on checkpoint rows only, with a confirm stating both halves
      (d1f974f, 6e38abf).
- [x] The card: `1px --border`, `--radius`, rows separated by a border (d1f974f).
- [x] Left **42px mono time column**, pinned by `history-row.dom.test.tsx` (d1f974f).
- [x] Replace the raw `span` dot with `StatusDot`, coloured by outcome rather than
      `bg-primary` on every row (d1f974f).
- [x] Grow the turn meta to `turn 9 · sonnet-4.6 · 3 tools · 12.4k tokens` — after CX2
      (6af4efe, 3b2f7f1, 3e201c7 by Codex; drawn in 28812d8). The row also repeats what the
      turn says about its own completeness: pending reads `running`, unavailable says so, and
      partial is marked rather than passing its floor off as a total.
- [x] Record execution duration as an unfilled design field, not a satisfied one:
      `sessionHistoryEntryDetail`'s field 4 names it and says why only decision latency
      can be measured today (d1f974f).
- [x] The session-start checkpoint gets **no** fork (37e2b45, 25b94f0 by Codex; drawn in
      28812d8). Fork is absent rather than disabled, because a disabled control still says the
      decision exists, and the meta reads `session start · nothing to revert past this`.
      Restore stays: going back to it is exactly what it is for. A legacy checkpoint carries no
      reason and is never guessed into this branch.
- [x] Turn-row fork is **closed as a design error**, not left open as a daemon request
      (28812d8 keeps fork checkpoint-only). fetzy's earlier "blocked on `CX2`" ruling was wrong,
      and so was its reasoning: the obstacle was never turn identity. Fork restores a worktree
      and turns do not each have one — most turns write nothing, so forking "from turn 8" and
      "from turn 9" lands on identical filesystem state, and `session.fork` does not replay
      conversation either. The affordance would promise a precision it cannot deliver, which is
      the same failure as forking from a turn's nearest preceding checkpoint. `CX2` gave a turn
      an identity; it did not give it a state. **The design's three `fork: true` turn rows are
      wrong and the design changes**, not the client. Nothing to raise with Codex:
      `session.fork` taking a checkpoint id is right as it stands.

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

### CC4 · Vendor the v2 designs — done
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

### CC5 · The four screens that are already partly built
Not eight unstarted screens. Reconcile these four against their designs rather than
building them:
- [ ] **Phone v2** — `apps/mobile/src/screens/` already has nine: approval, artifact,
      deny-explain, fleet, review, session, sessions, settings, unpaired. Design has 19
      frames. Diff the sets before writing anything.
  - [x] The diff is done, read-only, 2026-09-10 (89cabfd). Eight frames built, eight partial,
        three with nothing: 09 pairing by camera, 13 and 14 attachments, 19 pinned plan sheet.
        Estimate for the rest of Phone v2 is 13-15 days, which is what `SHIP-PLAN.md`'s `S3.3`
        line costs. Full table in `~/.agents/plans/2026-09-10-domovoi-cc5-phone-v2-diff.md`.
  - [x] No frame is blocked on Codex (02b6c7d). Checked before raising a request, and the
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
- [x] **Web v2** — diffed 2026-09-10 (02b6c7d). Two of six steps built, one partial, three with
      nothing: picking a machine, carrying on without the terminal, and Design review. 6-8 days.
      The machine picker stays in `S3.2` and is **marked blocked on Phase 2** rather than moved:
      a browser cannot reach a second machine without the relay or a tailnet route, so part of
      Web v2 cannot land before the relay and Web is not a fully parallel Phase 3 surface.
- [x] **Onboarding** — diffed 2026-09-10 (02b6c7d). Two of five steps built. 4-5 days for the
      client half. One gap and one settled contradiction.
  - **Settled 2026-09-10 by fetzy: the daemon is right and the design is wrong.** "Install it for
    me" is Domovoi running arbitrary third-party code on a person's machine at first run — before
    any trust relationship exists, before the gate machinery that would refuse it, and before an
    audit log they have reason to believe. It contradicts the product's central claim at the exact
    moment someone is deciding whether to believe it. `providerFirstRunRecovery` keeps its copy:
    show the command, say what it does, let the person run it. **The live design needs this
    change**; `design/` is signed and is not edited here. Three corrections now ride together on
    the next design touch: the export README naming no destination path, this installer button,
    and the Desktop V2 turn rows drawn with `fork: true`.
  - [ ] "Sign in to Domovoi Cloud" needs an account service that does not exist. `S0.1`/`S5.1`,
        not client work.
- [x] **Skills** — diffed 2026-09-10 (02b6c7d). Nearly done: install preview, scope, trust,
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

### CC9 · `--transition-control` is still a colour in the vendored manifest
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

The first was that a signed file's content cannot change. It can. `17cf141` re-vendored
`Domovoi Desktop V2.part2-logic.html`, a content change to a signed file with no `--accept-new`
and the digest regenerated in the same commit, and the invariants passed. The gate refuses a *hand
edit*; it has always allowed a re-export followed by a regenerate. That distinction is the entire
purpose of the digest, and I read the refusal as a prohibition on the outcome rather than on the
method.

The second was that no upstream existed. `list_projects` returned only `design_handoff_domovoi` and
`_brand`, and I read that as absence. It filters to design-system projects, and the source of record
is a plain project — `a3b4404e-4d0c-451e-8dd2-203116a76c06`, named in `design/REVISIONS.json`, the
same project `17cf141`'s re-export came from. `get_project` reaches it and `list_files` shows
`HANDOFF-V2.md` and `Domovoi Phone v2.dc.html` sitting in it. A filtered list answering "no" is a
fact about the filter.

Fixed the way `17cf141` was: corrected upstream in `a3b4404e`, read back, re-vendored, regenerated.
Four steps, no local authorship, digest intact.

#### Changing a signed file under `design/`

Written out here rather than left in either agent's head, because that is the failure this whole
entry is about: knowledge held somewhere the repository cannot read, rediscovered by being
corrected.

**The source of record** is Claude Design project `a3b4404e-4d0c-451e-8dd2-203116a76c06`, named
"Domovoi", type `PROJECT_TYPE_PROJECT`. It is recorded as `source` in `design/REVISIONS.json`.
`DesignSync list_projects` **does not show it** — that call filters to
`PROJECT_TYPE_DESIGN_SYSTEM`. Use `get_project` or `list_files` with the id. The design *system* is
a different project, `881e2b70-d39a-49b0-bc47-ef5084e64cc7`, and the `_ds/` copy bound into a
session is a third artefact; those three are the drift this entry opens with.

**The four steps**, in order, all in one commit:

1. Correct the file in `a3b4404e` (`finalize_plan`, then `write_files`).
2. Read it back with `get_file` and confirm the change landed.
3. Copy it into `design/…` — a re-vendor, never an edit of the vendored copy.
4. `node scripts/design-revision.mjs`, then `--check` to confirm
   `design/ matches the recorded revision`.

`--accept-new=<path>` is for **additions only**. A content change needs no flag, only a matching
regenerate. Precedents: `17cf141` and `e436a5e`.

This is the one place rule 5 does not apply. Regenerating a digest beside the change is normally how
a checksum comes to verify itself; here the content came from upstream rather than from this
repository, so the digest is recording a provenance rather than blessing an edit. The distinction is
the method, and it is why the gate's refusal reads as absolute when it is not.

**The gap, named rather than closed.** `REVISIONS.json` records `source`, and nothing verifies that
source is still reachable. If the project were renamed, moved or removed, every future re-vendor
would be impossible and no gate would say so — the vendored files would keep matching their recorded
digests, and `design/ matches the recorded revision` would go on passing while the thing it points at
was gone. Silent by construction.

It is not closable from CI. Reaching the project needs a DesignSync token CI does not have, so any
check would pass locally and skip in CI, which is the shape rejected twice already this week: a gate
that is green for a reason unrelated to what it claims. Naming it here is the whole remedy available.
Whoever finds `source` unreachable should edit this paragraph rather than file a bug against the
checker.

**The same finding, one layer out.** `REVISIONS.json` names a source nothing verifies is reachable;
pull request bodies, review comments and scratch records name shas nothing verifies still exist.
`scripts/tick-citations.mjs` covers `[x]` boxes in `ROADMAP.md` and `WORK-SPLIT.md` and nothing
else, so a history rewrite silently invalidates every prose reference to a rewritten sha outside
those two files. It did exactly that on 2026-09-11: the checker caught three citations in `ROADMAP.md` and two in
`WORK-SPLIT.md`, and caught none of the shas quoted across a dozen pull request comments. One rule,
two instances — a reference is only as good as the thing that checks it still resolves, and neither
of these has one.

**A third in the same family, and the one that costs work rather than confidence.**
`scripts/tick-citations.mjs` validates claims of completion: it fails an `[x]` with no citation, and
an `[x]` citing an unreachable sha. Nothing validates `[ ]`. The opposite error — work finished and
never claimed — is invisible by construction, and it is worse in kind: a false `[x]` produces
misplaced confidence, while a stale `[ ]` produces an agent starting work that is already done.
`CC4` sat unticked while this very branch had vendored the files it asks for, through commits that
are ancestors of it, and no gate could have said so because the section never claimed to be
finished. Found by a reviewer reading the prose against the tree, which is the only thing that
catches it. Not closable by the existing checker either: proving a `[ ]` is genuinely outstanding
means knowing what the task meant, and that is a reading rather than a rule.

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
