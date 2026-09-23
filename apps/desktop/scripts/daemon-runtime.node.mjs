import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { fetchNodeArchive, nodePins, nodeVersion, proveDaemonRuns, runtimeTarget, sha256Of } from "./daemon-runtime.mjs"
import { createHash } from "node:crypto"

test("pins one Node build per platform and architecture the desktop ships for", () => {
  assert.deepEqual(Object.keys(nodePins).sort(), ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"])
  for (const pin of Object.values(nodePins)) {
    assert.match(pin.sha256, /^[0-9a-f]{64}$/)
    assert.ok(pin.archive.includes(`v${nodeVersion}-`))
  }
  assert.equal(runtimeTarget("darwin", "arm64").nodeExecutable, "bin/node")
  assert.equal(runtimeTarget("win32", "x64").nodeExecutable, "node.exe")
  assert.throws(() => runtimeTarget("sunos", "x64"), /No Node 24\.21\.0 build is pinned for sunos-x64/)
})

test("keeps no archive whose digest is not the pinned one", async () => {
  const cache = await mkdtemp(join(tmpdir(), "domovoi-node-cache-"))
  try {
    const target = { ...runtimeTarget("darwin", "arm64") }
    const bytes = Buffer.from("not node")
    const download = async (_url, destination) => { await writeFile(destination, bytes) }
    await assert.rejects(fetchNodeArchive({ target, cacheDirectory: cache, download }), /pinned bed7eea5/)
    await assert.rejects(readFile(join(cache, target.archive)))
    const honest = { ...target, sha256: createHash("sha256").update(bytes).digest("hex") }
    const kept = await fetchNodeArchive({ target: honest, cacheDirectory: cache, download })
    assert.equal(await sha256Of(kept), honest.sha256)
  } finally {
    await rm(cache, { recursive: true, force: true })
  }
})

test("proves the daemon runs by its version, and refuses any other answer", async () => {
  const run = async () => ({ stdout: "0.0.1\n" })
  assert.equal(await proveDaemonRuns({ nodeExecutable: "/n", daemonEntry: "/d", expectedVersion: "0.0.1", run }), "0.0.1")
  await assert.rejects(proveDaemonRuns({ nodeExecutable: "/n", daemonEntry: "/d", expectedVersion: "0.0.2", run }), /printed version "0.0.1", expected 0.0.2/)
})

test("drops links with nothing behind them and links that leave the shipped tree, and keeps the rest", async () => {
  const { removeDanglingLinks, removeExternalLinks } = await import("./daemon-runtime.mjs")
  const { mkdir, symlink, lstat } = await import("node:fs/promises")
  const root = await mkdtemp(join(tmpdir(), "domovoi-runtime-links-"))
  try {
    const shipped = join(root, "daemon")
    await mkdir(join(shipped, "node_modules", "real"), { recursive: true })
    await mkdir(join(root, "outside"))
    await symlink(join(shipped, "node_modules", "real"), join(shipped, "node_modules", "inside-link"))
    await symlink(join(root, "outside"), join(shipped, "node_modules", "outside-link"))
    await symlink(join(root, "gone"), join(shipped, "node_modules", "dangling-link"))
    assert.equal(await removeDanglingLinks(join(shipped, "node_modules")), 1)
    assert.equal(await removeExternalLinks(join(shipped, "node_modules"), shipped), 1)
    await assert.doesNotReject(lstat(join(shipped, "node_modules", "inside-link")))
    await assert.rejects(lstat(join(shipped, "node_modules", "outside-link")))
    await assert.rejects(lstat(join(shipped, "node_modules", "dangling-link")))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("prunes the shipped daemon to what the runtime loads on the packaged platform", async () => {
  const { pruneDaemonRuntime } = await import("./daemon-runtime.mjs")
  const { mkdir, readdir } = await import("node:fs/promises")
  const root = await mkdtemp(join(tmpdir(), "domovoi-runtime-prune-"))
  const file = async (path, body = "x") => { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), body) }
  try {
    for (const path of [
      "dist/index.js", "dist/index.d.ts", "dist/index.js.map", "dist/public.js", "package.json",
      "node_modules/node-pty/lib/index.js", "node_modules/node-pty/package.json", "node_modules/node-pty/LICENSE", "node_modules/node-pty/README.md",
      "node_modules/node-pty/prebuilds/darwin-arm64/pty.node", "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
      "node_modules/node-pty/prebuilds/linux-x64/pty.node", "node_modules/node-pty/prebuilds/win32-x64/pty.node",
      "node_modules/node-pty/src/unix/pty.cc", "node_modules/node-pty/binding.gyp", "node_modules/node-pty/typings/node-pty.d.ts",
      "node_modules/node-pty/third_party/conpty/conpty.dll", "node_modules/node-pty/scripts/prebuild.js",
      "node_modules/zod/index.cjs", "node_modules/zod/index.d.cts", "node_modules/zod/src/index.ts", "node_modules/zod/CHANGELOG.md",
      "node_modules/@x/y/dist/a.mjs", "node_modules/@x/y/dist/a.d.mts", "node_modules/@x/y/dist/a.mjs.map", "node_modules/@x/y/LICENSE.md",
      "node_modules/.bin/yaml",
    ]) await file(path)
    const removed = await pruneDaemonRuntime(root, { platform: "darwin", arch: "arm64" })
    const kept = (await readdir(root, { recursive: true })).map((p) => p.replaceAll("\\", "/")).filter((p) => /\.[a-z]+$|pty\.node|spawn-helper|LICENSE$/.test(p)).sort()
    assert.deepEqual(kept, [
      "dist/index.js", "dist/public.js",
      "node_modules/@x/y/LICENSE.md", "node_modules/@x/y/dist/a.mjs",
      "node_modules/node-pty/LICENSE", "node_modules/node-pty/lib/index.js", "node_modules/node-pty/package.json",
      "node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
      "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
      "node_modules/zod/index.cjs",
      "package.json",
    ].sort())
    await assert.rejects(readdir(join(root, "node_modules", ".bin")))
    assert.ok(removed.bytes > 0 && removed.files > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("keeps the conpty files a Windows package needs", async () => {
  const { pruneDaemonRuntime } = await import("./daemon-runtime.mjs")
  const { mkdir, readdir } = await import("node:fs/promises")
  const root = await mkdtemp(join(tmpdir(), "domovoi-runtime-prune-win-"))
  try {
    await mkdir(join(root, "node_modules/node-pty/third_party/conpty"), { recursive: true })
    await writeFile(join(root, "node_modules/node-pty/third_party/conpty/conpty.dll"), "x")
    await mkdir(join(root, "node_modules/node-pty/prebuilds/win32-x64"), { recursive: true })
    await writeFile(join(root, "node_modules/node-pty/prebuilds/win32-x64/pty.node"), "x")
    await pruneDaemonRuntime(root, { platform: "win32", arch: "x64" })
    assert.deepEqual(await readdir(join(root, "node_modules/node-pty/third_party/conpty")), ["conpty.dll"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
