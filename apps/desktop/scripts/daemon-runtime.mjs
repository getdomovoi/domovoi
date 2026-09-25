// The daemon runtime the desktop ships beside itself (J24, 2026-09-23): one
// pinned Node program and the daemon with its production dependencies, laid
// out under daemon-runtime/<platform>-<arch>/ so electron-builder can copy the
// host's pair into the app's resources. The app copies that directory under
// the profile when it installs the login service, so the service never points
// into the app bundle. Node is verified against its published sha256 before it
// is unpacked, and the program kept is the one unpacked from that archive; the
// daemon is proved runnable by asking it for its version and by loading its
// entry under that program.
import { createHash, randomBytes } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
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
// digest is not the pinned one. A cached file is re-verified every time, and
// removed when it fails, so a poisoned cache cannot refuse every later run.
export async function fetchNodeArchive({ target, cacheDirectory, download }) {
  await mkdir(cacheDirectory, { recursive: true })
  const cached = join(cacheDirectory, target.archive)
  if (!(await exists(cached))) {
    const staging = `${cached}.part`
    // A finished download that was never renamed (an interrupted run) is
    // kept only if its digest is the pinned one.
    if (!(await exists(staging)) || (await sha256Of(staging)) !== target.sha256) {
      await rm(staging, { force: true })
      try {
        await download(new URL(target.archive, nodeDistribution).href, staging)
      } catch (error) {
        // Bytes from a failed download were never verified; none stay cached.
        await rm(staging, { force: true })
        throw error
      }
    }
    const digest = await sha256Of(staging)
    if (digest !== target.sha256) {
      await rm(staging, { force: true })
      throw new Error(`${target.archive} downloaded with sha256 ${digest}, pinned ${target.sha256}. Nothing was unpacked.`)
    }
    await rename(staging, cached)
  }
  const digest = await sha256Of(cached)
  if (digest !== target.sha256) {
    await rm(cached, { force: true })
    throw new Error(`${cached} had sha256 ${digest}, pinned ${target.sha256}. It was removed; run again to download it.`)
  }
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
// Returns the program's path and the sha256 of the program as it came out of
// the verified archive; proveDaemonRuns refuses to run anything else.
export async function unpackNode({ archive, target, destination, run = execute }) {
  // The cached archive is read exactly once, into memory. Those bytes are
  // checked against the pin and written to a private directory, and tar reads
  // only that copy, so a cache swapped after the check cannot reach tar. Limit:
  // a process running as the same user can still write the private copy.
  const staging = await mkdtemp(join(tmpdir(), "domovoi-node-"))
  let sha256
  try {
    await chmod(staging, 0o700)
    const bytes = await readFile(archive)
    const archiveDigest = createHash("sha256").update(bytes).digest("hex")
    if (archiveDigest !== target.sha256) throw new Error(`${archive} has sha256 ${archiveDigest}, pinned ${target.sha256}. Nothing was unpacked.`)
    const verified = join(staging, target.archive)
    await writeFile(verified, bytes, { flag: "wx", mode: 0o600 })
    const unpacked = join(staging, "unpacked")
    await mkdir(unpacked, { mode: 0o700 })
    await run("tar", ["-xf", verified, "-C", unpacked])
    const [top] = await readdir(unpacked)
    if (!top) throw new Error(`${archive} unpacked to nothing`)
    const member = join(unpacked, top, target.nodeExecutable)
    const program = await lstat(member).catch(() => undefined)
    if (!program?.isFile()) throw new Error(`${archive} holds no ${target.nodeExecutable}`)
    sha256 = await sha256Of(member)
    await rm(destination, { recursive: true, force: true })
    await mkdir(resolve(destination, ".."), { recursive: true })
    await rename(join(unpacked, top), destination)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  const executable = join(destination, target.nodeExecutable)
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
  return { executable, sha256 }
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
  await removeExternalLinks(destination, destination)
  return join(destination, "dist", "index.js")
}

// Removes links that resolve outside root and rewrites the rest relative to
// their own directory. An absolute link (a Windows junction is always one), or
// a relative one that climbs out of root and back in by its name, names the
// staging path; a verbatim copy would carry that name to a machine where it
// points outside the copy. Returns the number of links removed.
// Each entry is read with lstat when it is acted on, not from the listing: a
// file can become a link between the two. That narrows the race without
// closing it; assertShippedTreeContained is the check that decides.
// The one form a shipped link may take: the path from the link's real
// directory to its real target. Every component is a real directory, so the
// kernel reads the text exactly as it is written, and a copy under another
// root name resolves the same way. A link to its own directory is ".", not
// the empty text relative() gives, which macOS would store as an empty link.
async function canonicalLinkText(link, target) {
  return relative(await realpath(dirname(link)), target) || "."
}

// The root itself is inside: a package may link to the tree it ships in.
async function insideTree(root) {
  const real = await realpath(root)
  return (target) => target === real || target.startsWith(`${real}${sep}`)
}

export async function removeExternalLinks(path, root) {
  // Resolved first: lstat follows a link named with a trailing separator.
  await refuseLinkedRoot(resolve(root))
  const inside = await insideTree(root)
  let removed = 0
  for (const name of await readdir(path)) {
    const child = join(path, name)
    const entry = await lstat(child).catch(() => undefined)
    if (entry === undefined) continue
    if (entry.isSymbolicLink()) {
      const target = await realpath(child).catch(() => undefined)
      if (target === undefined || !inside(target)) { await rm(child, { force: true }); removed += 1; continue }
      const contained = await canonicalLinkText(child, target)
      if ((await readlink(child)) === contained) continue
      const type = (await stat(target)).isDirectory() ? "dir" : "file"
      await rm(child, { force: true })
      // Windows refuses a relative directory link without the symlink
      // privilege. The link is then gone rather than absolute; the proof on
      // that platform's packaging job fails if the daemon needed it.
      try { await symlink(contained, child, type) } catch { removed += 1 }
    } else if (entry.isDirectory()) {
      removed += await removeExternalLinks(child, root)
    }
  }
  return removed
}

export async function removeDanglingLinks(path) {
  let removed = 0
  for (const name of await readdir(path)) {
    const child = join(path, name)
    const entry = await lstat(child).catch(() => undefined)
    if (entry === undefined) continue
    if (entry.isSymbolicLink()) {
      if (!(await exists(child))) { await rm(child, { force: true }); removed += 1 }
    } else if (entry.isDirectory()) {
      removed += await removeDanglingLinks(child)
    }
  }
  return removed
}

// A tree root that is a link would make its target the base every check
// measures against, so a tree outside the runtime directory would pass.
async function refuseLinkedRoot(root) {
  const entry = await lstat(root)
  if (entry.isSymbolicLink()) throw new Error(`${root} is a symbolic link. The runtime tree root must be a real directory; nothing was checked.`)
  if (!entry.isDirectory()) throw new Error(`${root} is not a directory. Nothing was checked.`)
}

// The check that decides whether the runtime ships: every link in the final
// tree is relative, stays inside the tree at every step of its path (so a
// verbatim copy elsewhere resolves the same way), resolves to something inside
// the tree now, and is exactly the path from its real directory to that
// target. Throws naming each link that fails; returns the number
// of links checked.
//
// Ruled limit (owner, 2026-09-25): another process running as the same user
// on the build machine during packaging is outside the threat model; it could
// already change these scripts or the finished app. Such a process can still
// race this walk. A directory replaced by a link after its lstat is followed,
// and that link is not reported. The walk reads each entry once and does not
// try to close that race.
export async function assertShippedTreeContained(root) {
  const base = resolve(root)
  await refuseLinkedRoot(base)
  const inside = await insideTree(base)
  const failures = []
  let links = 0
  const walk = async (directory) => {
    for (const name of await readdir(directory)) {
      const child = join(directory, name)
      const entry = await lstat(child)
      if (entry.isDirectory()) { await walk(child); continue }
      if (!entry.isSymbolicLink()) continue
      links += 1
      const raw = await readlink(child)
      if (isAbsolute(raw) || /^[a-z]:|^[\\/]/i.test(raw)) { failures.push(`${child} -> ${raw} is absolute`); continue }
      let depth = relative(base, dirname(child)).split(/[\\/]/).filter((part) => part !== "" && part !== ".").length
      let leaves = false
      for (const part of raw.split(/[\\/]/)) {
        if (part === "" || part === ".") continue
        depth += part === ".." ? -1 : 1
        if (depth < 0) { leaves = true; break }
      }
      if (leaves) { failures.push(`${child} -> ${raw} climbs out of the tree`); continue }
      const target = await realpath(child).catch(() => undefined)
      if (target === undefined) { failures.push(`${child} -> ${raw} resolves to nothing`); continue }
      if (!inside(target)) { failures.push(`${child} -> ${raw} resolves to ${target}, outside the tree`); continue }
      // Read as text, the path can look contained while the kernel, which
      // follows each link before the next "..", passes the tree's parent and
      // comes back in by the root's own name; renamed, that link dangles or
      // reaches a decoy. Only the exact text removeExternalLinks writes passes.
      const canonical = await canonicalLinkText(child, target)
      if (raw !== canonical) failures.push(`${child} -> ${raw} is not the direct path to its target ${target}; it would be ${canonical}`)
    }
  }
  await walk(base)
  if (failures.length > 0) throw new Error(`${base} would ship ${failures.length} link${failures.length === 1 ? "" : "s"} that leave it:\n${failures.join("\n")}`)
  return links
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

// Run by the pinned program with the entry and a nonce: imports the entry as
// its command line would load it, then prints the nonce. The entry runs its
// command line on import, and --version is the one answer that starts nothing.
const entryLoadCheck = [
  'import { pathToFileURL } from "node:url"',
  "const [program, entry, nonce] = process.argv",
  'process.argv = [program, entry, "--version"]',
  "await import(pathToFileURL(entry).href)",
  "process.stdout.write(`\\ndomovoi-entry-loaded ${nonce}\\n`)",
].join("\n")

// The installer cannot prove the entry's imports resolve; running it can.
// Three checks, and only the first defends against a hostile program:
// - the program's sha256 is the one unpackNode took from the verified copy of
//   the pinned archive, checked before anything runs;
// - the entry answers --version with the daemon's version;
// - the entry loads under the program: the load check imports it, then prints
//   a nonce. This catches a program that ignores its arguments. It cannot
//   catch a hostile program, which sees the nonce in its arguments and can
//   print it without loading anything; nothing a program prints can prove
//   what it ran. The two run checks show the entry loads only because the
//   digest check has already shown the program is the pinned build.
export async function proveDaemonRuns({ nodeExecutable, nodeSha256, daemonEntry, expectedVersion, run = execute }) {
  const digest = await sha256Of(nodeExecutable)
  if (digest !== nodeSha256) throw new Error(`${nodeExecutable} has sha256 ${digest}; the program unpacked from the verified archive has sha256 ${nodeSha256}. Nothing was run.`)
  const { stdout } = await run(nodeExecutable, [daemonEntry, "--version"], { timeout: 30_000 })
  const printed = String(stdout).trim()
  if (printed !== expectedVersion) throw new Error(`${daemonEntry} printed version ${JSON.stringify(printed)}, expected ${expectedVersion}`)
  const nonce = randomBytes(16).toString("hex")
  const { stdout: loaded } = await run(nodeExecutable, ["--input-type=module", "--eval", entryLoadCheck, "--", daemonEntry, nonce], { timeout: 30_000 })
  const last = String(loaded).trim().split(/\r?\n/).at(-1)
  if (last !== `domovoi-entry-loaded ${nonce}`) throw new Error(`${daemonEntry} did not load under ${nodeExecutable}: the load check printed ${JSON.stringify(String(loaded).trim())}`)
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
  const { executable: nodeExecutable, sha256: nodeSha256 } = await unpackNode({ archive, target, destination: join(output, "node"), run })
  const daemonEntry = await deployDaemon({ repositoryRoot, destination: join(output, "daemon"), run })
  const pruned = await pruneDaemonRuntime(join(output, "daemon"), { platform, arch })
  log(`pruned ${pruned.files} entries, ${(pruned.bytes / 1048576).toFixed(1)} MB, the runtime never loads on ${target.key}`)
  // After the last change to the tree: this, not the cleanup above, decides.
  const links = await assertShippedTreeContained(output)
  log(`${links} link${links === 1 ? "" : "s"} in daemon-runtime/${target.key}, every one relative and inside it`)
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "apps/daemon/package.json"), "utf8"))
  const host = platform === process.platform && arch === process.arch
  if (host) {
    await proveDaemonRuns({ nodeExecutable, nodeSha256, daemonEntry, expectedVersion: manifest.version, run })
    log(`${nodeExecutable} is the program from the verified archive (sha256 ${nodeSha256}); ${daemonEntry} loaded under it and --version printed ${manifest.version}`)
  } else {
    log(`${target.key} is not this host, so ${daemonEntry} was not run; the packaging job on that platform proves it`)
  }
  const nodeBytes = await directoryBytes(join(output, "node"))
  const daemonBytes = await directoryBytes(join(output, "daemon"))
  log(`daemon-runtime/${target.key}: node ${(nodeBytes / 1048576).toFixed(1)} MB, daemon ${(daemonBytes / 1048576).toFixed(1)} MB`)
  return { output, nodeExecutable, daemonEntry, nodeBytes, daemonBytes }
}
