import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { inspectArchive, packPackage } from "./pack-package.mjs"

const unresolvedSpecifier = /^(workspace|catalog|link|file|portal):/
const dependencyFields = ["dependencies", "peerDependencies", "optionalDependencies"]

async function packedPackage(selector) {
  const destination = mkdtempSync(join(tmpdir(), "domovoi pack-"))

  try {
    const archive = await packPackage(selector, destination)
    const result = await inspectArchive(archive)
    if (selector === "@getdomovoi/daemon") {
      const entry = (path) => execFileSync("tar", ["-xOf", archive, `package/${path}`], {
        timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
      })
      const lock = JSON.parse(entry("runtime/lock.json"))
      assert.deepEqual(lock.packages[""], JSON.parse(entry("runtime/package.json")))
      assert.equal(lock.version, result.manifest.version)
      assert.equal(lock.packages["node_modules/@getdomovoi/protocol"].version, result.manifest.version)
      assert.equal(lock.packages["node_modules/@getdomovoi/protocol"].integrity,
        `sha512-${createHash("sha512").update(entry("runtime/protocol.tgz")).digest("base64")}`)
    }
    return result
  } finally {
    rmSync(destination, { force: true, recursive: true })
  }
}

function entryPaths(manifest) {
  const paths = new Set()
  const collect = (value) => {
    if (typeof value === "string") {
      if (value.startsWith("./")) paths.add(value.slice(2))
      return
    }
    if (value && typeof value === "object") for (const nested of Object.values(value)) collect(nested)
  }

  for (const field of ["exports", "bin", "main", "types"]) collect(manifest[field])
  return [...paths]
}

function unresolvedDependencies(manifest) {
  const unresolved = []
  for (const field of dependencyFields) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (unresolvedSpecifier.test(range)) unresolved.push(`${field}.${name} is ${range}`)
    }
  }
  return unresolved
}

const contracts = [
  {
    selector: "@getdomovoi/protocol",
    requiredFiles: ["README.md", "LICENSE", "package.json", "dist/index.js", "dist/index.d.ts"],
    exports: [".", "./package.json"],
  },
  {
    selector: "@getdomovoi/daemon",
    requiredFiles: [
      "README.md",
      "LICENSE",
      "package.json",
      "dist/index.js",
      "dist/public.js",
      "dist/public.d.ts",
      "dist/server.js",
      "dist/server.d.ts",
      "runtime/lock.json",
      "runtime/package.json",
      "runtime/protocol.tgz",
    ],
    exports: [".", "./internal"],
  },
]

for (const contract of contracts) {
  const { files, manifest } = await packedPackage(contract.selector)

  assert.equal(manifest.private, undefined, `${contract.selector} must be publishable`)
  assert.equal(manifest.license, "Apache-2.0")
  assert.equal(manifest.publishConfig?.access, "public")
  assert.equal(manifest.homepage, "https://domovoi.sh")
  assert.equal(manifest.engines?.node, contract.selector === "@getdomovoi/daemon" ? ">=22.13.0" : ">=22")
  assert.ok(manifest.description, `${contract.selector} must describe itself for the registry`)
  assert.ok(manifest.bugs?.url, `${contract.selector} must say where to report bugs`)
  assert.ok(
    manifest.repository?.url?.startsWith("git+https://"),
    `${contract.selector} must carry a resolvable repository url`,
  )

  assert.deepEqual(
    unresolvedDependencies(manifest),
    [],
    `${contract.selector} must not publish workspace-only dependency ranges`,
  )

  assert.deepEqual(
    Object.keys(manifest.exports ?? {}),
    contract.exports,
    `${contract.selector} must publish exactly these entry points`,
  )

  for (const entry of entryPaths(manifest)) {
    assert.ok(files.has(entry), `${contract.selector} names ${entry} but does not pack it`)
  }

  for (const requiredFile of contract.requiredFiles) {
    assert.ok(files.has(requiredFile), `${contract.selector} must pack ${requiredFile}`)
  }

  for (const file of files) {
    assert.doesNotMatch(file, /(^|\/)(src|test|tests)(\/|$)/, `${contract.selector} leaked ${file}`)
    assert.doesNotMatch(file, /\.map$/, `${contract.selector} leaked the source map ${file}`)
  }
}

console.log("Package artifact contracts passed")
