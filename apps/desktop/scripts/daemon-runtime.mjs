// The daemon runtime the desktop ships beside itself (J24, 2026-09-23): one
// pinned Node program and the daemon with its production dependencies, laid
// out under daemon-runtime/<platform>-<arch>/ so electron-builder can copy the
// host's pair into the app's resources. The app copies that directory under
// the profile when it installs the login service, so the service never points
// into the app bundle. Node is verified against its published sha256 before it
// is unpacked; the daemon is proved runnable by asking it for its version.
import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { pipeline } from "node:stream/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

export const nodeVersion = "24.21.0"
export const nodeDistribution = `https://nodejs.org/dist/v${nodeVersion}/`

// Published in https://nodejs.org/dist/v24.21.0/SHASUMS256.txt, read 2026-09-23.
export const nodePins = {
  "darwin-arm64": { archive: `node-v${nodeVersion}-darwin-arm64.tar.gz`, sha256: "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057" },
  "darwin-x64": { archive: `node-v${nodeVersion}-darwin-x64.tar.gz`, sha256: "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097" },
  "linux-x64": { archive: `node-v${nodeVersion}-linux-x64.tar.xz`, sha256: "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6" },
  "linux-arm64": { archive: `node-v${nodeVersion}-linux-arm64.tar.xz`, sha256: "6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2" },
  "win32-x64": { archive: `node-v${nodeVersion}-win-x64.zip`, sha256: "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541" },
  "win32-arm64": { archive: `node-v${nodeVersion}-win-arm64.zip`, sha256: "8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921" },
}

export const maximumArchiveBytes = 128 * 1024 * 1024
const execute = promisify(execFile)

export function runtimeTarget(platform, arch) {
  const key = `${platform}-${arch}`
  if (!(key in nodePins)) throw new Error(`No Node ${nodeVersion} build is pinned for ${key}`)
  return { key, ...nodePins[key], nodeExecutable: platform === "win32" ? "node.exe" : "bin/node" }
}

export async function sha256Of(path) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

// Downloads the archive once into the cache, refusing to keep bytes whose
// digest is not the pinned one. A cached file is re-verified every time.
export async function fetchNodeArchive({ target, cacheDirectory, download }) {
  await mkdir(cacheDirectory, { recursive: true })
  const cached = join(cacheDirectory, target.archive)
  if (!(await exists(cached))) {
    const staging = `${cached}.part`
    // A finished download that was never renamed (an interrupted run) is
    // kept only if its digest is the pinned one.
    if (!(await exists(staging)) || (await sha256Of(staging)) !== target.sha256) {
      await rm(staging, { force: true })
      await download(new URL(target.archive, nodeDistribution).href, staging)
    }
    const digest = await sha256Of(staging)
    if (digest !== target.sha256) {
      await rm(staging, { force: true })
      throw new Error(`${target.archive} downloaded with sha256 ${digest}, pinned ${target.sha256}. Nothing was unpacked.`)
    }
    await rename(staging, cached)
  }
  const digest = await sha256Of(cached)
  if (digest !== target.sha256) throw new Error(`${cached} has sha256 ${digest}, pinned ${target.sha256}. Delete it and run again.`)
  return cached
}

export async function downloadOverHttps(url, destination) {
  const response = await fetch(url, { redirect: "follow" })
  if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}`)
  const length = Number(response.headers.get("content-length") ?? 0)
  if (length > maximumArchiveBytes) throw new Error(`${url} is ${length} bytes, above the ${maximumArchiveBytes} byte limit`)
  let received = 0
  await pipeline(response.body, async function* (source) {
    for await (const chunk of source) {
      received += chunk.byteLength
      if (received > maximumArchiveBytes) throw new Error(`${url} exceeded the ${maximumArchiveBytes} byte limit`)
      yield chunk
    }
  }, createWriteStream(destination))
}

// tar reads .tar.gz, .tar.xz and .zip alike on macOS, Linux and Windows 10+.
export async function unpackNode({ archive, target, destination, run = execute }) {
  const staging = await mkdtemp(join(tmpdir(), "domovoi-node-"))
  try {
    await run("tar", ["-xf", archive, "-C", staging])
    const [top] = await readdir(staging)
    if (!top) throw new Error(`${archive} unpacked to nothing`)
    await rm(destination, { recursive: true, force: true })
    await mkdir(resolve(destination, ".."), { recursive: true })
    await rename(join(staging, top), destination)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  const executable = join(destination, target.nodeExecutable)
  if (!(await exists(executable))) throw new Error(`${archive} holds no ${target.nodeExecutable}`)
  // Only the program ships. npm, corepack, headers and docs are most of the
  // archive and the service never runs them.
  for (const entry of await readdir(destination)) {
    const keep = entry === "LICENSE" || (target.nodeExecutable === "node.exe" ? entry === "node.exe" : entry === "bin")
    if (!keep) await rm(join(destination, entry), { recursive: true, force: true })
  }
  if (target.nodeExecutable !== "node.exe") {
    for (const entry of await readdir(join(destination, "bin"))) {
      if (entry !== "node") await rm(join(destination, "bin", entry), { recursive: true, force: true })
    }
  }
  return executable
}

// The vendor's agent binary is not shipped; the daemon runs the person's own
// installed claude. electron-builder excludes the same packages from the app.
const excludedDependency = /^@anthropic-ai\+claude-agent-sdk-[^@]+@|^claude-agent-sdk-/

export async function deployDaemon({ repositoryRoot, destination, run = execute }) {
  await rm(destination, { recursive: true, force: true })
  // Hoisted: a flat node_modules with real directories and no store links, so
  // the copy under the profile and the packaged copy are the same files with
  // nothing to resolve back into the repository or the app bundle.
  await run("pnpm", ["--filter", "@getdomovoi/daemon", "deploy", "--legacy", "--prod", "--config.node-linker=hoisted", destination], { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024 })
  const store = join(destination, "node_modules", ".pnpm")
  for (const entry of await readdir(store).catch(() => [])) {
    if (excludedDependency.test(entry)) await rm(join(store, entry), { recursive: true, force: true })
  }
  const scoped = join(destination, "node_modules", "@anthropic-ai")
  // Hoisted layout: the vendor's per-platform agent packages sit here.
  for (const entry of await readdir(scoped).catch(() => [])) {
    if (excludedDependency.test(entry)) await rm(join(scoped, entry), { recursive: true, force: true })
  }
  // pnpm reaches the removed packages through links elsewhere in the store;
  // a link with nothing behind it stops electron-builder's copy.
  await removeDanglingLinks(join(destination, "node_modules"))
  // pnpm also links the package to its source in the repository from inside
  // the store. Nothing in the shipped tree may point outside it: the copy
  // would carry a link to a path that does not exist on the person's machine.
  await removeExternalLinks(join(destination, "node_modules"), destination)
  return join(destination, "dist", "index.js")
}

export async function removeExternalLinks(path, root) {
  const { realpath } = await import("node:fs/promises")
  const inside = `${await realpath(root)}${sep}`
  let removed = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) {
      const target = await realpath(child).catch(() => undefined)
      if (target === undefined || !target.startsWith(inside)) { await rm(child, { force: true }); removed += 1 }
    } else if (entry.isDirectory()) {
      removed += await removeExternalLinks(child, root)
    }
  }
  return removed
}

export async function removeDanglingLinks(path) {
  let removed = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) {
      if (!(await exists(child))) { await rm(child, { force: true }); removed += 1 }
    } else if (entry.isDirectory()) {
      removed += await removeDanglingLinks(child)
    }
  }
  return removed
}

// What the runtime never loads on the platform being packaged: types, source
// maps, TypeScript and markdown sources, node-pty's build inputs and the
// prebuilds for other platforms, and the package-manager shims. node-pty
// loads prebuilds/<platform>-<arch> (lib/utils.js); Windows also needs its
// third_party conpty files. Licences stay.
const neverLoaded = /\.(d\.ts|d\.mts|d\.cts|map|ts|tsx|mts|cts|md|markdown)$/i

export async function pruneDaemonRuntime(root, { platform, arch }) {
  const removed = { files: 0, bytes: 0 }
  const drop = async (path) => {
    let entry
    try { entry = await lstat(path) } catch { return }
    removed.bytes += entry.isDirectory() ? await directoryBytes(path) : entry.size
    removed.files += 1
    await rm(path, { recursive: true, force: true })
  }
  const nodePty = join(root, "node_modules", "node-pty")
  for (const entry of await readdir(join(nodePty, "prebuilds")).catch(() => [])) {
    if (entry !== `${platform}-${arch}`) await drop(join(nodePty, "prebuilds", entry))
  }
  for (const entry of ["src", "scripts", "typings", "binding.gyp", ...(platform === "win32" ? [] : ["third_party"])]) await drop(join(nodePty, entry))
  await drop(join(root, "node_modules", ".bin"))
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (neverLoaded.test(entry.name) && !/^(licen[cs]e|notice|copying)/i.test(entry.name)) await drop(path)
    }
  }
  await walk(root)
  return removed
}

// The installer cannot prove the entry's imports resolve; running it can.
export async function proveDaemonRuns({ nodeExecutable, daemonEntry, expectedVersion, run = execute }) {
  const { stdout } = await run(nodeExecutable, [daemonEntry, "--version"], { timeout: 30_000 })
  const printed = String(stdout).trim()
  if (printed !== expectedVersion) throw new Error(`${daemonEntry} printed version ${JSON.stringify(printed)}, expected ${expectedVersion}`)
  return printed
}

// Bytes on disk, links counted once as links: pnpm's store is reached through
// symlinks, and following them would count every package several times.
export async function directoryBytes(path) {
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) total += await directoryBytes(child)
    else if (entry.isFile()) total += (await lstat(child)).size
  }
  return total
}

export async function prepareDaemonRuntime({
  platform = process.platform, arch = process.arch,
  desktopRoot, repositoryRoot = resolve(desktopRoot, "../.."),
  download = downloadOverHttps, run = execute, log = (text) => process.stdout.write(`${text}\n`),
}) {
  const target = runtimeTarget(platform, arch)
  const output = join(desktopRoot, "daemon-runtime", target.key)
  const archive = await fetchNodeArchive({ target, cacheDirectory: join(desktopRoot, ".cache", "node"), download })
  const nodeExecutable = await unpackNode({ archive, target, destination: join(output, "node"), run })
  const daemonEntry = await deployDaemon({ repositoryRoot, destination: join(output, "daemon"), run })
  const pruned = await pruneDaemonRuntime(join(output, "daemon"), { platform, arch })
  log(`pruned ${pruned.files} entries, ${(pruned.bytes / 1048576).toFixed(1)} MB, the runtime never loads on ${target.key}`)
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "apps/daemon/package.json"), "utf8"))
  const host = platform === process.platform && arch === process.arch
  if (host) {
    await proveDaemonRuns({ nodeExecutable, daemonEntry, expectedVersion: manifest.version, run })
    log(`${daemonEntry} --version printed ${manifest.version} under ${nodeExecutable}`)
  } else {
    log(`${target.key} is not this host, so ${daemonEntry} was not run; the packaging job on that platform proves it`)
  }
  const nodeBytes = await directoryBytes(join(output, "node"))
  const daemonBytes = await directoryBytes(join(output, "daemon"))
  log(`daemon-runtime/${target.key}: node ${(nodeBytes / 1048576).toFixed(1)} MB, daemon ${(daemonBytes / 1048576).toFixed(1)} MB`)
  return { output, nodeExecutable, daemonEntry, nodeBytes, daemonBytes }
}
