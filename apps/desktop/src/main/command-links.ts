import { lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises"
import { delimiter, join } from "node:path"

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

async function stateOf(path: string, launcher: string): Promise<CommandLinkState> {
  const found = await entry(path)
  if (!found) return "absent"
  if (!found.isSymbolicLink()) return "other"
  const target = await readlink(path)
  if (target === launcher) return "linked"
  return ownLauncher.test(target) ? "stale" : "other"
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

async function report(environment: CommandLinkEnvironment, directories: DirectoryState): Promise<CommandLinkReport> {
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
    state: directories.kind === "missing" ? "absent" as const : await stateOf(join(directory, name), launcher),
  })))
  return { available: true, directory: "~/.local/bin", onPath, commands }
}

const otherFile = (name: string) => `~/.local/bin/${name} is not a link Domovoi made, so it was left as it is.`

export async function commandLinks(action: unknown, environment: CommandLinkEnvironment): Promise<CommandLinkResult> {
  if (action !== "status" && action !== "link" && action !== "unlink") throw new Error("Command link request is invalid")
  let directories = await directoryState(environment.home)
  const before = await report(environment, directories)
  if (!before.available) {
    return action !== "status" && directories.kind === "refused" ? { report: before, refused: before.reason } : { report: before }
  }
  if (action === "status") return { report: before }
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
    if (action === "unlink") {
      if (command.state !== "absent") await unlink(path)
      continue
    }
    if (command.state === "linked") continue
    if (command.state === "stale") await unlink(path)
    // symlink refuses an entry that appeared since it was read, so a file
    // made in between is never replaced.
    await symlink(command.launcher, path)
  }
  return { report: await report(environment, await directoryState(environment.home)), ...(refused ? { refused } : {}) }
}
