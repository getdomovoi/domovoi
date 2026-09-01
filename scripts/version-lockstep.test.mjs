import assert from "node:assert/strict"
import test from "node:test"

import { evaluateVersionLockstep } from "./version-lockstep.mjs"

test("accepts a workspace released as one unit", () => {
  assert.deepEqual(evaluateVersionLockstep([
    { name: "@getdomovoi/protocol", path: "packages/protocol/package.json", version: "0.0.1" },
    { name: "@getdomovoi/daemon", path: "apps/daemon/package.json", version: "0.0.1" },
  ]), [])
})

test("reports every package that drifted from the majority version", () => {
  assert.deepEqual(evaluateVersionLockstep([
    { name: "@getdomovoi/protocol", path: "packages/protocol/package.json", version: "0.0.1" },
    { name: "@getdomovoi/ui", path: "packages/ui/package.json", version: "0.0.1" },
    { name: "@getdomovoi/daemon", path: "apps/daemon/package.json", version: "0.1.0" },
  ]), [
    "apps/daemon/package.json: @getdomovoi/daemon is 0.1.0, expected 0.0.1",
  ])
})

test("reports a missing version instead of silently agreeing", () => {
  assert.deepEqual(evaluateVersionLockstep([
    { name: "@getdomovoi/protocol", path: "packages/protocol/package.json", version: "0.0.1" },
    { name: "@getdomovoi/web", path: "apps/web/package.json", version: undefined },
  ]), [
    "apps/web/package.json: @getdomovoi/web has no version",
  ])
})

test("refuses to guess when no version holds a majority", () => {
  assert.deepEqual(evaluateVersionLockstep([
    { name: "@getdomovoi/protocol", path: "packages/protocol/package.json", version: "0.0.1" },
    { name: "@getdomovoi/daemon", path: "apps/daemon/package.json", version: "0.1.0" },
  ]), [
    "workspace versions disagree with no majority: @getdomovoi/daemon 0.1.0, @getdomovoi/protocol 0.0.1",
  ])
})
