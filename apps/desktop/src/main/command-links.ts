import { constants, type Stats } from "node:fs"
import { access, lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises"
import { delimiter, dirname, join, resolve } from "node:path"

import { readPrivateFile, writePrivateFile } from "@getdomovoi/credential-store"

// Q336 A (2026-10-02): one reversible desktop action links Domovoi's own
// domovoid and domovoi into ~/.local/bin, so the commands the app prints run
// as printed. Each link names a launcher the app ships in its runtime
// (scripts/daemon-runtime.mjs). The rule that Domovoi never runs an installer
// covers third-party agents, not its own binaries.
//
// What it may touch: the directories ~/.local and ~/.local/bin when missing
// (only when linking), and the entries ~/.local/bin/domovoid and
// ~/.local/bin/domovoi, and its record of the links it made, in the app's
// userData. It never reads, writes or removes through a ~/.local or
// ~/.local/bin that is a link to another directory, never removes or replaces
// a link it did not record making, and never removes anything else.

export type CommandName = "domovoid" | "domovoi"
export type CommandLinkState = "linked" | "absent" | "stale" | "other"

export type CommandLinkReport =
  // launchers: the shipped launchers by their full path, when they exist,
  // so a printed command still runs where no link can be made. Never for an
  // app running from a path that will not exist next time.
  | { available: false; reason: string; launchers?: { name: CommandName; launcher: string }[] }
  | {
      available: true
      directory: "~/.local/bin"
      // Whether ~/.local/bin is on this app's own PATH. A shell may have it
      // where the app does not, so the printed command uses the full path
      // unless this is true.
      onPath: boolean
      commands: { name: CommandName; launcher: string; state: CommandLinkState }[]
    }

export type CommandLinkResult = { report: CommandLinkReport; refused?: string }

export type CommandLinkEnvironment = {
  home: string
  resourcesPath: string
  platform: NodeJS.Platform
  path: string | undefined
  // APPIMAGE as the AppImage runtime sets it, when the app runs as one.
  appImage?: string | undefined
  // The record of the links this app made, a private file in its userData.
  recordPath: string
}

// domovoid first: the daemon's launcher decides whether linking is offered.
const names: readonly CommandName[] = ["domovoid", "domovoi"]
const ownLauncher = (name: CommandName, target: string) => new RegExp(`[\\\\/]daemon-runtime[\\\\/]bin[\\\\/]${name}$`, "u").test(target)

async function entry(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

// Device and inode of an entry as lstat read it, never through a link.
const identityOf = (found: Stats) => `${found.dev}:${found.ino}`

// PR #712 security review round 1 (P3): a target shaped like a launcher is
// no proof this app made a link; a person's own link into a checkout has one
// too. The app records each link it makes, by path, target and device and
// inode, in a private file in its userData, and a link is its own, linked or
// stale, only while all four still match. Anything else is "other": never
// replaced or removed. A record that cannot be read owns nothing.
type LinkRecord = { name: CommandName; path: string; target: string; identity: string }
const recordLimit = 16 * 1024

function isLinkRecord(value: unknown): value is LinkRecord {
  if (typeof value !== "object" || value === null) return false
  const { name, path, target, identity } = value as Record<string, unknown>
  return names.includes(name as CommandName) && typeof path === "string" && typeof target === "string" && typeof identity === "string"
}

async function readRecords(recordPath: string): Promise<LinkRecord[]> {
  try {
    const text = await readPrivateFile(recordPath, { maximumBytes: recordLimit })
    if (text === undefined) return []
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null) return []
    const { version, links } = parsed as Record<string, unknown>
    return version === 1 && Array.isArray(links) && links.every(isLinkRecord) ? links : []
  } catch {
    return []
  }
}

async function writeRecords(recordPath: string, links: readonly LinkRecord[]): Promise<void> {
  await writePrivateFile(recordPath, `${JSON.stringify({ version: 1, links })}\n`, { maximumBytes: recordLimit })
}

// The state of one command and, for a link, the target and identity it was
// read with.
async function stateOf(name: CommandName, path: string, launcher: string, records: readonly LinkRecord[]): Promise<{ state: CommandLinkState; target?: string; identity?: string }> {
  const found = await entry(path)
  if (!found) return { state: "absent" }
  if (!found.isSymbolicLink()) return { state: "other" }
  const identity = identityOf(found)
  const target = await readlink(path)
  if (!records.some((record) => record.name === name && record.path === path && record.target === target && record.identity === identity)) return { state: "other" }
  if (target === launcher) return { state: "linked", target, identity }
  // Review P3-1: stale only when the launcher it names is gone (the app
  // moved or was deleted). A link to another Domovoi install that still
  // exists belongs to that install and is left alone.
  const stale = ownLauncher(name, target) && !await entry(resolve(dirname(path), target))
  return stale ? { state: "stale", target, identity } : { state: "other" }
}

// Review P3-2 and PR #712 security review round 1 (P2): read again right
// before a removal, so an entry that is no longer the link read (another
// inode, another target, not a link) is never removed.
async function stillLink(path: string, target: string | undefined, identity: string | undefined): Promise<boolean> {
  try {
    const found = await lstat(path)
    return found.isSymbolicLink() && identityOf(found) === identity && target !== undefined && await readlink(path) === target
  } catch {
    return false
  }
}

// PR #712 security review round 1 (P2): ~/.local and ~/.local/bin, pinned
// by device and inode once they are ready, and required to be those same
// real directories right before every removal and every link made, so
// nothing is removed or made through a directory swapped in after it was
// read.
type PinnedDirectories = { local: string; bin: string }
async function pinDirectories(home: string): Promise<PinnedDirectories | undefined> {
  try {
    const local = await entry(join(home, ".local"))
    const bin = await entry(join(home, ".local", "bin"))
    if (!local?.isDirectory() || !bin?.isDirectory()) return undefined
    return { local: identityOf(local), bin: identityOf(bin) }
  } catch {
    return undefined
  }
}
async function directoriesUnchanged(home: string, pinned: PinnedDirectories | undefined): Promise<boolean> {
  const now = await pinDirectories(home)
  return pinned !== undefined && now !== undefined && now.local === pinned.local && now.bin === pinned.bin
}

// Review P2-2: ~/.local and ~/.local/bin are checked for every action. A
// directory on the way that is a link would put the link somewhere other than
// ~/.local/bin, such as a dotfiles checkout, and would let a status or an
// unlink read or remove the person's own files there. Missing directories are
// reported as missing; only linking makes them.
type DirectoryState = { kind: "ready" } | { kind: "missing" } | { kind: "refused"; reason: string }

const notDirectory = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOTDIR"

async function directoryState(home: string): Promise<DirectoryState> {
  for (const [path, shown] of [[join(home, ".local"), "~/.local"], [join(home, ".local", "bin"), "~/.local/bin"]] as const) {
    const refusedNotDirectory = { kind: "refused" as const, reason: `${shown} is not a directory, so Domovoi does not read or write there.` }
    let found
    try {
      found = await entry(path)
    } catch (error) {
      // Review P3-3: a parent that is not a directory answers ENOTDIR.
      if (notDirectory(error)) return refusedNotDirectory
      throw error
    }
    if (!found) return { kind: "missing" }
    if (found.isSymbolicLink()) return { kind: "refused", reason: `${shown} is a link to another directory, so Domovoi does not read or write there.` }
    if (!found.isDirectory()) return refusedNotDirectory
  }
  return { kind: "ready" }
}

// Makes each missing directory, checking the chain again after each one. A
// parent that changed in between makes mkdir fail; the check that follows
// says what is there now.
async function makeDirectories(home: string): Promise<DirectoryState> {
  for (const path of [join(home, ".local"), join(home, ".local", "bin")]) {
    if (!await entry(path).catch(() => undefined)) {
      await mkdir(path).catch((error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== "ENOTDIR" && code !== "EEXIST") throw error
      })
    }
    const state = await directoryState(home)
    if (state.kind === "refused") return state
  }
  return directoryState(home)
}

type Inspected =
  | Extract<CommandLinkReport, { available: false }>
  | { available: true; onPath: boolean; commands: { name: CommandName; launcher: string; state: CommandLinkState; target?: string | undefined; identity?: string | undefined }[] }

// The launchers this app ships, in name order; domovoi only where the runtime
// carries the CLI.
async function shippedLaunchers(resourcesPath: string): Promise<{ name: CommandName; launcher: string }[]> {
  const found: { name: CommandName; launcher: string }[] = []
  for (const name of names) {
    const launcher = join(resourcesPath, "daemon-runtime", "bin", name)
    if ((await entry(launcher).catch(() => undefined))?.isFile()) found.push({ name, launcher })
  }
  return found
}

// Review P3-4: a path the app will not run from next time would leave a link
// to nothing: macOS App Translocation's temporary copy, a mounted disk image,
// and an AppImage, which mounts at a new path on every launch.
// Review P2-A: the report names no launcher there either. A printed command
// with that path, such as service install, would leave a login service that
// breaks once the app quits, so commands print as written and the reason
// points to the in-app Install, which copies the runtime out of the app.
const inAppInstall = " To keep Domovoi running after you quit, use Install under Daemon on this machine in Settings."

// Review of #712 (P2): an external drive also mounts under /Volumes, and an
// app kept there stays at its path. A /Volumes path is a disk image only when
// it is on a read-only mount, as the downloaded disk image is: write access
// there answers EROFS, which macOS and Linux return for a read-only file
// system whatever the permissions. No tool is spawned. Any other answer is
// not read only, and a disk image mounted writable is not caught. The same
// check as the daemon's `domovoid service install` (readOnlyMount in
// apps/daemon/src/service/runtime-stage.ts); kept in each because this
// module loads before, and without, the daemon the app ships.
async function readOnlyMount(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EROFS"
  }
}

async function unstableLocation(environment: CommandLinkEnvironment): Promise<string | undefined> {
  if (environment.appImage) return `Domovoi is running as an AppImage, which mounts at a new path on every launch, so a link to it would break.${inAppInstall}`
  if (environment.resourcesPath.includes("/AppTranslocation/")) return `macOS is running Domovoi from a temporary copy. Move Domovoi to Applications and open it from there to link its commands.${inAppInstall}`
  if (environment.resourcesPath.startsWith("/Volumes/") && await readOnlyMount(environment.resourcesPath)) {
    return `Domovoi is running from a disk image. Copy it to Applications and open it from there to link its commands.${inAppInstall}`
  }
  return undefined
}

async function inspect(environment: CommandLinkEnvironment, directories: DirectoryState): Promise<Inspected> {
  if (environment.platform === "win32") return { available: false, reason: "Domovoi links no commands on Windows." }
  const unstable = await unstableLocation(environment)
  if (unstable) return { available: false, reason: unstable }
  const shipped = await shippedLaunchers(environment.resourcesPath)
  const unavailable = (reason: string): Inspected => shipped.length > 0 ? { available: false, reason, launchers: shipped } : { available: false, reason }
  if (shipped[0]?.name !== "domovoid") return { available: false, reason: "This build ships no domovoid launcher, so there is nothing to link." }
  if (directories.kind === "refused") return unavailable(directories.reason)
  const directory = join(environment.home, ".local", "bin")
  const onPath = (environment.path ?? "").split(delimiter).some((part) => part.replace(/\/+$/u, "") === directory)
  const records = directories.kind === "missing" ? [] : await readRecords(environment.recordPath)
  const commands = await Promise.all(shipped.map(async ({ name, launcher }) => ({
    name,
    launcher,
    ...(directories.kind === "missing" ? { state: "absent" as const } : await stateOf(name, join(directory, name), launcher, records)),
  })))
  return { available: true, onPath, commands }
}

async function report(environment: CommandLinkEnvironment, directories: DirectoryState): Promise<CommandLinkReport> {
  const found = await inspect(environment, directories)
  if (!found.available) return found
  return {
    available: true,
    directory: "~/.local/bin",
    onPath: found.onPath,
    commands: found.commands.map(({ name, launcher, state }) => ({ name, launcher, state })),
  }
}

const otherFile = (name: string) => `~/.local/bin/${name} is not a link Domovoi made, so it was left as it is.`
const changedFile = (name: string) => `~/.local/bin/${name} changed while Domovoi was reading it, so it was left as it is.`
const changedDirectory = "~/.local/bin changed while Domovoi was reading it, so nothing there was changed."

export async function commandLinks(action: unknown, environment: CommandLinkEnvironment): Promise<CommandLinkResult> {
  if (action !== "status" && action !== "link" && action !== "unlink") throw new Error("Command link request is invalid")
  let directories = await directoryState(environment.home)
  if (action === "status") return { report: await report(environment, directories) }
  // Pinned before anything in them is read.
  let pinned = directories.kind === "ready" ? await pinDirectories(environment.home) : undefined
  const before = await inspect(environment, directories)
  if (!before.available) {
    return directories.kind === "refused" ? { report: before, refused: before.reason } : { report: before }
  }
  if (action === "link" && directories.kind === "missing") {
    directories = await makeDirectories(environment.home)
    if (directories.kind === "refused") return { report: await report(environment, directories), refused: directories.reason }
    pinned = await pinDirectories(environment.home)
  }
  const directory = join(environment.home, ".local", "bin")
  let refused: string | undefined
  let records = await readRecords(environment.recordPath)
  // Ruled Q411 A (2026-10-03), as round 8 of #577 did for the runtime
  // copy: each check below is made right before the unlink or symlink it
  // guards, and the instant between them is not covered. Node has no unlink
  // or symlink relative to an open directory, so each resolves
  // ~/.local/bin/<name> by path again. A process of the same user that swaps
  // ~/.local or ~/.local/bin, or the entry, in that instant can have one
  // entry of that name removed, or one link to this app's launcher made, in
  // the directory it swapped in. unlink never removes a directory and does
  // not follow a link at the entry itself.
  for (const command of before.commands) {
    const path = join(directory, command.name)
    if (command.state === "other") {
      refused ??= otherFile(command.name)
      continue
    }
    if (command.state === "absent" ? action === "unlink" : command.state === "linked" && action === "link") continue
    if (command.state !== "absent") {
      if (!await directoriesUnchanged(environment.home, pinned)) {
        refused ??= changedDirectory
        continue
      }
      if (!await stillLink(path, command.target, command.identity)) {
        refused ??= changedFile(command.name)
        continue
      }
      await unlink(path)
      records = records.filter((record) => record.name !== command.name)
      await writeRecords(environment.recordPath, records)
      if (action === "unlink") continue
    }
    // Review P3-2: the directories are read again right before the write.
    // symlink itself refuses an entry that appeared since it was read, so a
    // file made in between is never replaced.
    const now = await directoryState(environment.home)
    if (now.kind !== "ready") {
      refused ??= now.kind === "refused" ? now.reason : "~/.local/bin disappeared while Domovoi was linking, so nothing was written."
      continue
    }
    if (!await directoriesUnchanged(environment.home, pinned)) {
      refused ??= changedDirectory
      continue
    }
    await symlink(command.launcher, path)
    // Recorded as made: this path, the target written, and the new link's
    // device and inode, read back without following it.
    const made = await lstat(path)
    records = [...records.filter((record) => record.name !== command.name), { name: command.name, path, target: command.launcher, identity: identityOf(made) }]
    await writeRecords(environment.recordPath, records)
  }
  return { report: await report(environment, await directoryState(environment.home)), ...(refused ? { refused } : {}) }
}
