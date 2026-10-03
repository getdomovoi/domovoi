import { lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises"
import { delimiter, join } from "node:path"

// Q336 A (2026-10-02): one reversible desktop action links Domovoi's own
// domovoid into ~/.local/bin, so the commands the app prints run as printed.
// The link names the launcher the app ships in its daemon runtime
// (scripts/daemon-runtime.mjs). The rule that Domovoi never runs an installer
// covers third-party agents, not its own binaries.
//
// What it may touch: the directories ~/.local and ~/.local/bin when missing,
// and the one entry ~/.local/bin/domovoid. It never writes through a link to
// another directory, never replaces anything but a link to a Domovoi
// launcher, and never removes anything else. The runtime ships the daemon,
// not the domovoi CLI, so only domovoid is linked.

export type CommandLinkState = "linked" | "absent" | "stale" | "other"

export type CommandLinkReport =
  | { available: false }
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

async function report(environment: CommandLinkEnvironment): Promise<CommandLinkReport> {
  if (environment.platform === "win32") return { available: false }
  const launcher = join(environment.resourcesPath, "daemon-runtime", "bin", "domovoid")
  const shipped = await entry(launcher)
  if (!shipped?.isFile()) return { available: false }
  const directory = join(environment.home, ".local", "bin")
  const onPath = (environment.path ?? "").split(delimiter).some((part) => part.replace(/\/+$/u, "") === directory)
  const commands = await Promise.all(names.map(async (name) => ({ name, launcher, state: await stateOf(join(directory, name), launcher) })))
  return { available: true, directory: "~/.local/bin", onPath, commands }
}

const otherFile = (name: string) => `~/.local/bin/${name} is not a link Domovoi made, so it was left as it is.`

// A directory on the way that is a link would put the link somewhere other
// than ~/.local/bin, such as a dotfiles checkout, so nothing is written.
async function directoryRefusal(home: string): Promise<string | undefined> {
  for (const [path, shown] of [[join(home, ".local"), "~/.local"], [join(home, ".local", "bin"), "~/.local/bin"]] as const) {
    const found = await entry(path)
    if (!found) {
      await mkdir(path)
      continue
    }
    if (found.isSymbolicLink()) return `${shown} is a link to another directory, so Domovoi wrote nothing there.`
    if (!found.isDirectory()) return `${shown} is not a directory, so Domovoi wrote nothing there.`
  }
  return undefined
}

export async function commandLinks(action: unknown, environment: CommandLinkEnvironment): Promise<CommandLinkResult> {
  if (action !== "status" && action !== "link" && action !== "unlink") throw new Error("Command link request is invalid")
  const before = await report(environment)
  if (action === "status" || !before.available) return { report: before }
  const directory = join(environment.home, ".local", "bin")
  let refused: string | undefined
  if (action === "link") {
    refused = await directoryRefusal(environment.home)
    if (refused) return { report: await report(environment), refused }
  }
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
  return { report: await report(environment), ...(refused ? { refused } : {}) }
}
