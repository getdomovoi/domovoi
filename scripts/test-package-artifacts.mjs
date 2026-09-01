import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { inspectArchive, packPackage } from "./pack-package.mjs"

async function packedPackage(selector) {
  const destination = mkdtempSync(join(tmpdir(), "domovoi pack-"))

  try {
    return await inspectArchive(await packPackage(selector, destination))
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
