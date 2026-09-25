import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
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

// The entry these proofs load: the daemon answers --version and starts nothing else.
const versionEntry = 'if (process.argv[2] === "--version") process.stdout.write("0.0.1\\n")\n'

async function fixture(prefix, files) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  for (const [name, body] of Object.entries(files)) await writeFile(join(root, name), body)
  return root
}

test("proves the daemon runs by its version under the pinned program, and refuses any other answer", async () => {
  const root = await fixture("domovoi-runtime-prove-", { "index.mjs": versionEntry })
  try {
    // The Node running this test stands in for the unpacked program; its digest is the member digest.
    const program = { nodeExecutable: process.execPath, nodeSha256: await sha256Of(process.execPath) }
    const daemonEntry = join(root, "index.mjs")
    assert.equal(await proveDaemonRuns({ ...program, daemonEntry, expectedVersion: "0.0.1" }), "0.0.1")
    await assert.rejects(proveDaemonRuns({ ...program, daemonEntry, expectedVersion: "0.0.2" }), /printed version "0.0.1", expected 0.0.2/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("refuses to run a program that is not the one unpacked from the verified archive", async () => {
  const root = await fixture("domovoi-runtime-fake-node-", { node: "a fake node that prints any version", "index.mjs": versionEntry })
  try {
    const calls = []
    const run = async (...args) => { calls.push(args); return { stdout: "0.0.1\n" } }
    const pinnedMember = createHash("sha256").update("the node program in the verified archive").digest("hex")
    await assert.rejects(
      proveDaemonRuns({ nodeExecutable: join(root, "node"), nodeSha256: pinnedMember, daemonEntry: join(root, "index.mjs"), expectedVersion: "0.0.1", run }),
      /the program unpacked from the verified archive has sha256 [0-9a-f]{64}\. Nothing was run/,
    )
    assert.deepEqual(calls, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("refuses a version answer from a program that never loaded the daemon entry", async () => {
  const root = await fixture("domovoi-runtime-ignored-entry-", { node: "prints the version, ignores its arguments", "index.mjs": 'throw new Error("the entry does not load")\n' })
  try {
    const nodeExecutable = join(root, "node")
    // Prints the expected version whatever it is asked, as the review's fake program did.
    const run = async () => ({ stdout: "0.0.1\n" })
    await assert.rejects(
      proveDaemonRuns({ nodeExecutable, nodeSha256: await sha256Of(nodeExecutable), daemonEntry: join(root, "index.mjs"), expectedVersion: "0.0.1", run }),
      /did not load under/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("refuses a daemon entry that throws when the pinned program loads it", async () => {
  const root = await fixture("domovoi-runtime-throwing-entry-", { "index.mjs": 'process.stdout.write("0.0.1\\n")\nthrow new Error("the entry does not load")\n' })
  try {
    await assert.rejects(
      proveDaemonRuns({ nodeExecutable: process.execPath, nodeSha256: await sha256Of(process.execPath), daemonEntry: join(root, "index.mjs"), expectedVersion: "0.0.1" }),
      /the entry does not load/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("unpacks only a verified archive and reports the digest of the program it unpacked", async () => {
  const { unpackNode } = await import("./daemon-runtime.mjs")
  const { mkdir, readdir } = await import("node:fs/promises")
  const root = await fixture("domovoi-runtime-unpack-", { "node.tar.gz": "archive bytes" })
  try {
    const archive = join(root, "node.tar.gz")
    const target = { ...runtimeTarget("darwin", "arm64"), sha256: await sha256Of(archive) }
    const calls = []
    // Stands in for tar: lays out the archive's top directory in the staging directory.
    const run = async (file, args) => {
      calls.push(file)
      const top = join(args[args.indexOf("-C") + 1], "node-v24.21.0-darwin-arm64")
      await mkdir(join(top, "bin"), { recursive: true })
      await mkdir(join(top, "include"), { recursive: true })
      await writeFile(join(top, "bin", "node"), "the node program")
      await writeFile(join(top, "bin", "npm"), "npm")
      await writeFile(join(top, "LICENSE"), "licence")
      return { stdout: "" }
    }
    const destination = join(root, "out", "node")
    const unpacked = await unpackNode({ archive, target, destination, run })
    assert.equal(unpacked.executable, join(destination, "bin", "node"))
    assert.equal(unpacked.sha256, createHash("sha256").update("the node program").digest("hex"))
    assert.deepEqual((await readdir(destination, { recursive: true })).map((p) => p.replaceAll("\\", "/")).sort(), ["LICENSE", "bin", "bin/node"])

    await writeFile(archive, "archive bytes changed after the download was verified")
    await assert.rejects(unpackNode({ archive, target, destination, run }), /pinned [0-9a-f]{64}\. Nothing was unpacked/)
    assert.deepEqual(calls, ["tar"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("removes a cached archive whose digest is not the pinned one, so the next run downloads again", async () => {
  const cache = await mkdtemp(join(tmpdir(), "domovoi-node-cache-poisoned-"))
  try {
    const target = runtimeTarget("darwin", "arm64")
    await writeFile(join(cache, target.archive), "poisoned")
    let downloads = 0
    const download = async () => { downloads += 1 }
    const refused = await fetchNodeArchive({ target, cacheDirectory: cache, download }).then(() => undefined, (error) => error)
    assert.match(String(refused), /sha256 [0-9a-f]{64}, pinned bed7eea5/)
    assert.equal(downloads, 0)
    await assert.rejects(readFile(join(cache, target.archive)), { code: "ENOENT" })
    assert.match(refused.message, /It was removed; run again to download it\./)
  } finally {
    await rm(cache, { recursive: true, force: true })
  }
})

test("keeps no partial archive when the download fails", async () => {
  const { readdir } = await import("node:fs/promises")
  const cache = await mkdtemp(join(tmpdir(), "domovoi-node-cache-partial-"))
  try {
    const target = runtimeTarget("darwin", "arm64")
    const download = async (_url, destination) => {
      await writeFile(destination, "half an archive")
      throw new Error("connection reset")
    }
    await assert.rejects(fetchNodeArchive({ target, cacheDirectory: cache, download }), /connection reset/)
    assert.deepEqual(await readdir(cache), [])
  } finally {
    await rm(cache, { recursive: true, force: true })
  }
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
      "node_modules/@x/y/NOTICE.md", "node_modules/@x/y/COPYING.md",
      "node_modules/.bin/yaml",
    ]) await file(path)
    const removed = await pruneDaemonRuntime(root, { platform: "darwin", arch: "arm64" })
    const kept = (await readdir(root, { recursive: true })).map((p) => p.replaceAll("\\", "/")).filter((p) => /\.[a-z]+$|pty\.node|spawn-helper|LICENSE$/.test(p)).sort()
    assert.deepEqual(kept, [
      "dist/index.js", "dist/public.js",
      "node_modules/@x/y/COPYING.md", "node_modules/@x/y/LICENSE.md", "node_modules/@x/y/NOTICE.md", "node_modules/@x/y/dist/a.mjs",
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

test("rewrites every link that stays inside the shipped tree so a verbatim copy resolves inside the copy", async () => {
  const { removeExternalLinks } = await import("./daemon-runtime.mjs")
  const { cp, lstat, mkdir, readdir, realpath, symlink } = await import("node:fs/promises")
  const root = await mkdtemp(join(tmpdir(), "domovoi-runtime-internal-links-"))
  const elsewhere = await mkdtemp(join(tmpdir(), "domovoi-runtime-copied-"))
  try {
    const shipped = join(root, "daemon")
    await mkdir(join(shipped, "node_modules", "real"), { recursive: true })
    await mkdir(join(shipped, "node_modules", ".pnpm", "node_modules"), { recursive: true })
    await mkdir(join(shipped, "dist"), { recursive: true })
    await writeFile(join(shipped, "node_modules", "real", "index.js"), "module")
    await writeFile(join(shipped, "dist", "index.js"), "entry")
    // Absolute links into the staging tree, as a junction or pnpm leaves them.
    await symlink(join(shipped, "node_modules", "real"), join(shipped, "node_modules", ".pnpm", "node_modules", "absolute-directory"), "dir")
    await symlink(join(shipped, "dist", "index.js"), join(shipped, "dist", "absolute-file.js"), "file")
    // Relative, but it climbs out of the tree and back in by the staging directory's name.
    await symlink(join("..", "..", "daemon", "node_modules", "real"), join(shipped, "node_modules", "reentering"), "dir")

    assert.equal(await removeExternalLinks(shipped, shipped), 0)
    const { assertShippedTreeContained } = await import("./daemon-runtime.mjs")
    assert.equal(await assertShippedTreeContained(shipped), 3)
    const copy = join(elsewhere, "runtime")
    await cp(shipped, copy, { recursive: true, verbatimSymlinks: true })
    await rm(root, { recursive: true, force: true })

    const inside = `${await realpath(copy)}${sep}`
    const links = []
    const walk = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isSymbolicLink()) links.push(path)
        else if (entry.isDirectory()) await walk(path)
      }
    }
    await walk(copy)
    assert.deepEqual(links.map((path) => path.slice(copy.length + 1).replaceAll("\\", "/")).sort(), [
      "dist/absolute-file.js", "node_modules/.pnpm/node_modules/absolute-directory", "node_modules/reentering",
    ])
    for (const link of links) {
      assert.ok((await lstat(link)).isSymbolicLink())
      const target = await realpath(link).catch((error) => `unresolved: ${error.code}`)
      assert.ok(target.startsWith(inside), `${link} resolves to ${target}, outside the copy`)
    }
    assert.equal(await readFile(join(copy, "node_modules", "reentering", "index.js"), "utf8"), "module")
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(elsewhere, { recursive: true, force: true })
  }
})

test("unpacks only the verified copy, even when the cached archive is swapped after its check", async () => {
  const { unpackNode } = await import("./daemon-runtime.mjs")
  const { mkdir } = await import("node:fs/promises")
  const root = await fixture("domovoi-runtime-archive-swap-", { "node.tar.gz": "the node program" })
  try {
    const archive = join(root, "node.tar.gz")
    const target = { ...runtimeTarget("darwin", "arm64"), sha256: await sha256Of(archive) }
    // A toy archive format whose program is the archive's bytes. The cached
    // archive is swapped after every check, just before tar reads its input.
    const run = async (_file, args) => {
      await writeFile(archive, "a fake node program")
      const top = join(args[args.indexOf("-C") + 1], "node-v24.21.0-darwin-arm64")
      await mkdir(join(top, "bin"), { recursive: true })
      await writeFile(join(top, "bin", "node"), await readFile(args[args.indexOf("-xf") + 1]))
      return { stdout: "" }
    }
    const unpacked = await unpackNode({ archive, target, destination: join(root, "out", "node"), run })
    assert.equal(await readFile(unpacked.executable, "utf8"), "the node program")
    assert.equal(unpacked.sha256, createHash("sha256").update("the node program").digest("hex"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("removes a file swapped for an outside link while the walk runs", async () => {
  const { removeExternalLinks } = await import("./daemon-runtime.mjs")
  const { createRequire, syncBuiltinESMExports } = await import("node:module")
  const { lstat, mkdir, symlink } = await import("node:fs/promises")
  const promises = createRequire(import.meta.url)("node:fs/promises")
  const listed = promises.readdir
  const root = await mkdtemp(join(tmpdir(), "domovoi-runtime-walk-swap-"))
  try {
    const shipped = join(root, "daemon")
    const directory = join(shipped, "node_modules", "pkg")
    const swapped = join(directory, "index.js")
    await mkdir(directory, { recursive: true })
    await mkdir(join(root, "outside"))
    await writeFile(swapped, "module")
    await writeFile(join(root, "outside", "secret"), "outside the shipped tree")
    let raced = false
    // The race: the directory is listed while index.js is a file, and the
    // file becomes a link out of the tree before the walk acts on it.
    promises.readdir = async (path, ...rest) => {
      const entries = await listed(path, ...rest)
      if (!raced && path === directory) {
        raced = true
        await rm(swapped)
        await symlink(join(root, "outside", "secret"), swapped, "file")
      }
      return entries
    }
    syncBuiltinESMExports()
    await removeExternalLinks(shipped, shipped)
    assert.ok(raced)
    await assert.rejects(lstat(swapped), { code: "ENOENT" })
  } finally {
    promises.readdir = listed
    syncBuiltinESMExports()
    await rm(root, { recursive: true, force: true })
  }
})

test("the final check refuses a shipped tree with any link that leaves it, and passes one that stays inside", async () => {
  const { assertShippedTreeContained } = await import("./daemon-runtime.mjs")
  const { mkdir, symlink } = await import("node:fs/promises")
  const root = await mkdtemp(join(tmpdir(), "domovoi-runtime-final-check-"))
  try {
    const tree = join(root, "runtime")
    const modules = join(tree, "daemon", "node_modules")
    await mkdir(join(modules, "real"), { recursive: true })
    await mkdir(join(tree, "node", "bin"), { recursive: true })
    await mkdir(join(root, "outside"))
    await writeFile(join(modules, "real", "index.js"), "module")
    await writeFile(join(tree, "node", "bin", "node"), "program")
    await symlink("real", join(modules, "alias"), "dir")
    assert.equal(await assertShippedTreeContained(tree), 1)

    await symlink(join(modules, "real"), join(modules, "absolute"), "dir")
    await symlink(join(root, "outside"), join(modules, "outside"), "dir")
    await symlink(join("..", "..", "..", "runtime", "daemon", "node_modules", "real"), join(modules, "reentering"), "dir")
    await symlink("missing", join(modules, "dangling"), "file")
    const refused = await assertShippedTreeContained(tree).then(() => undefined, (error) => error)
    assert.ok(refused instanceof Error, "the final check passed a tree with links that leave it")
    for (const name of ["absolute", "outside", "reentering", "dangling"]) assert.match(refused.message, new RegExp(`node_modules[\\\\/]${name}\\b`))
    assert.doesNotMatch(refused.message, /alias/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("refuses a runtime tree root that is itself a link, before walking it", async () => {
  const { assertShippedTreeContained, removeExternalLinks } = await import("./daemon-runtime.mjs")
  const { mkdir, symlink } = await import("node:fs/promises")
  const root = await mkdtemp(join(tmpdir(), "domovoi-runtime-root-link-"))
  try {
    // The root link points at a tree outside the runtime directory that holds
    // no links at all, so a walk from the resolved root finds nothing wrong.
    const outside = join(root, "outside")
    await mkdir(join(outside, "node", "bin"), { recursive: true })
    await writeFile(join(outside, "node", "bin", "node"), "a program from outside the build")
    const runtime = join(root, "runtime")
    await symlink(outside, runtime, "dir")
    await assert.rejects(assertShippedTreeContained(runtime), /runtime is a symbolic link/)
    await assert.rejects(removeExternalLinks(runtime, runtime), /runtime is a symbolic link/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
