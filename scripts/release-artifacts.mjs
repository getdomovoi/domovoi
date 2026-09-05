import { createHash } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { bootstrapDeadline } from "./bootstrap-deadline.mjs"
import { validateCycloneDx } from "./cyclonedx-validation.mjs"
import { collectDependencyLicenses } from "./dependency-licenses.mjs"
import { inspectArchive, packPackage, readArchiveEntry } from "./pack-package.mjs"
import { resolveRuntimeDependency } from "./runtime-lock.mjs"
import { hashRuntimeFile, validateRuntimeLock } from "./runtime-verification.mjs"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, "..")
export const publishablePackages = ["@getdomovoi/protocol", "@getdomovoi/daemon"]
const protocolPath = "node_modules/@getdomovoi/protocol"

export function packageUrl(name, version) {
  return `pkg:npm/${name.replace("@", "%40")}@${version}`
}

export function checksumManifest(entries) {
  return [...entries]
    .sort((left, right) => left.file.localeCompare(right.file))
    .map((entry) => `${entry.sha256}  ${entry.file}\n`)
    .join("")
}

export function sbomComponents(graph) {
  const components = []
  for (const [license, packages] of Object.entries(graph)) {
    for (const entry of packages) {
      for (const version of entry.versions) {
        components.push({
          type: "library",
          name: entry.name,
          version,
          purl: packageUrl(entry.name, version),
          licenses: licenseEntries(license),
        })
      }
    }
  }
  return components.sort(
    (left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
  )
}

function licenseEntries(license) {
  if (license === "Unknown") return []
  if (/[()]|\bOR\b|\bAND\b|\bWITH\b/.test(license)) return [{ expression: license }]
  return [{ license: { id: license } }]
}

// The packed all-platform lock is the inventory authority. Host-installed
// license observations may annotate an exact coordinate, never add or remove it.
// A protocol artifact gets only its closure in that reviewed graph. This is not
// a prediction of an unfrozen consumer install or an inventory of build tools.
export function lockedSbomComponents(lock, graph, { rootPath = "" } = {}) {
  validateRuntimeLock(lock, lock.packages[""], lock.version)
  if (!Object.hasOwn(lock.packages, rootPath)) throw new Error(`Missing SBOM root: ${rootPath}`)
  const licenses = new Map()
  for (const component of sbomComponents(graph)) {
    if (component.licenses.length === 0) continue
    const key = component.purl
    const previous = licenses.get(key)
    if (previous && JSON.stringify(previous) !== JSON.stringify(component.licenses)) {
      throw new Error(`Conflicting license observations for ${key}`)
    }
    licenses.set(key, component.licenses)
  }
  const paths = new Set()
  const pending = rootPath === "" ? Object.keys(lock.packages) : [rootPath]
  while (pending.length) {
    const path = pending.pop()
    if (paths.has(path)) continue
    paths.add(path)
    const entry = lock.packages[path]
    for (const field of ["dependencies", "optionalDependencies"]) {
      for (const name of Object.keys(entry[field] ?? {})) {
        pending.push(resolveRuntimeDependency(path, name, lock.packages))
      }
    }
  }
  paths.delete(rootPath)
  const components = new Map()
  for (const path of paths) {
    const { version, integrity } = lock.packages[path]
    const name = path.split("node_modules/").at(-1)
    const purl = packageUrl(name, version)
    const hashes = [{ alg: "SHA-512", content: Buffer.from(integrity.slice(7), "base64").toString("hex") }]
    const previous = components.get(purl)
    if (previous && previous.hashes[0].content !== hashes[0].content) throw new Error(`SBOM conflicting integrity for ${purl}`)
    components.set(purl, { type: "library", name, version, purl, hashes, licenses: licenses.get(purl) ?? [] })
  }
  return [...components.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

export function verifyProtocolArtifact(lock, manifest, integrity) {
  const expected = lock.packages[protocolPath]
  if (manifest.name !== "@getdomovoi/protocol" || manifest.version !== lock.version || expected?.version !== manifest.version) {
    throw new Error("Protocol artifact does not match the daemon release")
  }
  if (expected.integrity !== integrity) throw new Error("Protocol artifact bytes differ from the packed daemon runtime lock")
}

export function sbomDocument({ name, version, sha256, components, lockSha256 }) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      ...(lockSha256 ? { properties: [
        { name: "domovoi:sbom:inventory", value: "all-platform locked production graph; excludes external toolchains and unfrozen consumer installs" },
        { name: "domovoi:sbom:runtime-lock-sha256", value: lockSha256 },
        { name: "domovoi:sbom:licenses", value: "exact-version local observations; empty means unavailable or undeclared" },
      ] } : {}),
      component: {
        type: "library",
        name,
        version,
        purl: packageUrl(name, version),
        hashes: [{ alg: "SHA-256", content: sha256 }],
      },
    },
    components,
  }
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

export async function buildReleaseArtifacts(root = repositoryRoot, destination = join(root, "release"), { timeoutMs = 300_000 } = {}) {
  const deadline = bootstrapDeadline(timeoutMs, `Release artifacts exceeded ${timeoutMs} ms`)
  try {
    return await buildWithinDeadline(root, destination, deadline)
  } finally { deadline.clear() }
}

async function buildWithinDeadline(root, destination, deadline) {
  deadline.check()
  rmSync(destination, { force: true, recursive: true })
  mkdirSync(destination, { recursive: true })

  const artifacts = new Map()
  for (const selector of publishablePackages) {
    deadline.check()
    const staging = mkdtempSync(join(tmpdir(), "domovoi release-"))
    let archive
    try {
      const packed = await packPackage(selector, staging, { deadline })
      archive = join(destination, basename(packed))
      copyFileSync(packed, archive)
    } finally {
      rmSync(staging, { force: true, recursive: true })
    }

    const { manifest } = await inspectArchive(archive, { deadline })
    if (manifest.name !== selector) throw new Error(`Packed artifact identity differs from ${selector}`)
    artifacts.set(selector, { archive, manifest })
  }

  const daemon = artifacts.get("@getdomovoi/daemon")
  const protocol = artifacts.get("@getdomovoi/protocol")
  const lockBytes = await readArchiveEntry(daemon.archive, "package/runtime/lock.json", { deadline })
  const lock = JSON.parse(lockBytes)
  const runtimeManifest = JSON.parse(await readArchiveEntry(daemon.archive, "package/runtime/package.json", { deadline }))
  validateRuntimeLock(lock, runtimeManifest, daemon.manifest.version)
  verifyProtocolArtifact(lock, protocol.manifest, `sha512-${await hashRuntimeFile(protocol.archive, "sha512", deadline)}`)
  const graph = await collectDependencyLicenses(root, ["@getdomovoi/daemon"], { deadline })
  if (protocol.manifest.license) {
    const license = protocol.manifest.license
    graph[license] = [...(graph[license] ?? []), { name: protocol.manifest.name, versions: [protocol.manifest.version] }]
  }
  const lockSha256 = createHash("sha256").update(lockBytes).digest("hex")
  const checksums = []
  for (const { archive, manifest } of artifacts.values()) {
    deadline.check()
    const file = basename(archive)
    const sha256 = sha256File(archive)
    const document = sbomDocument({
      name: manifest.name,
      version: manifest.version,
      sha256,
      components: lockedSbomComponents(lock, graph, { rootPath: manifest.name === "@getdomovoi/protocol" ? protocolPath : "" }),
      lockSha256,
    })
    const sbomFile = file.replace(/\.tgz$/, ".sbom.json")

    validateCycloneDx(document)
    deadline.check()
    writeFileSync(join(destination, sbomFile), `${JSON.stringify(document, null, 2)}\n`)
    checksums.push({ file, sha256 }, { file: sbomFile, sha256: sha256File(join(destination, sbomFile)) })
  }

  deadline.check()
  writeFileSync(join(destination, "SHA256SUMS"), checksumManifest(checksums))
  return { destination, files: checksums.map((entry) => entry.file).sort() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await buildReleaseArtifacts()
  console.log(JSON.stringify(result, null, 2))
}
