import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
const cli = require.resolve("@changesets/cli/bin.js")
const command = (cwd, name, args) => exec(name, args, {
  cwd, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024,
})

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "domovoi release metadata-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path, value) => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), typeof value === "string" ? value : JSON.stringify(value, null, 2))
  }
  await put("package.json", { name: "fixture", private: true, packageManager: "pnpm@11.5.3" })
  await put("pnpm-workspace.yaml", "packages:\n  - packages/*\n  - apps/*\n")
  await put(".changeset/config.json", JSON.parse(await readFile(new URL("../.changeset/config.json", import.meta.url), "utf8")))
  await put("packages/protocol/package.json", { name: "@getdomovoi/protocol", version: "0.0.1" })
  await put("apps/daemon/package.json", { name: "@getdomovoi/daemon", version: "0.0.1", dependencies: { "@getdomovoi/protocol": "workspace:*" } })
  await put("packages/protocol/src/index.ts", "export const protocol = 1\n")
  await put(".changeset/old.md", '---\n"@getdomovoi/protocol": minor\n---\nExisting work.\n')
  await command(root, "git", ["init", "--initial-branch=main"])
  await command(root, "git", ["add", "."])
  await command(root, "git", ["-c", "user.name=Release fixture", "-c", "user.email=release@example.invalid", "commit", "--no-gpg-sign", "-m", "test: baseline"])
  const base = (await command(root, "git", ["rev-parse", "HEAD"])).stdout.trim()
  const check = async () => {
    const { checkReleaseMetadata } = await import("./release-metadata.mjs")
    await command(root, "git", ["add", "."])
    return checkReleaseMetadata({ root, base })
  }
  return { root, put, check }
}

test("old accumulated changesets cannot cover a new source change", { timeout: 45_000 }, async (t) => {
  const { put, check } = await fixture(t)
  await put("packages/protocol/src/index.ts", "export const protocol = 2\n")
  await assert.rejects(check(), /changeset|release metadata/i)
})

test("a new changeset covers this compatibility unit", { timeout: 45_000 }, async (t) => {
  const { put, check } = await fixture(t)
  await put("packages/protocol/src/index.ts", "export const protocol = 2\n")
  await put(".changeset/new.md", '---\n"@getdomovoi/protocol": patch\n---\nNew change.\n')
  assert.equal((await check()).state, "changeset")
})

test("docs and tooling need no invented release", { timeout: 45_000 }, async (t) => {
  const { put, check } = await fixture(t)
  await put("docs/release.md", "Reviewed instructions.\n")
  await put("scripts/tool.mjs", "export const value = 1\n")
  assert.equal((await check()).state, "no-release-change")
})

test("deleting an entire package still needs this PR's release metadata", { timeout: 45_000 }, async (t) => {
  const { root, check } = await fixture(t)
  await rm(join(root, "apps/daemon"), { recursive: true })
  await assert.rejects(check(), /changeset|release metadata/i)
})

test("real Changesets version output is accepted but source edits on it are not", { timeout: 45_000 }, async (t) => {
  const { root, put, check } = await fixture(t)
  await command(root, process.execPath, [cli, "pre", "enter", "alpha"])
  await command(root, process.execPath, [cli, "version"])
  assert.equal((await check()).state, "version")
  for (const path of ["packages/protocol", "apps/daemon"]) {
    const manifest = JSON.parse(await readFile(join(root, path, "package.json"), "utf8"))
    assert.equal(manifest.version, "0.1.0-alpha.0")
    assert.match(await readFile(join(root, path, "CHANGELOG.md"), "utf8"), /0\.1\.0-alpha\.0/)
  }
  await put("packages/protocol/src/index.ts", "export const protocol = 3\n")
  await assert.rejects(check(), /changeset|release metadata/i)
})

test("a version-shaped dependency change is not a generated version PR", { timeout: 45_000 }, async (t) => {
  const { root, put, check } = await fixture(t)
  await command(root, process.execPath, [cli, "version"])
  const file = join(root, "apps/daemon/package.json")
  const manifest = JSON.parse(await readFile(file, "utf8"))
  manifest.dependencies["unexpected-runtime"] = "1.0.0"
  await put("apps/daemon/package.json", manifest)
  await assert.rejects(check(), /changeset|release metadata/i)
})
