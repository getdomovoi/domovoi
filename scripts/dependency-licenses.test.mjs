import assert from "node:assert/strict"
import test from "node:test"

import { evaluateDependencyLicenses } from "./dependency-licenses.mjs"

const policy = { allowed: ["Apache-2.0", "BSD-2-Clause", "MIT"], exceptions: {} }

test("accepts a graph whose licenses are all allowed", () => {
  assert.deepEqual(evaluateDependencyLicenses({
    "MIT": [{ name: "ws", versions: ["8.18.3"] }],
    "Apache-2.0": [{ name: "@agentclientprotocol/sdk", versions: ["1.4.0"] }],
  }, policy), [])
})

test("reports a package whose license is outside the policy", () => {
  assert.deepEqual(evaluateDependencyLicenses({
    "GPL-3.0": [{ name: "copyleft-thing", versions: ["2.0.0"] }],
  }, policy), [
    "copyleft-thing@2.0.0: GPL-3.0 is not an allowed license",
  ])
})

test("reports an unknown license, which is not the same as a permissive one", () => {
  assert.deepEqual(evaluateDependencyLicenses({
    "Unknown": [{ name: "mystery", versions: ["1.0.0"] }],
  }, policy), [
    "mystery@1.0.0: Unknown is not an allowed license",
  ])
})

test("allows a package the policy records as a reviewed exception", () => {
  assert.deepEqual(evaluateDependencyLicenses({
    "Unknown": [{ name: "@anthropic-ai/claude-agent-sdk", versions: ["0.3.247"] }],
  }, {
    allowed: ["MIT"],
    exceptions: { "@anthropic-ai/claude-agent-sdk": "proprietary, required by the Claude Code adapter" },
  }), [])
})

test("reports every version of a package that carries a disallowed license", () => {
  assert.deepEqual(evaluateDependencyLicenses({
    "LGPL-3.0": [{ name: "shared-thing", versions: ["1.0.0", "2.0.0"] }],
  }, policy), [
    "shared-thing@1.0.0: LGPL-3.0 is not an allowed license",
    "shared-thing@2.0.0: LGPL-3.0 is not an allowed license",
  ])
})

test("reports an exception the graph no longer contains, so the policy stays honest", () => {
  assert.deepEqual(evaluateDependencyLicenses({ "MIT": [{ name: "ws", versions: ["8.18.3"] }] }, {
    allowed: ["MIT"],
    exceptions: { "removed-thing": "was needed once" },
  }), [
    "license-policy.json: removed-thing is an exception but no longer in the dependency graph",
  ])
})

test("allows every platform binary covered by a pattern exception", () => {
  const patternPolicy = {
    allowed: ["MIT"],
    exceptions: { "@anthropic-ai/claude-agent-sdk-*": "platform binaries of a reviewed package" },
  }

  assert.deepEqual(evaluateDependencyLicenses({
    "Unknown": [
      { name: "@anthropic-ai/claude-agent-sdk-linux-x64", versions: ["0.3.247"] },
      { name: "@anthropic-ai/claude-agent-sdk-win32-x64", versions: ["0.3.247"] },
    ],
  }, patternPolicy), [])
})

test("does not call a pattern exception stale, since platform binaries differ per runner", () => {
  assert.deepEqual(evaluateDependencyLicenses({ "MIT": [{ name: "ws", versions: ["8.18.3"] }] }, {
    allowed: ["MIT"],
    exceptions: { "@anthropic-ai/claude-agent-sdk-*": "platform binaries of a reviewed package" },
  }), [])
})

test("still reports an exact exception that left the graph", () => {
  assert.deepEqual(evaluateDependencyLicenses({ "MIT": [{ name: "ws", versions: ["8.18.3"] }] }, {
    allowed: ["MIT"],
    exceptions: { "gone": "was needed once", "kept-*": "pattern" },
  }), [
    "license-policy.json: gone is an exception but no longer in the dependency graph",
  ])
})
