import { lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises"
import { delimiter, dirname, join, resolve } from "node:path"

// Q336 A (2026-10-02): one reversible desktop action links Domovoi's own
// domovoid into ~/.local/bin, so the commands the app prints run as printed.
// The link names the launcher the app ships in its daemon runtime
// (scripts/daemon-runtime.mjs). The rule that Domovoi never runs an installer
// covers third-party agents, not its own binaries.
//
// What it may touch: the directories ~/.local and ~/.local/bin when missing
// (only when linking), and the one entry ~/.local/bin/domovoid. It never
// reads, writes or removes through a ~/.local or ~/.local/bin that is a link
// to another directory, never replaces anything but a link to a Domovoi
// launcher, and never removes anything else. The runtime ships the daemon,
// not the domovoi CLI, so only domovoid is linked.

export type CommandLinkState = "linked" | "absent" | "stale" | "other"

export type CommandLinkReport =
  | { available: false; reason: string }
  | {
      available: true
      directory: "~/.local/bin"
      // Whether ~/.local/bin is on this app's own PATH. A shell may have it
      // where the app does not, so the printed command uses the full path
      // unless this is true.
      onPath: boolean
      commands: { name: "domovoid"; launcher: string; state: CommandLinkState }[]
    }

export type CommandLinkResult = { report: CommandLinkReport; refused?: string }

export type CommandLinkEnvironment = {
  home: string
  resourcesPath: string
  platform: NodeJS.Platform
  path: string | undefined
}

const names = ["domovoid"] as const
const ownLauncher = /[\\/]daemon-runtime[\\/]bin[\\/]domovoid$/u

async function entry(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

// The state of one command and, for a link, the target it was read with.
async function stateOf(path: string, launcher: string): Promise<{ state: CommandLinkState; target?: string }> {
  const found = await entry(path)
  if (!found) return { state: "absent" }
  if (!found.isSymbolicLink()) return { state: "other" }
  const target = await readlink(path)
  if (target === launcher) return { state: "linked", target }
  // Review P3-1: stale only when the launcher it names is gone (the app
  // moved or was deleted). A link to another Domovoi install that still
  // exists belongs to that install and is left alone.
  const stale = ownLauncher.test(target) && !await entry(resolve(dirname(path), target))
  return stale ? { state: "stale", target } : { state: "other" }
}

// Review P3-2: read again right before a removal, so a link that changed
// since it was read is never removed.
async function stillReads(path: string, target: string | undefined): Promise<boolean> {
  try {
    return target !== undefined && await readlink(path) === target
  } catch {
    return false
  }
}

// Review P2-2: ~/.local and ~/.local/bin are checked for every action. A
// directory on the way that is a link would put the link somewhere other than
// ~/.local/bin, such as a dotfiles checkout, and would let a status or an
// unlink read or remove the person's own files there. Missing directories are
// reported as missing; only linking makes them.
type DirectoryState = { kind: "ready" } | { kind: "missing" } | { kind: "refused"; reason: string }

async function directoryState(home: string): Promise<DirectoryState> {
  for (const [path, shown] of [[join(home, ".local"), "~/.local"], [join(home, ".local", "bin"), "~/.local/bin"]] as const) {
    const found = await entry(path)
    if (!found) return { kind: "missing" }
    if (found.isSymbolicLink()) return { kind: "refused", reason: `${shown} is a link to another directory, so Domovoi does not read or write there.` }
    if (!found.isDirectory()) return { kind: "refused", reason: `${shown} is not a directory, so Domovoi does not read or write there.` }
  }
  return { kind: "ready" }
}

// Makes each missing directory, checking the chain again after each one.
async function makeDirectories(home: string): Promise<DirectoryState> {
  for (const path of [join(home, ".local"), join(home, ".local", "bin")]) {
    if (!await entry(path)) await mkdir(path)
    const state = await directoryState(home)
    if (state.kind === "refused") return state
  }
  return directoryState(home)
}

type Inspected =
  | { available: false; reason: string }
  | { available: true; onPath: boolean; commands: { name: "domovoid"; launcher: string; state: CommandLinkState; target?: string | undefined }[] }

async function inspect(environment: CommandLinkEnvironment, directories: DirectoryState): Promise<Inspected> {
  if (environment.platform === "win32") return { available: false, reason: "Domovoi links no commands on Windows." }
  const launcher = join(environment.resourcesPath, "daemon-runtime", "bin", "domovoid")
  const shipped = await entry(launcher)
  if (!shipped?.isFile()) return { available: false, reason: "This build ships no domovoid launcher, so there is nothing to link." }
  if (directories.kind === "refused") return { available: false, reason: directories.reason }
  const directory = join(environment.home, ".local", "bin")
  const onPath = (environment.path ?? "").split(delimiter).some((part) => part.replace(/\/+$/u, "") === directory)
  const commands = await Promise.all(names.map(async (name) => ({
    name,
    launcher,
    ...(directories.kind === "missing" ? { state: "absent" as const } : await stateOf(join(directory, name), launcher)),
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

export async function commandLinks(action: unknown, environment: CommandLinkEnvironment): Promise<CommandLinkResult> {
  if (action !== "status" && action !== "link" && action !== "unlink") throw new Error("Command link request is invalid")
  let directories = await directoryState(environment.home)
  if (action === "status") return { report: await report(environment, directories) }
  const before = await inspect(environment, directories)
  if (!before.available) {
    return directories.kind === "refused" ? { report: before, refused: before.reason } : { report: before }
  }
  if (action === "link" && directories.kind === "missing") {
    directories = await makeDirectories(environment.home)
    if (directories.kind === "refused") return { report: await report(environment, directories), refused: directories.reason }
  }
  const directory = join(environment.home, ".local", "bin")
  let refused: string | undefined
  for (const command of before.commands) {
    const path = join(directory, command.name)
    if (command.state === "other") {
      refused ??= otherFile(command.name)
      continue
    }
    if (command.state === "absent" ? action === "unlink" : command.state === "linked" && action === "link") continue
    if (command.state !== "absent") {
      if (!await stillReads(path, command.target)) {
        refused ??= changedFile(command.name)
        continue
      }
      await unlink(path)
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
    await symlink(command.launcher, path)
  }
  return { report: await report(environment, await directoryState(environment.home)), ...(refused ? { refused } : {}) }
}
