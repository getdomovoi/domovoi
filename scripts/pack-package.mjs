import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"

import { pnpmInvocation } from "./package-artifact-command.mjs"
import { bootstrapDeadline } from "./bootstrap-deadline.mjs"

const repositoryRoot = new URL("../", import.meta.url)
const run = promisify(execFile)

export async function packPackage(selector, destination, { deadline: parent } = {}) {
  const deadline = bootstrapDeadline(300_000, `Package packing exceeded 300000 ms for ${selector}`, parent)
  try {
    const pnpm = pnpmInvocation()
    await deadline.run(() => run(
      pnpm.command,
      ["--filter", selector, "pack", "--json", "--pack-destination", destination],
      { cwd: repositoryRoot, encoding: "utf8", shell: pnpm.shell, signal: deadline.signal, killSignal: "SIGKILL" },
    ))
    const archives = readdirSync(destination).filter((file) => file.endsWith(".tgz"))
    assert.equal(archives.length, 1, `${selector} must produce one package archive`)
    return join(destination, archives[0])
  } finally { deadline.clear() }
}

export async function readArchiveEntry(archive, entry, { deadline: parent } = {}) {
  const deadline = bootstrapDeadline(30_000, `Package entry inspection exceeded 30000 ms for ${archive}`, parent)
  try {
    return (await deadline.run(() => run("tar", ["-xOf", archive, entry], {
      encoding: "utf8", maxBuffer: 8 * 1024 * 1024, signal: deadline.signal, killSignal: "SIGKILL",
    }))).stdout
  } finally { deadline.clear() }
}

export async function inspectArchive(archive, { deadline: parent } = {}) {
  const deadline = bootstrapDeadline(30_000, `Package inspection exceeded 30000 ms for ${archive}`, parent)
  try {
    const options = { encoding: "utf8", signal: deadline.signal, killSignal: "SIGKILL" }
    const manifest = JSON.parse(
      (await deadline.run(() => run("tar", ["-xOf", archive, "package/package.json"], options))).stdout,
    )
    const files = (await deadline.run(() => run("tar", ["-tf", archive], options))).stdout
      .trim()
      .split(/\r?\n/)
      .map((file) => file.replace(/^package\//, ""))
    return { files: new Set(files), manifest }
  } finally { deadline.clear() }
}
