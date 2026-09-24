import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"

// Codex loads a project `.codex` folder once the person trusts the project:
// config.toml (MCP servers, hooks, permissions), hooks.json and rules/*.rules.
// It reads every such folder from the session's directory up to the project
// root, the nearest directory holding .git, and skips the folder that is its
// own CODEX_HOME. Measured with codex-cli 0.156.1: config/read layers against
// a scratch CODEX_HOME, and the config loader, hooks discovery and exec policy
// source at rust-v0.156.1.
//
// The check is synchronous so a request that passes it is sent in the same
// turn of the event loop as before; it costs a few stat calls per directory.
const loadedFiles = ["config.toml", "hooks.json"] as const
const rulesDirectory = "rules"
const rulesExtension = ".rules"

export function codexRepositoryConfigFile(
  cwd: string,
  codexHome: string = process.env.CODEX_HOME || join(homedir(), ".codex"),
): string | undefined {
  const start = resolve(cwd)
  const root = projectRoot(start)
  const home = realPath(codexHome)
  for (const directory of directoriesFrom(root, start)) {
    const folder = join(directory, ".codex")
    if (!isDirectory(folder) || realPath(folder) === home) continue
    for (const name of loadedFiles) {
      if (exists(join(folder, name))) return shown(root, join(folder, name))
    }
    const rules = entries(join(folder, rulesDirectory)).filter((name) => name.endsWith(rulesExtension)).sort()
    if (rules[0] !== undefined) return shown(root, join(folder, rulesDirectory, rules[0]))
  }
  return undefined
}

export function codexRepositoryConfigRefusal(file: string): string {
  return `Codex would load ${file} from this worktree, and that file can start programs or change agent permissions. `
    + "Domovoi does not load repository-brought configuration until a trust gate ships. "
    + `Remove ${file} from this worktree or use another provider here.`
}

function projectRoot(cwd: string): string {
  for (let directory = cwd; ; directory = dirname(directory)) {
    const marker = join(directory, ".git")
    const found = statSync(marker, { throwIfNoEntry: false })
    if (found && (!found.isDirectory() || exists(join(marker, "HEAD")))) return directory
    if (dirname(directory) === directory) return cwd
  }
}

function directoriesFrom(root: string, cwd: string): string[] {
  const directories: string[] = []
  for (let directory = cwd; ; directory = dirname(directory)) {
    directories.unshift(directory)
    if (directory === root || dirname(directory) === directory) return directories
  }
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false
}

function exists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined
}

function entries(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function realPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function shown(root: string, path: string): string {
  return relative(root, path).split(sep).join("/")
}
