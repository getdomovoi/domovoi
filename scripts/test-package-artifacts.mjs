import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { execFile } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { pnpmInvocation } from "./package-artifact-command.mjs"

const pnpm = pnpmInvocation()
const repositoryRoot = new URL("../", import.meta.url)
const run = promisify(execFile)

async function packedPackage(selector) {
  const destination = mkdtempSync(join(tmpdir(), "domovoi pack-"))

  try {
    await run(
      pnpm.command,
      ["--filter", selector, "pack", "--json", "--pack-destination", destination],
      { cwd: repositoryRoot, encoding: "utf8", shell: pnpm.shell },
    )

    const archives = readdirSync(destination).filter((file) => file.endsWith(".tgz"))
    assert.equal(archives.length, 1, `${selector} must produce one package archive`)
    const filename = join(destination, archives[0])
    const manifest = JSON.parse(
      (await run("tar", ["-xOf", filename, "package/package.json"], {
        encoding: "utf8",
      })).stdout,
    )
    const files = (await run("tar", ["-tf", filename], { encoding: "utf8" })).stdout
      .trim()
      .split(/\r?\n/)
      .map((file) => file.replace(/^package\//, ""))

    return { files: new Set(files), manifest }
  } finally {
    rmSync(destination, { force: true, recursive: true })
  }
}

const contracts = [
  {
    selector: "@getdomovoi/protocol",
    requiredFiles: ["README.md", "LICENSE", "package.json", "dist/index.js", "dist/index.d.ts"],
  },
  {
    selector: "@getdomovoi/daemon",
    requiredFiles: [
      "README.md",
      "LICENSE",
      "package.json",
      "dist/index.js",
      "dist/server.js",
      "dist/server.d.ts",
    ],
  },
]

for (const contract of contracts) {
  const { files, manifest } = await packedPackage(contract.selector)

  assert.equal(manifest.private, undefined, `${contract.selector} must be publishable`)
  assert.equal(manifest.license, "Apache-2.0")
  assert.equal(manifest.publishConfig?.access, "public")
  assert.equal(manifest.homepage, "https://domovoi.sh")
  assert.equal(manifest.engines?.node, ">=22")

  for (const requiredFile of contract.requiredFiles) {
    assert.ok(files.has(requiredFile), `${contract.selector} must pack ${requiredFile}`)
  }

  for (const file of files) {
    assert.doesNotMatch(file, /(^|\/)(src|test|tests)(\/|$)/, `${contract.selector} leaked ${file}`)
  }
}

console.log("Package artifact contracts passed")
