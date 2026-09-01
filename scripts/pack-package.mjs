import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"

import { pnpmInvocation } from "./package-artifact-command.mjs"

const pnpm = pnpmInvocation()
const repositoryRoot = new URL("../", import.meta.url)
const run = promisify(execFile)

export async function packPackage(selector, destination) {
  await run(
    pnpm.command,
    ["--filter", selector, "pack", "--json", "--pack-destination", destination],
    { cwd: repositoryRoot, encoding: "utf8", shell: pnpm.shell },
  )

  const archives = readdirSync(destination).filter((file) => file.endsWith(".tgz"))
  assert.equal(archives.length, 1, `${selector} must produce one package archive`)
  return join(destination, archives[0])
}

export async function inspectArchive(archive) {
  const manifest = JSON.parse(
    (await run("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" })).stdout,
  )
  const files = (await run("tar", ["-tf", archive], { encoding: "utf8" })).stdout
    .trim()
    .split(/\r?\n/)
    .map((file) => file.replace(/^package\//, ""))

  return { files: new Set(files), manifest }
}
