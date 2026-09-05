import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import { join, sep } from "node:path"
import { isDeepStrictEqual } from "node:util"

import { resolveRuntimeDependency } from "./runtime-lock.mjs"

const maximumLockBytes = 8 * 1024 * 1024
const maximumPackages = 10_000
const packageName = "(?:@[a-z0-9._-]+/)?[a-z0-9._-]+"
const packagePath = new RegExp(`^node_modules/${packageName}(?:/node_modules/${packageName})*$`)
const integrity = /^sha512-[A-Za-z0-9+/]{86}==$/
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export async function readRuntimeJson(path, deadline, maximumBytes = maximumLockBytes) {
  const info = await deadline.run(() => lstat(path))
  if (!info.isFile() || info.size > maximumBytes) throw new Error(`Runtime metadata is not a bounded regular file: ${path}`)
  return JSON.parse(await deadline.run(() => readFile(path, { encoding: "utf8", signal: deadline.signal })))
}

export async function hashRuntimeFile(path, algorithm, deadline, maximumBytes = 32 * 1024 * 1024) {
  const info = await deadline.run(() => lstat(path))
  if (!info.isFile() || info.size > maximumBytes) throw new Error(`Runtime input is not a bounded regular file: ${path}`)
  deadline.check()
  const stream = createReadStream(path, { signal: deadline.signal, highWaterMark: 64 * 1024 })
  const hash = createHash(algorithm)
  let count = 0
  try {
    const iterator = stream[Symbol.asyncIterator]()
    for (;;) {
      const { value, done } = await deadline.run(() => iterator.next())
      if (done) break
      count += value.length
      if (count > maximumBytes) throw new Error(`Runtime input grew beyond its limit: ${path}`)
      hash.update(value)
    }
  } finally { stream.destroy() }
  deadline.check()
  return hash.digest(algorithm === "sha512" ? "base64" : "hex")
}

export function validateRuntimeLock(lock, manifest, version) {
  const fail = (message) => { throw new Error(`Invalid runtime lock: ${message}`) }
  if (lock?.lockfileVersion !== 3 || lock.name !== "@getdomovoi/daemon" || lock.version !== version ||
      !lock.packages || !isDeepStrictEqual(lock.packages[""], manifest) || manifest?.version !== version ||
      manifest.name !== lock.name || manifest.private !== true || manifest.devDependencies || manifest.scripts || manifest.peerDependencies) {
    fail("release manifest does not match its production lock")
  }
  if (Object.keys(lock.packages).length > maximumPackages) fail("too many packages")
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === "") continue
    if (!packagePath.test(path) || path.split("/").some((part) => part === "." || part === "..") ||
        !versionPattern.test(entry.version) || !integrity.test(entry.integrity) || entry.link) fail(`unlocked package ${path}`)
    if (path === "node_modules/@getdomovoi/protocol") {
      if (entry.version !== version || entry.resolved !== "file:runtime/protocol.tgz") fail("protocol must be bound to this release")
    } else {
      const source = new URL(entry.resolved)
      if (source.origin !== "https://registry.npmjs.org" || source.username || source.password || source.search || source.hash) {
        fail(`unsupported dependency source for ${path}`)
      }
    }
  }
  if (!lock.packages["node_modules/@getdomovoi/protocol"]) fail("missing same-release protocol")
  for (const [path, entry] of Object.entries(lock.packages)) {
    for (const field of ["dependencies", "optionalDependencies"]) {
      for (const name of Object.keys(entry[field] ?? {})) {
        if (!resolveRuntimeDependency(path, name, lock.packages)) fail(`missing edge ${path} -> ${name}`)
      }
    }
  }
}

function matches(values, actual) {
  if (!values) return true
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) throw new Error("Invalid runtime platform constraint")
  return !values.includes(`!${actual}`) && (values.every((value) => value.startsWith("!")) || values.includes(actual) || values.includes("any"))
}

export function runtimePlatform() {
  return { os: process.platform, cpu: process.arch,
    libc: process.platform === "linux" ? (process.report.getReport().header.glibcVersionRuntime ? "glibc" : "musl") : undefined }
}

export async function verifyInstalledRuntime(directory, lock, deadline, platform = runtimePlatform()) {
  const manifest = await readRuntimeJson(join(directory, "package.json"), deadline)
  if (!isDeepStrictEqual(manifest, lock.packages[""])) throw new Error("Installed root manifest differs from the runtime lock")
  const actualRoot = await deadline.run(() => realpath(directory))
  const found = new Set()
  async function inventory(modules) {
    let children
    try {
      if (!(await deadline.run(() => lstat(join(directory, modules)))).isDirectory()) throw new Error(`Runtime module directory is not a regular directory: ${modules}`)
      children = await deadline.run(() => readdir(join(directory, modules), { withFileTypes: true }))
    }
    catch (error) { if (error.code === "ENOENT") return; throw error }
    const names = []
    for (const child of children) {
      if (child.name.startsWith(".")) continue
      if (child.name.startsWith("@")) {
        if (!child.isDirectory()) throw new Error(`Runtime scope is not a directory: ${modules}/${child.name}`)
        for (const scoped of await deadline.run(() => readdir(join(directory, modules, child.name)))) names.push(`${child.name}/${scoped}`)
      } else names.push(child.name)
    }
    for (const name of names) {
      const path = `${modules}/${name}`
      if (found.size >= maximumPackages || !Object.hasOwn(lock.packages, path)) throw new Error(`Unrecorded installed runtime package: ${path}`)
      const info = await deadline.run(() => lstat(join(directory, path)))
      const real = await deadline.run(() => realpath(join(directory, path)))
      if (!info.isDirectory() || !real.startsWith(`${actualRoot}${sep}`)) throw new Error(`Runtime package escaped staging: ${path}`)
      found.add(path)
      const expected = lock.packages[path]
      const actual = await readRuntimeJson(join(directory, path, "package.json"), deadline, 1024 * 1024)
      if (actual.name !== name || actual.version !== expected.version) {
        throw new Error(`Runtime drift at ${path}: expected ${name}@${expected.version}, found ${actual.name}@${actual.version}`)
      }
      if (name !== "node-pty" && ["preinstall", "install", "postinstall"].some((hook) => actual.scripts?.[hook])) {
        throw new Error(`Runtime lifecycle hooks need an explicit bootstrap build policy: ${path}`)
      }
      await inventory(`${path}/node_modules`)
    }
  }
  await inventory("node_modules")
  // npm's installed lock binds fetched integrity to physical locations. Version
  // strings alone would not establish that npm used the reviewed tarball hashes.
  const installed = await readRuntimeJson(join(directory, "node_modules/.package-lock.json"), deadline)
  for (const path of found) {
    const expected = lock.packages[path]
    const fetched = installed.packages?.[path]
    if (fetched?.version !== expected.version || fetched.integrity !== expected.integrity) {
      throw new Error(`Installed integrity record differs from the runtime lock: ${path}`)
    }
  }
  const needed = new Set([""])
  const visit = (path) => {
    for (const field of ["dependencies", "optionalDependencies"]) {
      for (const name of Object.keys(lock.packages[path][field] ?? {})) {
        const target = resolveRuntimeDependency(path, name, lock.packages)
        const expected = lock.packages[target]
        const compatible = matches(expected.os, platform.os) && matches(expected.cpu, platform.cpu) && matches(expected.libc, platform.libc)
        if (field === "optionalDependencies" && !compatible) continue
        if (!found.has(target)) throw new Error(`Missing required runtime package ${target}@${expected.version}`)
        if (!needed.has(target)) { needed.add(target); visit(target) }
      }
    }
  }
  visit("")
  // Every real dependency edge must still resolve to the locked location, even
  // when a skipped optional ancestor would otherwise fall through to a parent.
  const installedPaths = Object.fromEntries([...found].map((key) => [key, true]))
  for (const path of ["", ...found]) {
    for (const field of ["dependencies", "optionalDependencies"]) {
      for (const name of Object.keys(lock.packages[path][field] ?? {})) {
        const expected = resolveRuntimeDependency(path, name, lock.packages)
        if (field === "optionalDependencies" && !found.has(expected)) continue
        const actual = resolveRuntimeDependency(path, name, installedPaths)
        if (actual !== expected) throw new Error(`Runtime dependency resolution drift: ${path} -> ${name}`)
      }
    }
  }
  return found.size
}
