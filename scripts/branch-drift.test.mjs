import assert from "node:assert/strict"
import test from "node:test"

import { branchDrift, driftReport, stackThreshold } from "./branch-drift.mjs"

test("names the numbers that were missing", () => {
  assert.equal(
    driftReport({ detached: false, branch: "feat/one", ahead: 3, behind: 0, mainAgeDays: 1 }),
    "feat/one: 3 commits ahead of main, main last moved 1 day ago",
  )
})

// A long branch is not invalid and this never fails. What it does is read the
// number back, because a number with no reading is what the last three days
// already had.
test("calls out the crossing rather than every number", () => {
  const quiet = driftReport({ detached: false, branch: "feat/one", ahead: stackThreshold, behind: 0, mainAgeDays: 1 })
  assert.doesNotMatch(quiet, /stack of smaller pull requests/)

  const loud = driftReport({ detached: false, branch: "feat/one", ahead: 120, behind: 0, mainAgeDays: 3 })
  assert.match(loud, /past 20 commits with main static, a stack of smaller pull requests is usually the answer/)
})

test("reports how far behind main it has fallen, and stays silent when it has not", () => {
  assert.match(
    driftReport({ detached: false, branch: "feat/one", ahead: 2, behind: 9, mainAgeDays: 0 }),
    /2 commits ahead of main, 9 behind/,
  )
  assert.doesNotMatch(
    driftReport({ detached: false, branch: "feat/one", ahead: 2, behind: 0, mainAgeDays: 0 }),
    /behind/,
  )
})

// A shallow clone or a worktree with no main cannot answer this. Saying the
// check did not run beats reporting zero, which reads as no drift.
test("says it does not know rather than reporting zero", () => {
  assert.equal(driftReport({ detached: true, branch: "main" }), "branch drift unknown: no main to compare against")
})

test("reads the real repository without throwing", async () => {
  const drift = await branchDrift()
  assert.equal(typeof driftReport(drift), "string")
})
