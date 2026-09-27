import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  auditedPackages, collectAuditGraph, desktopPackages, desktopRuntimeWorkspacePackages, evaluateDependencyLicenses, mergeLicenseGraphs,
} from "./dependency-licenses.mjs"
import { publishablePackages } from "./release-packages.mjs"
import { collectWorkspacePackages } from "./version-lockstep.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const names = (graph) => new Set(Object.values(graph).flat().map((entry) => entry.name))

// The desktop app ships more than the npm packages: electron-vite inlines the
// UI graph into the renderer, electron-builder copies the daemon's graph, and
// Electron itself is the runtime every build carries.
test("the audit reads the graph every published artifact ships, the desktop app included", { timeout: 60_000 }, async () => {
  const audited = names(await collectAuditGraph(root))
  const direct = async (directory) => Object.keys(JSON.parse(await readFile(join(root, directory, "package.json"), "utf8")).dependencies)
  for (const name of [
    ...(await direct("packages/ui")).filter((name) => !name.startsWith("@getdomovoi/")),
    ...(await direct("apps/cli")).filter((name) => !name.startsWith("@getdomovoi/")),
    "react-dom",
    "electron",
  ]) {
    assert.ok(audited.has(name), `${name} is in the audited graph`)
  }
})

test("names every workspace package the desktop app and the npm packages carry at runtime", async () => {
  const { packages } = await collectWorkspacePackages(root)
  const manifests = new Map(await Promise.all(packages.map(async ({ name, path }) =>
    [name, JSON.parse(await readFile(join(root, path), "utf8"))])))
  const seen = new Set()
  // electron-vite bundles the desktop app's workspace development dependencies
  // into out/, the UI into the renderer, so they ship as much as its
  // production ones. Past the app itself, only production dependencies count.
  const desktop = manifests.get("@getdomovoi/desktop")
  // The daemon also ships as the runtime beside the archive, whatever the
  // manifest calls it, so the walk starts there too.
  const builder = await readFile(join(root, "apps/desktop/electron-builder.yml"), "utf8")
  assert.match(builder, /^  - from: daemon-runtime\/\$\{platform\}-\$\{arch\}$/mu)
  const pending = [
    ...Object.entries({ ...desktop.dependencies, ...desktop.devDependencies })
      .filter(([, range]) => range.startsWith("workspace:")).map(([name]) => name),
    ...desktopRuntimeWorkspacePackages,
  ]
  seen.add("@getdomovoi/desktop")
  while (pending.length) {
    const name = pending.pop()
    if (seen.has(name)) continue
    seen.add(name)
    for (const [dependency, range] of Object.entries(manifests.get(name).dependencies ?? {})) {
      if (range.startsWith("workspace:")) pending.push(dependency)
    }
  }
  assert.deepEqual([...seen].sort(), [...desktopPackages].sort())
  for (const name of publishablePackages) assert.ok(auditedPackages.includes(name), `${name} is audited`)
})

test("merges license graphs without repeating a package or a version", () => {
  assert.deepEqual(mergeLicenseGraphs(
    { MIT: [{ name: "ws", versions: ["8.18.3"], paths: ["/a/ws"] }] },
    { MIT: [{ name: "ws", versions: ["8.18.3", "8.19.0"], paths: ["/a/ws", "/b/ws"] }, { name: "electron", versions: ["44.4.5"], paths: ["/e"] }] },
  ), { MIT: [
    { name: "ws", versions: ["8.18.3", "8.19.0"], paths: ["/a/ws", "/b/ws"] },
    { name: "electron", versions: ["44.4.5"], paths: ["/e"] },
  ] })
})

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

test("accepts a dual license whose either branch satisfies the policy", () => {
  assert.deepEqual(evaluateDependencyLicenses({
    "(MIT OR Apache-2.0)": [{ name: "dual", versions: ["1.0.0"] }],
  }, policy), [])
})

test("accepts a conjunction whose every term satisfies the policy", () => {
  assert.deepEqual(evaluateDependencyLicenses({
    "MIT AND BSD-2-Clause": [{ name: "both", versions: ["1.0.0"] }],
  }, policy), [])
})

test("reports a conjunction that drags in a license outside the policy", () => {
  assert.deepEqual(evaluateDependencyLicenses({
    "MIT AND GPL-3.0": [{ name: "tainted", versions: ["1.0.0"] }],
  }, policy), [
    "tainted@1.0.0: MIT AND GPL-3.0 is not an allowed license",
  ])
})

test("reports a disjunction where no branch satisfies the policy", () => {
  assert.deepEqual(evaluateDependencyLicenses({
    "(GPL-3.0 OR LGPL-3.0)": [{ name: "copyleft-either-way", versions: ["1.0.0"] }],
  }, policy), [
    "copyleft-either-way@1.0.0: (GPL-3.0 OR LGPL-3.0) is not an allowed license",
  ])
})

test("fails instead of passing when the graph holds no package at all", () => {
  assert.deepEqual(evaluateDependencyLicenses({}, { allowed: ["MIT"], exceptions: {} }), [
    "pnpm licenses list returned no package, so no license was checked",
  ])
})
