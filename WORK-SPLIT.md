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

### CC8 · `apps/mobile`'s sub-floor type sites — closed
Three of this item's premises were wrong, checked before widening anything. fetzy ruled
2026-09-10: no new role below `machine`, the sites move onto existing variants, and the phone's
floor is **higher** than the desktop's rather than lower.

- [x] **Nineteen sites, not eight** (7843da0 for nine, this commit for ten more). Four in `screens/session.tsx` (56, 86, 90, 139), two in
      `screens/artifact.tsx` (32, 42), one each in `components/tab-bar.tsx` (56) and
      `components/ui/badge.tsx` (48) — and `screens/fleet.tsx:48` at `text-[8.5px]`, which the
      inventory missed and which is the smallest of them.
- [x] **The three role names did not resolve in `apps/mobile`** (7843da0). The rule's message says to use
      `text-eyebrow`, `text-mono-xs` or `text-micro`. `apps/mobile/tailwind.config.js` has no
      `fontSize` at all — it reads only `colors`, `fontFamily` and `radius` from
      `tokens.generated.js`, and that file carries no type scale. Widening the glob would flag
      nine sites and offer three utilities that resolve to nothing in nativewind, so every fix
      it prompted would be wrong.
- [x] **The phone's scale is deliberately not the desktop's** (7843da0)., so emitting the desktop floor
      into mobile is not the fix either. `components/ui/text.tsx:22` says why: "A phone is read
      at arm's length rather than desk distance, so the scale is tighter than the desktop's."
      Its nine `Text` variants are the phone's real role system, bottoming out at
      `machine` 10px and `note`/`label` 10.5px.
- [x] **The design question is answered** (7843da0). does the phone have a floor, and
      what is it? Either the nine sites take an existing `Text` variant, or the phone's scale
      gains a named role below `machine`. Both are decisions about the phone's type system.
      Until one is answered, widening the glob turns a real question into nine lint errors with
      no correct fix.
- Restating the desktop's scale in raw px is the same shape the token pipeline exists to stop.
  `scripts/mobile-tokens.mjs` derives colours and radii from `packages/ui/src/styles.css`; the
  type scale is the one part still written out by hand on both sides.

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

**Second instance, from the other direction, found 2026-09-10.** The phone's type ramp is
authored in this repository (`--text-phone-*` in `packages/ui/src/styles.css`) because the design
system carries the desktop scale and knows nothing about the phone's — even though Phone v2 is a
designed surface and type is the design system's to own. It cannot be fixed from here: the live
design system was last touched 2026-08-28, twelve days before this, and is not writable from the
project that would have to change it. So the repo authors it, and `scripts/design-rule.mjs` reads
two sources, each authoritative for its own scale. That is two derivations rather than a
restatement, and neither ramp can drift from the other because they describe different things —
but the phone ramp living here rather than upstream is the same fork question as `D1`, arriving as
an addition instead of a summary.

### D2 · Origin-generated `REVISIONS.json` — recommendation is not now
Recorded with its flip condition: if vendoring ever comes from an artefact the repo can
re-read at check time — a downloaded bundle with its own digest, rather than a live project
reachable only through a tool — the caveat disappears and it becomes strictly better than
`--accept-new`. Until then it is a trusted file in a derived file's clothes.

### D4 · A disabled control that cannot say why — 56 sites, needs a rule and a pass
Measured 2026-09-10 after the same failure appeared three times in one session: a terminal
disconnected, a skills review with no project open, and a blocked skill, each a control that went
inert and said nothing. fetzy's framing makes it three branches rather than two — does not apply
here, remove it; cannot act for a reason outside the control's own context, say why; cannot act
because of the user's adjacent state, say nothing, since "type something to send" is noise.

- A first selector — any `disabled` with no `aria-describedby`, `title` or `aria-label` — fired
  **102** times out of 124. That number says the selector asks the wrong question, not that the
  codebase fails 102 times.
- Scoping it to the third branch, by flagging only a `disabled` expression whose identifiers are
  not bound by `useState`/`useReducer` in the file, gives **56 external and 56 local-only**.
  `disabled={!input.trim()}` stops firing; `disabled={!connected}`, `disabled={!projectId}` and
  `disabled={skill.trust.state === "blocked"}` still do.
- `disabled={disabled}` is excluded as plumbing: the reason lives at the call site that passed it,
  and that call site is counted there. That alone took 70 to 56.
- The measurement script is scratch, not committed. It resolves names per file rather than per
  component, so a component that shadows a prop name is misfiled; the error is small and in the
  direction of over-reporting.

**Not yet a task to start, and when it is, it is not a sweep.** Ruled by fetzy 2026-09-10: land
the rule as an error with the 56 seeded as a shrinking allowlist, the same shape as the tick
citations, and let each come off as its file is touched for other reasons. A bulk pass biases hard
toward the cheap branch — adding `aria-describedby` everywhere — when a good share of these
controls should not be rendered at all, and that ends in 56 descriptions of controls that should
not exist. Seeded, the new violations are blocked from day one and each existing one is decided by
someone already in that file with the context to choose between the branches.

The rule wants to be a custom ESLint rule with scope analysis rather than a `no-restricted-syntax`
selector, since the selector cannot see what is local.

### D5 · `workspace-shell.tsx` needs splitting — fourth flag in one session
Not a file that keeps coming up any more. The case, with the counts as evidence:

- **4,600 lines**, and it holds `Thread`, `HistoryPanel`, `RuntimeControls`, the session sidebar
  and the shell itself.
- `D3` is a standing complaint about `Thread`'s prop surface, raised before this session.
- **45 of the 102** first-pass disabled sites, and **22 of the 56** scoped ones, are in this file
  alone — more than a third either way.
- Every cross-cutting pass this session had to touch it: the history row, the turn meta, the
  session-start fork, both empty states, the status dot.

The prop surface is the symptom `D3` names; the size is why every unrelated change lands here.
Splitting it is not a refactor for tidiness, it is what stops the next cross-cutting item being a
merge conflict with the one before it.

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
