import assert from "node:assert/strict"
import test from "node:test"

import { evaluateUnsignedBuild, unsignedBuildLine, workflowTriggers } from "./unsigned-build.mjs"

const dispatchOnly = ["name: desktop-signing", "on:", "  workflow_dispatch:", "    inputs: {}", "jobs:", "  build:", "    env:", "      DOMOVOI_DESKTOP_REQUIRE_SIGNING: 'true'"].join("\n")
const onRelease = dispatchOnly.replace("  workflow_dispatch:", "  release:\n    types: [published]\n  workflow_dispatch:")
const settings = `<p>${unsignedBuildLine}</p>`

test("reads the triggers of a workflow", () => {
  assert.deepEqual(workflowTriggers(dispatchOnly), ["workflow_dispatch"])
  assert.deepEqual(workflowTriggers(onRelease), ["release", "workflow_dispatch"])
  assert.deepEqual(workflowTriggers("on: [push, pull_request]\njobs: {}"), ["push", "pull_request"])
})

test("accepts the unsigned line while signing is a maintainer dispatch only", () => {
  assert.deepEqual(evaluateUnsignedBuild([{ path: ".github/workflows/desktop-signing.yml", content: dispatchOnly }], settings), [])
})

test("fails once a signing build runs on an automatic trigger while Settings still says unsigned", () => {
  const failures = evaluateUnsignedBuild([{ path: ".github/workflows/desktop-signing.yml", content: onRelease }], settings)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /requires signing on release/)
  assert.match(failures[0], /still says/)
})

test("fails the other way round: the line gone while no automatic signing build exists", () => {
  const failures = evaluateUnsignedBuild([{ path: ".github/workflows/desktop-signing.yml", content: dispatchOnly }], "<p>Signed by getdomovoi.</p>")
  assert.equal(failures.length, 1)
  assert.match(failures[0], /no workflow requires signing/)
})
