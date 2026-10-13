import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { isDeepStrictEqual } from "node:util"

import { bootstrapDeadline } from "./bootstrap-deadline.mjs"
import { bootstrapPlan, expectedChecksum } from "./bootstrap-plan.mjs"
import { publishablePackages, webArchiveName } from "./release-artifacts.mjs"
import { verifyReleaseReproducibility } from "./release-reproducibility.mjs"
import { evaluatePublishOrder } from "./publish-order.mjs"
import { hashRuntimeFile } from "./runtime-verification.mjs"
import { collectWorkspacePackages, evaluateVersionLockstep } from "./version-lockstep.mjs"

const readJson = async (file, deadline) => JSON.parse(await deadline.run(() => readFile(file, "utf8")))
export const archiveStem = (name, version) => `${name.slice(1).replace("/", "-")}-${version}`

async function describeRelease(root, directory, commit, deadline) {
  if (!/^[a-f0-9]{40}$/u.test(commit ?? "")) throw new Error("Release identity needs the exact source commit SHA")
  const workspace = await deadline.run(() => collectWorkspacePackages(root))
  const failures = [...workspace.failures, ...evaluateVersionLockstep(workspace.packages)]
  if (failures.length) throw new Error(failures.join("; "))
  const version = workspace.packages[0].version
  bootstrapPlan({ version, baseUrl: "https://github.com/getdomovoi/domovoi/releases/download" })
  if (version.startsWith("0.0.")) throw new Error("Version the first alpha before preparing a public release")
  const prerelease = version.split("+")[0].split("-").slice(1).join("-")
  const npmTag = prerelease ? prerelease.split(".")[0] : "latest"
  if (!/^[a-z][a-z0-9-]*$/u.test(npmTag)) throw new Error("Release prerelease identifier must name an npm channel")
  const sums = await deadline.run(() => readFile(join(directory, "SHA256SUMS"), "utf8"))
  const files = []
  const packages = []
  for (const name of publishablePackages) {
    const pkg = workspace.packages.find((entry) => entry.name === name)
    if (!pkg) throw new Error(`Missing release package ${name}`)
    const manifest = await readJson(join(root, pkg.path), deadline)
    if (manifest.private || manifest.publishConfig?.access !== "public" || manifest.publishConfig?.provenance !== true) {
      throw new Error(`${name} must publish publicly with provenance`)
    }
    const stem = archiveStem(name, version)
    const archive = `${stem}.tgz`
    const sbom = `${stem}.sbom.json`
    for (const file of [archive, sbom]) {
      const path = join(directory, file)
      if (!(await deadline.run(() => lstat(path))).isFile()) throw new Error(`${file} is not a regular release file`)
      const sha256 = await hashRuntimeFile(path, "sha256", deadline)
      if (expectedChecksum(sums, file) !== sha256) throw new Error(`${file} does not match SHA256SUMS`)
      files.push({ name: file, sha256 })
    }
    const document = await readJson(join(directory, sbom), deadline)
    if (document.metadata?.component?.name !== name || document.metadata?.component?.version !== version) {
      throw new Error(`${sbom} describes a different release package`)
    }
    packages.push({ name, version, archive, sbom, directory: dirname(pkg.path),
      integrity: `sha512-${await hashRuntimeFile(join(directory, archive), "sha512", deadline)}` })
  }
  // The web app is a release file, not an npm package: it is checked and
  // uploaded with the rest, and never enters the publish plan.
  const web = webArchiveName(version)
  const webPath = join(directory, web)
  if (!(await deadline.run(() => lstat(webPath))).isFile()) throw new Error(`${web} is not a regular release file`)
  const webSha256 = await hashRuntimeFile(webPath, "sha256", deadline)
  if (expectedChecksum(sums, web) !== webSha256) throw new Error(`${web} does not match SHA256SUMS`)
  files.push({ name: web, sha256: webSha256 })
  if (sums.trim().split(/\r?\n/u).length !== files.length) throw new Error("SHA256SUMS must name exactly this release's archives, SBOMs and web app")
  files.push({ name: "SHA256SUMS", sha256: await hashRuntimeFile(join(directory, "SHA256SUMS"), "sha256", deadline) })
  await verifyReleaseReproducibility({ root, directory, commit, version, deadline })
  files.push({ name: "reproducibility.json", sha256: await hashRuntimeFile(join(directory, "reproducibility.json"), "sha256", deadline) })
  return { schemaVersion: 1, commit, version, gitTag: `v${version}`, prerelease: Boolean(prerelease), npmTag, packages, files }
}

function packedPlan(raw, release) {
  if (raw?.version !== 1 || !Array.isArray(raw.plan) || raw.plan.some((chunk) => !Array.isArray(chunk))) {
    throw new Error("Invalid Changesets publish plan")
  }
  const failures = raw.plan.length ? evaluatePublishOrder(raw.plan) : []
  if (failures.length) throw new Error(failures.join("; "))
  const seen = new Set()
  const plan = raw.plan.map((chunk) => chunk.map((entry) => {
    const pkg = release.packages.find((item) => item.name === entry.name)
    if (entry.kind !== "publish" || !pkg || seen.has(entry.name)) throw new Error("Publish plan names an unexpected or duplicate package")
    if (entry.version !== release.version || entry.access !== "public") throw new Error("Publish plan must use the reviewed version and public access")
    seen.add(entry.name)
    const file = release.files.find((item) => item.name === pkg.archive)
    return { kind: "publish", name: pkg.name, version: pkg.version, access: "public", tag: release.npmTag,
      tarball: { path: `packages/${pkg.archive}`, integrity: `sha256-${Buffer.from(file.sha256, "hex").toString("base64")}` } }
  }))
  return { version: 1, plan }
}

async function withReleaseDeadline(timeoutMs, operation) {
  const deadline = bootstrapDeadline(timeoutMs, `Release artifact validation exceeded ${timeoutMs} ms`)
  try { return await deadline.run(() => operation(deadline)) }
  finally { deadline.clear() }
}

// release:artifacts is the only packer. Changesets' workspace packer runs
// prepack hooks concurrently, but daemon prepack itself repacks the protocol.
// Copy the verified archives into Changesets' artifact format instead. No
// build, package hook, registry write, tag or release creation happens here.
export async function prepareRelease({ root = process.cwd(), directory = join(root, "release"), commit = process.env.GITHUB_SHA, timeoutMs = 60_000 } = {}) {
  return withReleaseDeadline(timeoutMs, async (deadline) => {
    const release = await describeRelease(root, directory, commit, deadline)
    const plan = packedPlan(await readJson(join(directory, "publish-plan.json"), deadline), release)
    const pack = join(directory, "pack")
    await deadline.run(() => mkdir(join(pack, "packages"), { recursive: true }))
    for (const entry of plan.plan.flat()) {
      const archive = release.packages.find((pkg) => pkg.name === entry.name).archive
      await deadline.run(() => copyFile(join(directory, archive), join(pack, "packages", archive)))
    }
    await deadline.run(() => writeFile(join(pack, "publish-plan.json"), `${JSON.stringify(plan, null, 2)}\n`))
    await deadline.run(() => writeFile(join(directory, "release.json"), `${JSON.stringify(release, null, 2)}\n`))
    return release
  })
}

export async function verifyRelease({ root = process.cwd(), directory = join(root, "release"), commit = process.env.GITHUB_SHA, timeoutMs = 60_000 } = {}) {
  return withReleaseDeadline(timeoutMs, async (deadline) => {
    const release = await describeRelease(root, directory, commit, deadline)
    if (!isDeepStrictEqual(await readJson(join(directory, "release.json"), deadline), release)) {
      throw new Error("Release identity or artifact checksums changed after packing")
    }
    const expected = packedPlan(await readJson(join(directory, "publish-plan.json"), deadline), release)
    const pack = join(directory, "pack")
    if (!isDeepStrictEqual(await readJson(join(pack, "publish-plan.json"), deadline), expected)) {
      throw new Error("Publish plan changed after packing")
    }
    for (const entry of expected.plan.flat()) {
      const digest = await hashRuntimeFile(join(pack, entry.tarball.path), "sha256", deadline)
      if (`sha256-${Buffer.from(digest, "hex").toString("base64")}` !== entry.tarball.integrity) {
        throw new Error(`Packed archive checksum changed for ${entry.name}`)
      }
    }
    return release
  })
}

// Candidate preparation is deliberately separate from prepare/verify and their
// live publishing CLI. No candidate, receipt or caller boolean grants trust.
export async function prepareDistributionInventory({ root = process.cwd(), directory = join(root, "release"),
  commit, channel, preparedDmgs = [], stagingDirectory, timeoutMs = 60_000 } = {}) {
  if (typeof stagingDirectory !== "string" || !stagingDirectory || !Array.isArray(preparedDmgs) || preparedDmgs.length > 2) {
    throw new Error("Distribution needs a new explicit staging directory and at most two prepared DMGs")
  }
  return withReleaseDeadline(timeoutMs, async (deadline) => {
    const { releaseInventorySchema } = await import("../packages/protocol/dist/index.js")
    const release = await deadline.run(() => verifyRelease({ root, directory, commit, timeoutMs }))
    const files = []
    const sources = new Map()
    const inspect = async (path) => {
      const stat = await deadline.run(() => lstat(path))
      // This is a preparation resource cap, not a native packaging assertion.
      if (!stat.isFile() || stat.size < 1 || stat.size > 2_147_483_648) throw new Error("Distribution artifact is not a bounded regular file")
      return { length: stat.size, sha256: await hashRuntimeFile(path, "sha256", deadline, 2_147_483_648) }
    }
    for (const file of release.files) {
      const path = join(directory, file.name)
      const identity = await inspect(path)
      if (identity.sha256 !== file.sha256) throw new Error("Core artifact changed during distribution preparation")
      const pkg = release.packages.find((entry) => entry.archive === file.name || entry.sbom === file.name)
      const kind = pkg ? (pkg.archive === file.name ? "npm" : "sbom")
        : file.name === "SHA256SUMS" ? "checksums" : file.name === "reproducibility.json" ? "reproducibility" : "web"
      files.push({ name: file.name, ...identity, kind, ...(pkg ? { packageName: pkg.name } : {}) })
      sources.set(file.name, path)
    }
    for (const input of preparedDmgs) {
      if (!input || typeof input !== "object" || typeof input.path !== "string"
        || input.version !== release.version || input.sourceCommit !== commit || basename(input.path) !== input.name) {
        throw new Error("Prepared DMG identity does not match this release")
      }
      const { path, version: _version, sourceCommit: _commit, ...file } = input
      const identity = await inspect(path)
      if (identity.length !== file.length || identity.sha256 !== file.sha256) throw new Error("Prepared DMG bytes do not match their identity")
      files.push(file)
      sources.set(file.name, path)
    }
    const inventory = releaseInventorySchema.parse({ schemaVersion: 2, version: release.version,
      channel, commit, gitTag: release.gitTag, files })
    const staging = resolve(stagingDirectory)
    await deadline.run(() => mkdir(staging, { mode: 0o700 }))
    // On failure retain this owned directory for inspection. An uncancellable
    // copy may finish after a deadline; deleting its destination would race it.
    for (const file of inventory.files) {
      const destination = join(staging, file.name)
      await deadline.run(() => copyFile(sources.get(file.name), destination, constants.COPYFILE_EXCL))
      const identity = await inspect(destination)
      if (identity.length !== file.length || identity.sha256 !== file.sha256) throw new Error("Staged distribution bytes changed during copying")
    }
    await deadline.run(() => writeFile(join(staging, "release.json"), `${JSON.stringify(inventory, null, 2)}\n`,
      { flag: "wx", mode: 0o600, signal: deadline.signal }))
    return inventory
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const operation = process.argv[2] === "verify" ? verifyRelease : process.argv[2] === "prepare" ? prepareRelease : undefined
    if (!operation) throw new Error("usage: node scripts/release-plan.mjs <prepare|verify>")
    console.log(JSON.stringify(await operation(), null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
