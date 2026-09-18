# Working rules

The rules, ownership table and deferred decisions that the two-agent sessions of September
2026 earned, most of them by being broken once. This file was the front and back of
`WORK-SPLIT.md` until 2026-09-14; the task backlog between them folded into
[`SHIP-PLAN.md`](../SHIP-PLAN.md), which is the one plan, and its `CX` and `CC` ids are gone.
Nothing here is a task. Everything here is verbatim from that file except this paragraph.

**Codex** owns the daemon and protocol. **Claude Code** owns the clients and the repo's own
tooling. Anything that crosses that line is split into two commits, protocol first.

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
6. **Read the reviews, not the check row.** Three descriptions render as pass and carry
   `state: success`, and only one of them means anything was read:

   - `Review completed` — the diff was actually reviewed.
   - `Review rate limited` — capacity was exhausted. Nothing was read. Seen on two heads of
     #359 and on #360 the same afternoon, because the limit is a budget shared across every
     pull request opened that day rather than a per-pull-request fluke.
   - `Review skipped: reviews are disabled for this base branch` — **a stacked pull request
     gets no automated review at all.** Measured 2026-09-10: #361 through #364 target other
     feature branches rather than `main`, and all four showed pass with nothing read. Only the
     two units based on `main`, #359 and #360, were eligible.

   The last one is the trap a stack walks into: splitting one unreviewable branch into six
   reviewable units bought review by people and silently lost review by the bot for four of
   them, while every row went green. CI does run on those bases, so the platform matrix is
   real; the review is not.
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

   **Citations are durable because this repository merges rather than squashes.** #354 through
   #358 landed as merge commits and their shas survived onto `main`. A squash policy would break
   every citation silently: the sha a tick names would exist on nobody's branch after merge, the
   checker would keep passing on feature branches that still hold the original commit, and it
   would be wrong about `main` — the exact shape of a check that looks green while proving
   nothing. If the merge policy ever changes, this convention has to change with it.

   **A fourth, 2026-09-18, in the other direction: the checker ran and answered a different
   question.** `pnpm lint | grep -cE '^\s+[0-9]+:[0-9]+'` reported `0` on a branch with five
   ESLint errors, and the PR body said lint was clean. `\s` is not POSIX ERE; BSD `grep -E`
   matched a literal `s`, found none, and printed the count it was asked for. `grep -c` does
   exit 1 when nothing matches, and nothing read that status: the reader took the printed `0`
   as the answer. So not a failure to enumerate exit codes, and not a fail-open on a non-zero
   exit either. The check ran to completion, printed a number, and what it counted was not what
   was meant. CI caught it because CI ran `eslint` and read its exit, not a grep over its output.

   Same family as the three above, same fix: **verify a checker against a known-bad input before
   trusting a pass.** A grep that has never matched anything has not been shown to match; a lint
   wrapper that has never reported an error has not been shown to report one. The pattern now
   used is `grep -cE '^ +[0-9]+:[0-9]+ +error'`, checked against a probe file with one unused
   import (count `1`, then `0` with the probe removed) before the count was believed.

9. **A tick ships in the pull request that lands the commit it cites.** Found 2026-09-10 while
   building the first stack: a plan-only branch passed every gate locally and would have failed
   in CI, because fourteen cited shas do not exist on a fresh clone of it. The task list is
   useful *before* the work lands — that is what it is for, and two agents coordinating for days
   off an uncommitted plan is how one branch reached 62 commits. The ticks are only meaningful
   *after*. So a plan-first pull request carries the tasks with no ticks it cannot satisfy, and
   each later pull request carries the tick edits for its own commits, citing shas that are
   present in it by construction. This extends rule 7 by one clause: the owner ticks, citing the
   other agent's sha, **in the pull request that lands it**.
10. **When CodeRabbit is exhausted, the other agent reviews — and it is named as a different
   reviewer, not as CodeRabbit.** Set 2026-09-10. Codex hit the CLI's rolling three-review
   limit mid-stack and `#362`, `#363`, `#364` stalled with no review of any kind. The standing
   arrangement: whichever agent is blocked asks the other to review the diff, and the favour
   runs both ways.

   **The obvious implementation does not work, and the measurement is why.** Both agents drive
   the same CLI against the same account. `coderabbit auth status` reports
   `phetzy (david.j.fetzer@gmail.com)`; `coderabbit usage` reports organisation `getdomovoi`,
   `Your reviews: 723`, one counter, `Period resets: 2026-09-26`. So Claude Code running
   `/code-review` during a Codex rate limit spends Codex's own remaining slots. It is one
   bucket, not two, and a fallback drawing on the bucket that just emptied is not a fallback.

   What the blocked agent gets instead is a review by the other agent's own model — for Claude
   Code, a read of the diff; for Codex, its own read. That reviewer is independent of the quota.

   **It is less weak than first recorded, and Codex was right to challenge that.** The first
   version of this rule said the substitute "has no repository-wide path instruction set, and the
   `packages/protocol/**` payload-bounds rule is exactly the sort of thing it will miss". Wrong:
   `.coderabbit.yaml:111-124` carries those instructions, in the repository, readable. The
   substitute reviewer applies them. The rule was written from an assumption about where
   CodeRabbit keeps its configuration, and one `sed` settled it — the same failure as every other
   entry here, which is why it is corrected in place rather than quietly dropped.

   What remains genuinely different is the reviewer, not the instructions: a different model, one
   pass, no second opinion. Enough to justify the label below, not enough to justify the excuse.

   **And on `#364` the substitute found something the CLI did not, for a structural reason worth
   keeping.** CodeRabbit completed `ae05970..85603f9` with zero findings. The substitute review of
   the same head reported that the decoded-UTF-8 refusal had landed at two of its three sites:
   `skills.ts:147` and `skills.ts:354` gained it, `skill-install.ts:204` did not, so a malformed
   skill installs successfully and is then invisible to `list()` and `read()`. Codex agreed and
   fixed it.

   The reason is not that one reviewer is sharper. `skill-install.ts` is not in that diff — 17
   files are, and it is not among them. A reviewer reading the changed lines cannot see a site the
   change failed to reach, because the defect is the absence of a line in a file nobody touched.
   Asking "where else is this constant used" is a different question from "is this diff correct",
   and only the second one is what a diff review answers.

   **The same day, the same rule ran the other way, and that half belongs here too.** CodeRabbit's
   review of `validation/backend-stack` returned one major finding in `validTurnOrdinalSql`, a SQL
   expression the substitute review had read closely and listed under "checked and correct". A
   stored ordinal of exactly `Number.MAX_SAFE_INTEGER` passes every clause of the guard, and
   `begin()` then computes `MAX + 1`, which `counter.max(Number.MAX_SAFE_INTEGER)` rejects, so that
   session can never begin another turn.

   The miss was scope. The substitute verified that the guard rejects every invalid *stored* value
   and stopped, because the guard is about stored values. The defect lives one step later, in the
   successor: the bound that matters for allocation is one lower than the bound that matters for
   storage. Reading a diff closely is not the same as following the value out of the expression.

   So the two are not ranked, they are shaped differently, and the substitute is worth running even
   when the CLI is available. Neither closes the other's row, and this entry is written with both
   directions in it so it cannot be quoted as a ranking.

   **Reviewing a combined branch: four rules, because the record outlives the branch.** Validating a
   stack often means building one branch that merges every pull request head, so the gates run
   against the tree that will actually exist. Reviewing *that* branch is useful and its record is a
   trap, because the branch is deleted and the code lands through each pull request's own commits.

   - Name it `validation/…`. The prefix carries the fact when the description is three scrolls up.
   - Say in the record that it is validation only and will not be merged, and name the pull request
     heads it combines. A published branch whose shas appear in a review and never reach `main`
     reads later as either lost work or a merge that happened. Neither is true, and neither is
     recoverable from the sha.
   - Record every finding against the **pull request and file**, never the integration sha. A
     finding at `abc123:47` is unaddressable the moment the branch is dropped: the review stays
     valid while its addresses do not, which is the weakest kind of record because it still looks
     checkable.
   - Keep integration shas out of every `[x]` citation. `scripts/tick-citations.mjs` runs
     `git merge-base --is-ancestor <sha> HEAD`, so such a citation passes on the machine holding
     the branch and fails on a fresh clone — the exact failure rule 8's checker was written for.
     Cite the per-pull-request heads, which become ancestors when they merge.

   First applied 2026-09-10 to the reference combining `#362` `0b896d7`, `#363` `3167d44`, `#364`
   `949c487` and the merged history and checkpoint slices. All three heads verified against
   `gh pr view --json headRefOid` rather than taken from the description.

   So the substitute review is recorded as what it is. Never write "reviewed" unqualified, and
   never let a substitute close a `CodeRabbit` row. Name the reviewer, name the diff range, and
   say the CodeRabbit review is still outstanding. Same shape as rule 6: the failure is not an
   unreviewed diff, it is an unreviewed diff that reads as reviewed.

---

---

## Needs a decision before it can be worked

### D1 · three copies of the design system, nothing keeping them in step
`design/design_system_domovoi/readme.md` is a condensed 127-line summary in a different
voice against upstream's ~300 lines, missing Sources, Content fundamentals, Iconography,
Index and Caveats. It cannot be diffed against upstream, so drift in it is invisible by
construction — which is how the stale type-floor sentence survived, and why `CC4` exists.

**That framing was too small, and 2026-09-10 showed why.** "The vendored readme is a summary,
not a copy" describes one file and implies the remedy is to carry upstream verbatim. The actual
shape is three independent artefacts: the live Claude Design project, the `_ds/` copy bound into
a working session, and this repository's `design/`. Nothing moves a change from any one of them to
either other. Carrying upstream verbatim does not fix that, because upstream is itself a snapshot
someone else's tooling refreshes on its own schedule — vendor from the bound copy and you vendor
a revision behind the live one, with no signal that you did.

Measured instance: `tokens/motion.css` gained `/* @kind other */` on six motion tokens in the
live project. The bound `_ds/` copy had none of the six. `design/` had none of the six. The only
reason any of that surfaced is that a person happened to open the file. No check, on any of the
three sides, would have said a word. Re-vendored from the live project directly at
`e4d3d11` — fifteen lines, not the one-line diff the fork framing predicts.

Two ways, both still open: carry upstream verbatim **and** add a mechanism that says when
upstream moved, or accept the fork and stop calling it vendored. Verbatim alone is not one of
them. Not a coding task until decided.

**Presence is not adoption, and nothing here records which is which.** A vendored file that
nothing imports looks identical, by inspection, to one that is fully wired. Same shape as a check
row reading pass when nothing ran, and as a grep hit being a fact about the text rather than the
system. Under `design/design_system_domovoi/tokens/`, colours and radii are derived through
`scripts/mobile-tokens.mjs`, typography is partly derived and partly hand-written, and
`motion.css` reaches nothing at all — `packages/ui/src/styles.css` imports neither it nor any
`dv-*` keyframe, so the system-wide reduced-motion collapse it declares was never in effect and a
shimmer added on the assumption that it was would have shipped an infinite animation with no
preference path.

**Next step, and it is cheap:** audit each file under `design/design_system_domovoi/tokens/` once
— is it imported or derived anywhere, and if not, why not. Some legitimately will not apply. The
output is **not** a check that every file must be imported; it is an inventory with a stated reason
per unadopted file, and then a check that the inventory is complete. Seeded and shrinking, the same
shape as the tick citations, the type-floor exemptions and `D4`.

**Second instance, from the other direction, found 2026-09-10.** The phone's type ramp is
authored in this repository (`--text-phone-*` in `packages/ui/src/styles.css`) because the design
system carries the desktop scale and knows nothing about the phone's — even though Phone v2 is a
designed surface and type is the design system's to own. "Not writable from here" was recorded as
the reason and it was wrong: DesignSync writes to the live project, and did on 2026-09-10. The
real reason is that a phone type ramp is a design decision, not a vendoring one, and it has not
been made upstream. So the repo authors it, and `scripts/design-rule.mjs` reads
two sources, each authoritative for its own scale. That is two derivations rather than a
restatement, and neither ramp can drift from the other because they describe different things —
but the phone ramp living here rather than upstream is the same fork question as `D1`, arriving as
an addition instead of a summary.

### D6 · every `verify` run depends on a third-party CDN being up
Found 2026-09-11 when `#363` failed `verify (macos-latest)` on a comment-only commit. The
cause was not the commit and not a flaky test:

    Downloading Electron binary...
    HTTPError: Response code 500 (Internal Server Error) for
      https://github.com/electron/electron/releases/download/v44.1.0/electron-v44.1.0-darwin-arm64.zip
    Error: Electron failed to install correctly.
    [ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @getdomovoi/desktop@0.0.1 test:launch

Every suite passed first — 35, 128, 5, 156 with 3 skipped, 20 and 26 files, 2,164 daemon tests
and all 12 mobile Jest suites — and `test:launch` then failed before launching anything. Confirmed
independently by both agents from separate log captures.

`apps/desktop/package.json:51` pins `electron` at `44.1.0`, and `.github/workflows/ci.yml` caches
only pnpm at line 29. Nothing caches `~/Library/Caches/electron` or its Linux and Windows
equivalents, so **every** verify job on **every** platform fetches that binary from GitHub's
release CDN at test time. A red that means "GitHub had a bad minute" is indistinguishable from a
red that means the code broke, which is the same failure as a green that means nothing was read.

Not a coding task until decided, because the fix has a shape question in it: cache the binary per
version, vendor it, or split `test:launch` out of `verify` so a CDN fault cannot fail the gate that
decides whether code is correct.

**The third option carries a trap, raised by Codex 2026-09-11 and worth stating with it.** Splitting
tells the two failure kinds apart; it does not remove the network dependency. And if the split job is
not *required*, an unavailable Electron binary stops failing the merge gate and starts being absent
from it — a green merge with launch coverage that silently did not run. That is this entry's own
failure class, reintroduced by its own remedy. Any split has to keep launch coverage required.

**Recorded, not scheduled.** It cost one rerun, and it will do this again.

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

**It is not a shrinking list everywhere, and calling it one was pattern-matching.** Measured
2026-09-10 rather than assumed. A seeded list only converges if its files are edited routinely for
other reasons, which is why the tick citations work — ROADMAP lines are edited constantly. Commits
per file since 2026-08-01:

| Sites | File | Commits |
|---|---|---|
| 22 | `workspace-shell.tsx` | **183** |
| 8 | `fleet-view.tsx` | 13 |
| 3 | `skill-browser.tsx` | 18 |
| 1 | `audit-log-view.tsx` | 12 |
| 4 | `session-evidence.tsx` | 8 |
| 2 | `machine-switcher.tsx` | 8 |
| 5 | `terminal-pane.tsx` | 6 |
| 4 | `desktop-first-run.tsx` | 3 |
| 2 | `daemon-credential-prompt.tsx` | 3 |
| 1 | `notification-settings.tsx` | 2 |

So it converges for the hot two thirds and asymptotes on a cold tail of roughly a dozen sites in
files touched two or three times in six weeks. The honest shape is a rule that **blocks new
violations from day one** plus a **named tail scheduled as work**, not one mechanism pretending to
do both. Seeding without saying which sites are in which half would be a permanent list wearing a
shrinking list's clothes.

`D5` is the other half of this: 22 of the 56 are in the file that is flagged for splitting, and
splitting it is what puts a person in every one of those call sites with the context to choose
between the branches. `D4` after `D5`, not beside it.

**Not a sweep when it is scheduled.** Ruled by fetzy 2026-09-10: land the rule as an error with
the existing sites seeded, and let each come off as its file is touched. A bulk pass biases hard
toward the cheap branch — adding `aria-describedby` everywhere — when a good share of these
controls should not be rendered at all, and that ends in 56 descriptions of controls that should
not exist. Seeded, the new violations are blocked from day one and each existing one is decided by
someone already in that file with the context to choose between the branches.

The rule wants to be a custom ESLint rule with scope analysis rather than a `no-restricted-syntax`
selector, since the selector cannot see what is local.

### D5 · Split `workspace-shell.tsx` — done 2026-09-18
Recording this a fifth time would have been deferral dressed as agreement, so it was done instead.
The case that scheduled it, with the counts as evidence:

- **4,600 lines**, and it held `Thread`, `HistoryPanel`, `RuntimeControls`, the session sidebar
  and the shell itself.
- `D3` is a standing complaint about `Thread`'s prop surface, raised before this session.
- **45 of the 102** first-pass disabled sites, and **22 of the 56** scoped ones, were in this file
  alone — more than a third either way.
- Every cross-cutting pass this session had to touch it: the history row, the turn meta, the
  session-start fork, both empty states, the status dot.
- **183 commits since 2026-08-01**, the most-touched file in the repository by a wide margin.

What it became, one module per surface, each a mechanical move with no behaviour change and
`workspace-shell.tsx` re-exporting every public name so no import elsewhere moved:

| File | Holds | Lines |
|---|---|---|
| `workspace-shell.tsx` | `WorkspaceShell` and the skill refresh keys | 1,440 |
| `thread.tsx` | `Thread`, `SessionRow`, `ApprovalCard`, the checkpoint row, archive and read-only notices, status meanings, transfer receipt copy | 1,140 |
| `artifact-dock.tsx` | `ArtifactDock`, `AnnotationComments`, `DockRail`, preview thumbnail helpers, the lazy terminal pane | 1,070 |
| `launcher-dialog.tsx` | `LauncherDialog`, `ProviderReadinessList`, `ProjectSwitchConfirmationDialog`, the default runtime | 360 |
| `history-panel.tsx` | `HistoryPanel` | 300 |
| `app-bar.tsx` | `AppBar`, `WindowControls`, usage-today readout and hook, emergency stop announcement | 170 |
| `workspace-selectors.ts` | the snapshot readers the shell and the dock share | 100 |
| `restore-focus.ts` | `restoreFocusAfterUpdate` | 15 |

`Thread` is still 700 lines with the prop surface `D3` names; the split moved it, it did not
shrink it. The 22 disabled sites moved with their components and are now spread across four
files, so the disabled-sites pass reads each file rather than one.

### D3 · `Thread`'s prop surface
Three separate flags against it, and `pendingTransferTargetId` /
`onPendingTransferTargetChange` added two more to avoid a second route to the same consent
dialog. At some point it earns a context or a state object. Not inside feature work.

---

