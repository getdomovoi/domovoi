import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"

import {
  checkVersionLockstep,
  evaluateVersionLockstep,
  workspaceDirectories,
} from "./version-lockstep.mjs"

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), "domovoi-lockstep-"))
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(root, dirname(path)), { recursive: true })
    await writeFile(join(root, path), contents)
  }
  return root
}

function manifest(name, version) {
  return JSON.stringify({ name, version })
}

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

test("reads the workspace roots from the pnpm workspace globs", () => {
  assert.deepEqual(workspaceDirectories([
    "packages:",
    "  - apps/*",
    "  - packages/*",
    "  - tools/**",
    "",
    "catalog:",
    "  typescript: ^5.9.2",
  ].join("\n")), {
    directories: [
      { directory: "apps", recursive: false },
      { directory: "packages", recursive: false },
      { directory: "tools", recursive: true },
    ],
    exclusions: [],
    unsupported: [],
  })
})

test("keeps reading past entries that name no single root", () => {
  assert.deepEqual(workspaceDirectories([
    "packages:",
    "  - \"!**/dist/**\"",
    "  - .",
    "  - packages/*/*",
    "  - apps/*",
    "  - packages/*",
  ].join("\n")), {
    directories: [
      { directory: "packages", recursive: true },
      { directory: "apps", recursive: false },
    ],
    exclusions: ["**/dist/**"],
    unsupported: [],
  })
})

test("reads a flow-style package list", () => {
  assert.deepEqual(workspaceDirectories('packages: ["apps/*", "packages/*"]\n'), {
    directories: [
      { directory: "apps", recursive: false },
      { directory: "packages", recursive: false },
    ],
    exclusions: [],
    unsupported: [],
  })
})

test("reports a glob whose own first segment is not a directory", () => {
  assert.deepEqual(workspaceDirectories("packages:\n  - packages/*\n  - plugin-*/src\n"), {
    directories: [{ directory: "packages", recursive: false }],
    exclusions: [],
    unsupported: ["plugin-*/src"],
  })
})

test("stops reading at the next top-level key", () => {
  assert.deepEqual(workspaceDirectories([
    "packages:",
    "  - apps/*",
    "onlyBuiltDependencies:",
    "  - electron",
  ].join("\n")), {
    directories: [{ directory: "apps", recursive: false }],
    exclusions: [],
    unsupported: [],
  })
})

test("skips a directory that holds no package manifest", async (t) => {
  const root = await fixture({
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
    "apps/daemon/package.json": manifest("@getdomovoi/daemon", "0.0.1"),
  })
  await mkdir(join(root, "apps", "leftover"), { recursive: true })
  t.after(() => rm(root, { recursive: true, force: true }))

  const result = await checkVersionLockstep(root)
  assert.deepEqual(result.packages, [
    { name: "@getdomovoi/daemon", path: "apps/daemon/package.json", version: "0.0.1" },
  ])
  assert.deepEqual(result.failures, [])
})

test("fails when the workspace declares a root that does not exist", async (t) => {
  const root = await fixture({
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - tools/*\n",
    "apps/daemon/package.json": manifest("@getdomovoi/daemon", "0.0.1"),
  })
  t.after(() => rm(root, { recursive: true, force: true }))

  assert.deepEqual((await checkVersionLockstep(root)).failures, [
    "pnpm-workspace.yaml: tools/ is declared but missing",
  ])
})

test("fails instead of passing when it finds no package at all", async (t) => {
  const root = await fixture({ "pnpm-workspace.yaml": "packages: []\n" })
  t.after(() => rm(root, { recursive: true, force: true }))

  assert.deepEqual((await checkVersionLockstep(root)).failures, [
    "pnpm-workspace.yaml: no workspace package was found, so no version was checked",
  ])
})

test("still reports drift found through the workspace globs", async (t) => {
  const root = await fixture({
    "pnpm-workspace.yaml": "packages:\n  - \"!**/dist/**\"\n  - apps/*\n  - packages/*\n",
    "apps/daemon/package.json": manifest("@getdomovoi/daemon", "9.9.9"),
    "packages/protocol/package.json": manifest("@getdomovoi/protocol", "0.0.1"),
    "packages/ui/package.json": manifest("@getdomovoi/ui", "0.0.1"),
  })
  t.after(() => rm(root, { recursive: true, force: true }))

  assert.deepEqual((await checkVersionLockstep(root)).failures, [
    "apps/daemon/package.json: @getdomovoi/daemon is 9.9.9, expected 0.0.1",
  ])
})

test("refuses a leading version that is only a plurality", () => {
  assert.deepEqual(evaluateVersionLockstep([
    { name: "@getdomovoi/protocol", path: "packages/protocol/package.json", version: "0.0.1" },
    { name: "@getdomovoi/ui", path: "packages/ui/package.json", version: "0.0.1" },
    { name: "@getdomovoi/daemon", path: "apps/daemon/package.json", version: "0.1.0" },
    { name: "@getdomovoi/web", path: "apps/web/package.json", version: "0.2.0" },
  ]), [
    "workspace versions disagree with no majority: @getdomovoi/daemon 0.1.0, @getdomovoi/protocol 0.0.1, @getdomovoi/ui 0.0.1, @getdomovoi/web 0.2.0",
  ])
})

test("finds a package nested under a recursive workspace glob", async (t) => {
  const root = await fixture({
    "pnpm-workspace.yaml": "packages:\n  - apps/**\n",
    "apps/services/daemon/package.json": manifest("@getdomovoi/daemon", "0.0.1"),
  })
  t.after(() => rm(root, { recursive: true, force: true }))

  const result = await checkVersionLockstep(root)
  assert.deepEqual(result.packages, [
    { name: "@getdomovoi/daemon", path: "apps/services/daemon/package.json", version: "0.0.1" },
  ])
  assert.deepEqual(result.failures, [])
})

test("honors an excluded package instead of holding it to the workspace version", async (t) => {
  const root = await fixture({
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n  - \"!packages/legacy\"\n",
    "packages/protocol/package.json": manifest("@getdomovoi/protocol", "0.0.1"),
    "packages/ui/package.json": manifest("@getdomovoi/ui", "0.0.1"),
    "packages/legacy/package.json": manifest("@getdomovoi/legacy", "3.1.4"),
  })
  t.after(() => rm(root, { recursive: true, force: true }))

  const result = await checkVersionLockstep(root)
  assert.deepEqual(result.packages.map((entry) => entry.name), [
    "@getdomovoi/protocol",
    "@getdomovoi/ui",
  ])
  assert.deepEqual(result.failures, [])
})
