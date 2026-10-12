import { createHash } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, dirname, join, posix, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { gzipSync } from "node:zlib"

import { bootstrapDeadline } from "./bootstrap-deadline.mjs"
import { validateCycloneDx } from "./cyclonedx-validation.mjs"
import { collectDependencyLicenses } from "./dependency-licenses.mjs"
import { inspectArchive, packPackage, readArchiveEntry } from "./pack-package.mjs"
import { resolveRuntimeDependency } from "./runtime-lock.mjs"
import { hashRuntimeFile, validateRuntimeLock } from "./runtime-verification.mjs"
import { publishablePackages } from "./release-packages.mjs"
import { buildWebApp } from "./renderer-bundle-packages.mjs"
import { collectWebNotices, renderThirdPartyNotices, webNoticeHeading } from "./third-party-notices.mjs"
import { collectWorkspacePackages } from "./version-lockstep.mjs"

export { publishDependencies, publishablePackages } from "./release-packages.mjs"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, "..")
const protocolPath = "node_modules/@getdomovoi/protocol"
// The daemon ships its runtime lock, and the protocol archive is verified to be
// the bytes that lock pins, so both take their inventory from it.
const runtimeLockRoots = { "@getdomovoi/daemon": "", "@getdomovoi/protocol": protocolPath }

// The built web app (S3.2, docs/plans/s3-2-web-over-tailnet.md slice 6): a
// release file the owner unpacks into the daemon's web folder, not an npm
// package.
export const webArchiveName = (version) => `domovoi-web-${version}.tar.gz`
export const webNoticesFile = "THIRD_PARTY_NOTICES.txt"
// webBundleManifestFileName in packages/protocol/src/web-bundle.ts.
const webBundleManifestFile = "domovoi-web.json"

// One time for every entry, 1980-01-01T00:00:00Z, so the same files give the
// same archive bytes.
const webArchiveTime = 315_532_800

function octalField(header, offset, length, value) {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii")
}

// ustar keeps a name in 100 bytes, or splits it at a "/" into a prefix of up
// to 155 bytes and a name of up to 100.
function ustarName(path) {
  if (Buffer.byteLength(path) <= 100) return { prefix: "", name: path }
  const end = path.endsWith("/") ? path.length - 1 : path.length
  for (let index = path.indexOf("/"); index !== -1 && index < end; index = path.indexOf("/", index + 1)) {
    const prefix = path.slice(0, index)
    const name = path.slice(index + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { prefix, name }
  }
  throw new Error(`The web app path ${path} is too long for a ustar header`)
}

function ustarHeader(path, size, directory) {
  const header = Buffer.alloc(512)
  const { prefix, name } = ustarName(path)
  header.write(name, 0, 100, "utf8")
  octalField(header, 100, 8, directory ? 0o755 : 0o644)
  octalField(header, 108, 8, 0)
  octalField(header, 116, 8, 0)
  octalField(header, 124, 12, size)
  octalField(header, 136, 12, webArchiveTime)
  header.fill(" ", 148, 156)
  header.write(directory ? "5" : "0", 156, 1, "ascii")
  header.write("ustar\0" + "00", 257, 8, "ascii")
  header.write(prefix, 345, 155, "utf8")
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii")
  return header
}

// A gzipped ustar archive of files, each { path, bytes } with a "/"-separated
// relative path, unpacked flat into the folder tar is given. Folders come
// before what they hold. Files are 0644 and folders 0755 with no owner name,
// so tar run by the owner gives the owner's files that only the owner can
// write, as the daemon's loader requires. Entries are sorted and carry one
// fixed time, and the gzip header no time or system, so the bytes depend on
// the files alone (and on the zlib that compresses them).
export function webArchive(files) {
  const entries = new Map()
  for (const { path, bytes } of files) {
    const parts = path.split("/")
    if (path.includes("\\") || path.includes("\0") || parts.some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`Unsafe web app path ${JSON.stringify(path)}`)
    }
    if (entries.has(path) || entries.has(`${path}/`)) throw new Error(`The web app path ${path} is listed twice`)
    for (let index = 1; index < parts.length; index += 1) {
      const folder = parts.slice(0, index).join("/")
      if (entries.has(folder)) throw new Error(`The web app path ${folder} is both a file and a folder`)
      entries.set(`${folder}/`, undefined)
    }
    entries.set(path, Buffer.from(bytes))
  }
  const blocks = []
  for (const path of [...entries.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))) {
    const bytes = entries.get(path)
    blocks.push(ustarHeader(path, bytes?.byteLength ?? 0, bytes === undefined))
    if (bytes === undefined) continue
    blocks.push(bytes, Buffer.alloc((512 - (bytes.byteLength % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  const archive = gzipSync(Buffer.concat(blocks), { level: 9 })
  // The gzip operating system byte differs by the zlib build; 255 is unknown.
  archive[9] = 255
  return archive
}

// vite compiles every VITE_ variable in its environment into the app, and the
// web app reads VITE_DOMOVOI_RPC_URL ahead of its own location, so a release
// built in a shell that sets one would dial that address from every daemon.
export function refuseWebBuildEnvironment(environment) {
  const names = Object.keys(environment).filter((name) => name.startsWith("VITE_")).sort()
  if (names.length) throw new Error(`Unset ${names.join(", ")} before building the release web app; vite would compile it into the bundle`)
}

// Every regular file under directory, by its "/"-joined relative path.
function bundleFiles(directory, prefix = "") {
  const files = []
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...bundleFiles(directory, relative))
    else if (entry.isFile()) files.push(relative)
    else throw new Error(`The web app build wrote ${relative}, which is not a regular file`)
  }
  return files
}

async function buildWebArchive(root, destination, version, deadline) {
  refuseWebBuildEnvironment(process.env)
  const staging = mkdtempSync(join(tmpdir(), "domovoi-web-"))
  try {
    const outDir = join(staging, "web")
    const envDir = join(staging, "env")
    mkdirSync(envDir)
    const bundled = await deadline.run(() => buildWebApp(root, { outDir, envDir }))
    const manifest = JSON.parse(readFileSync(join(outDir, webBundleManifestFile), "utf8"))
    if (manifest.version !== version) throw new Error(`The web app was built at ${manifest.version}, not the release version ${version}`)
    const files = bundleFiles(outDir).sort()
    const listed = [...Object.keys(manifest.files), webBundleManifestFile].sort()
    if (JSON.stringify(files) !== JSON.stringify(listed)) throw new Error(`The web app build holds files ${webBundleManifestFile} does not list, or lacks some it does`)
    if (files.includes(webNoticesFile)) throw new Error(`The web app build wrote its own ${webNoticesFile}`)
    const entries = await collectWebNotices(root, { deadline })
    const noticed = new Set(entries.map((entry) => entry.name))
    const missing = bundled.filter((name) => !noticed.has(name) && !name.startsWith("@getdomovoi/"))
    if (missing.length) throw new Error(`The web app bundles ${missing.join(", ")} with no notice`)
    deadline.check()
    const file = webArchiveName(version)
    writeFileSync(join(destination, file), webArchive([
      ...files.map((path) => ({ path, bytes: readFileSync(join(outDir, ...path.split("/"))) })),
      { path: webNoticesFile, bytes: Buffer.from(renderThirdPartyNotices(entries, webNoticeHeading)) },
    ]))
    return { file, sha256: sha256File(join(destination, file)) }
  } finally {
    rmSync(staging, { force: true, recursive: true })
  }
}

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
  const licenses = observedLicenses(graph)
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

function observedLicenses(graph) {
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
  return licenses
}

// A package with no runtime lock of its own, the CLI or the credential store,
// takes its inventory from pnpm-lock.yaml: the importer's production closure
// on every platform, following workspace links into the packed first-party
// archives. Like the runtime lock, this is the reviewed graph at release, not
// a prediction of an unfrozen consumer install or an inventory of build tools.
export function workspaceSbomComponents(lock, importerPath, graph, firstParty) {
  const refuse = (message) => { throw new Error(`pnpm lock: ${message}`) }
  if (String(lock?.lockfileVersion) !== "9.0") refuse("unsupported lockfile version")
  const licenses = observedLicenses(graph)
  const components = new Map()
  const add = (name, version, integrity) => {
    if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) refuse(`missing SHA512 integrity for ${name}@${version}`)
    const purl = packageUrl(name, version)
    const hashes = [{ alg: "SHA-512", content: Buffer.from(integrity.slice(7), "base64").toString("hex") }]
    const previous = components.get(purl)
    if (previous && previous.hashes[0].content !== hashes[0].content) refuse(`conflicting integrity for ${purl}`)
    components.set(purl, { type: "library", name, version, purl, hashes, licenses: licenses.get(purl) ?? [] })
  }
  const edges = (record, from) => ["dependencies", "optionalDependencies"].flatMap((field) =>
    Object.entries(record[field] ?? {}).map(([name, target]) => ({ name, reference: from ? target?.version : target, from })))
  const visited = new Set()
  const pending = [{ importer: importerPath }]
  while (pending.length) {
    const node = pending.pop()
    const key = node.importer === undefined ? `${node.name}@${node.reference}` : `importer ${node.importer}`
    if (visited.has(key)) continue
    visited.add(key)
    let children
    if (node.importer === undefined) {
      const version = node.reference.split("(", 1)[0]
      const metadata = lock.packages?.[`${node.name}@${version}`]
      const snapshot = lock.snapshots?.[key]
      if (!metadata || !snapshot) refuse(`missing graph node ${key}`)
      add(node.name, version, metadata.resolution?.integrity)
      children = edges(snapshot)
    } else {
      const record = lock.importers?.[node.importer]
      if (!record) refuse(`missing workspace importer ${node.importer}`)
      children = edges(record, node.importer)
    }
    for (const { name, reference, from } of children) {
      if (typeof reference !== "string") refuse(`unresolved dependency ${name}`)
      if (!reference.startsWith("link:")) { pending.push({ name, reference }); continue }
      if (from === undefined || !Object.hasOwn(firstParty, name)) refuse(`${name} is linked but is not a packed release archive`)
      add(name, firstParty[name].version, firstParty[name].integrity)
      pending.push({ importer: posix.join(from, reference.slice("link:".length)) })
    }
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

const inventories = {
  runtime: {
    description: "all-platform locked production graph; excludes external toolchains and unfrozen consumer installs",
    lockProperty: "domovoi:sbom:runtime-lock-sha256",
  },
  workspace: {
    description: "all-platform pnpm-lock.yaml production closure; excludes external toolchains and unfrozen consumer installs",
    lockProperty: "domovoi:sbom:pnpm-lock-sha256",
  },
}

export function sbomDocument({ name, version, sha256, components, lockSha256, inventory = "runtime" }) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      ...(lockSha256 ? { properties: [
        { name: "domovoi:sbom:inventory", value: inventories[inventory].description },
        { name: inventories[inventory].lockProperty, value: lockSha256 },
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
  const graph = await collectDependencyLicenses(root, publishablePackages, { deadline })
  const firstParty = {}
  for (const { archive, manifest } of artifacts.values()) {
    firstParty[manifest.name] = { version: manifest.version, integrity: `sha512-${await hashRuntimeFile(archive, "sha512", deadline)}` }
    if (!manifest.license) continue
    graph[manifest.license] = [...(graph[manifest.license] ?? []), { name: manifest.name, versions: [manifest.version] }]
  }
  const lockSha256 = createHash("sha256").update(lockBytes).digest("hex")
  const workspaceLockBytes = readFileSync(join(root, "pnpm-lock.yaml"), "utf8")
  // yaml is already a daemon dependency, as in prepare-daemon-runtime.mjs.
  const { parse: parseYaml } = createRequire(join(root, "apps/daemon/package.json"))("yaml")
  const workspaceLock = parseYaml(workspaceLockBytes)
  const workspaceLockSha256 = createHash("sha256").update(workspaceLockBytes).digest("hex")
  const { packages: workspacePackages } = await deadline.run(() => collectWorkspacePackages(root))
  const checksums = []
  for (const { archive, manifest } of artifacts.values()) {
    deadline.check()
    const file = basename(archive)
    const sha256 = sha256File(archive)
    const runtimeRoot = runtimeLockRoots[manifest.name]
    const importer = workspacePackages.find((entry) => entry.name === manifest.name)?.path
    if (runtimeRoot === undefined && importer === undefined) throw new Error(`${manifest.name} is not a workspace package`)
    const document = sbomDocument({
      name: manifest.name,
      version: manifest.version,
      sha256,
      ...(runtimeRoot === undefined
        ? { components: workspaceSbomComponents(workspaceLock, posix.dirname(importer), graph, firstParty), lockSha256: workspaceLockSha256, inventory: "workspace" }
        : { components: lockedSbomComponents(lock, graph, { rootPath: runtimeRoot }), lockSha256 }),
    })
    const sbomFile = file.replace(/\.tgz$/, ".sbom.json")

    validateCycloneDx(document)
    deadline.check()
    writeFileSync(join(destination, sbomFile), `${JSON.stringify(document, null, 2)}\n`)
    checksums.push({ file, sha256 }, { file: sbomFile, sha256: sha256File(join(destination, sbomFile)) })
  }

  checksums.push(await buildWebArchive(root, destination, daemon.manifest.version, deadline))
  deadline.check()
  writeFileSync(join(destination, "SHA256SUMS"), checksumManifest(checksums))
  return { destination, files: checksums.map((entry) => entry.file).sort() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await buildReleaseArtifacts()
  console.log(JSON.stringify(result, null, 2))
}
