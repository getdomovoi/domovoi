import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import { branchDrift, driftReport, stackThreshold } from "./branch-drift.mjs"

test("names the numbers that were missing", () => {
  assert.equal(
    driftReport({ detached: false, branch: "feat/one", baseline: "origin/main", ahead: 3, behind: 0, mainAgeDays: 1, staleLocal: 0, fetched: true }),
    "feat/one: 3 commits ahead of origin/main, origin/main last moved 1 day ago",
  )
})

// A long branch is not invalid and this never fails. What it does is read the
// number back, because a number with no reading is what the last three days
// already had.
test("calls out the crossing rather than every number", () => {
  const quiet = driftReport({ detached: false, branch: "feat/one", baseline: "origin/main", ahead: stackThreshold, behind: 0, mainAgeDays: 1, staleLocal: 0, fetched: true })
  assert.doesNotMatch(quiet, /stack of smaller pull requests/)

  const loud = driftReport({ detached: false, branch: "feat/one", baseline: "origin/main", ahead: 120, behind: 0, mainAgeDays: 3, staleLocal: 0, fetched: true })
  assert.match(loud, /past 20 commits with main static, a stack of smaller pull requests is usually the answer/)
})

test("reports how far behind main it has fallen, and stays silent when it has not", () => {
  assert.match(
    driftReport({ detached: false, branch: "feat/one", baseline: "origin/main", ahead: 2, behind: 9, mainAgeDays: 0, staleLocal: 0, fetched: true }),
    /2 commits ahead of origin\/main, 9 behind/,
  )
  assert.doesNotMatch(
    driftReport({ detached: false, branch: "feat/one", baseline: "origin/main", ahead: 2, behind: 0, mainAgeDays: 0, staleLocal: 0, fetched: true }),
    /behind/,
  )
})

// A shallow clone or a worktree with no main cannot answer this. Saying the
// check did not run beats reporting zero, which reads as no drift.
test("says it does not know rather than reporting zero", () => {
  assert.equal(driftReport({ detached: true, branch: "main" }), "branch drift unknown: no main to compare against")
})

// A bare origin and a clone of it, both under one temporary directory, so the
// count is against a main this test wrote rather than whatever the checkout's
// origin holds. The clone's remote.origin.fetch is removed on purpose: without
// it a bare `git fetch origin main` updates FETCH_HEAD only, and origin/main
// keeps the value it had at clone time. The fetch has to name the tracking ref
// for the numbers here to be about main rather than about the last clone.
test("counts ahead and behind against a freshly fetched origin/main", async (t) => {
  const run = promisify(execFile)
  const dir = await mkdtemp(join(tmpdir(), "domovoi-branch-drift-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const origin = join(dir, "origin.git")
  const clone = join(dir, "clone")
  const git = (cwd, ...args) => run("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd })
  const commit = (cwd, name) => git(cwd, "commit", "--quiet", "--allow-empty", "-m", name)
  await git(dir, "init", "--quiet", "--bare", "-b", "main", origin)
  const seed = join(dir, "seed")
  await git(dir, "init", "--quiet", "-b", "main", seed)
  await commit(seed, "one")
  await git(seed, "push", "--quiet", origin, "main")
  await git(dir, "clone", "--quiet", "--no-local", origin, clone)
  await git(clone, "config", "--unset-all", "remote.origin.fetch")
  await git(clone, "checkout", "--quiet", "-b", "feat/two")
  await commit(clone, "two")
  await commit(clone, "three")
  await commit(seed, "four")
  await git(seed, "push", "--quiet", origin, "main")

  const drift = await branchDrift(clone)
  assert.deepEqual(
    { detached: drift.detached, branch: drift.branch, baseline: drift.baseline, ahead: drift.ahead, behind: drift.behind, fetched: drift.fetched },
    { detached: false, branch: "feat/two", baseline: "origin/main", ahead: 2, behind: 1, fetched: true },
  )
})

// A stale local main answers every question wrongly while looking exactly like a
// fresh one. Measured 2026-09-10: local main was 60 behind the remote, which
// made a 62-commit branch report as 121 and put five already-merged commits
// inside a proposed first pull request.
test("says when local main is too stale to have been the baseline", () => {
  assert.match(
    driftReport({ detached: false, branch: "feat/one", baseline: "origin/main", ahead: 62, behind: 0, mainAgeDays: 1, staleLocal: 60, fetched: true }),
    /local main is 60 behind origin\/main, so any count against it would be wrong/,
  )
})

// Offline, everything downstream is only as true as the ref it was read from,
// and a baseline that looks fresh is worse than one that admits its age.
test("says how old the baseline is when it could not fetch", () => {
  assert.match(
    driftReport({ detached: false, branch: "feat/one", baseline: "origin/main", ahead: 3, behind: 0, mainAgeDays: 1, staleLocal: 0, fetched: false, baselineAge: 72 }),
    /could not fetch, so this origin\/main is at least 72h old and so is every number here/,
  )
  assert.match(
    driftReport({ detached: false, branch: "feat/one", baseline: "origin/main", ahead: 3, behind: 0, mainAgeDays: 1, staleLocal: 0, fetched: false }),
    /the age of this origin\/main is unknown/,
  )
})
