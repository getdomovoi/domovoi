import { statSync } from "node:fs"
import { win32 } from "node:path"

// The command every daemon Git spawn runs (ruling Q301).
//
// Windows looks for a bare command name in the current directory before
// PATH, and Node's spawn does the same with the cwd it is given. A session
// worktree is that directory for most daemon Git commands, so a git.exe
// committed to the repository would run as the person before any filter
// isolation. On Windows the command is therefore an absolute path: the first
// git.exe in a PATH entry that is itself absolute (a drive letter and a
// separator, or a UNC path). Empty, relative and drive-relative entries,
// which resolve against the current directory, are passed over, and the
// current directory is never looked in on its own. Only git.exe counts:
// Git for Windows puts cmd\git.exe on PATH, and a .cmd or .bat would need a
// shell to run, which reads its arguments again. None found refuses.
//
// The result is kept per PATH value, so it is resolved once for the PATH the
// daemon runs with.
//
// POSIX execvp searches PATH alone, never the current directory except
// through an empty or "." PATH entry the person set, so the bare name stays
// there and a test can put a stand-in on PATH.
export class GitNotFoundError extends Error {
  constructor() {
    super("Domovoi found no git.exe in an absolute PATH entry. Install Git for Windows, or put its cmd folder on PATH, then start Domovoi again.")
    this.name = "GitNotFoundError"
  }
}

const resolved = new Map<string, string>()

function isFileOnDisk(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// The PATH the child gets. Windows environment names ignore case, and Node
// hands the child, of the names that differ only in case, the first in
// sorted order, inherited keys included, and none at all when its value is
// undefined (Node 22 lib/child_process.js, normalizeSpawnArguments). The same
// choice here keeps the resolver and the child on one PATH (ruling Q301).
function windowsPath(environment: NodeJS.ProcessEnv): string {
  const names: string[] = []
  // for...in, as Node reads it: inherited enumerable keys count too.
  for (const name in environment) names.push(name)
  names.sort()
  const chosen = names.find((name) => name.toUpperCase() === "PATH")
  return chosen === undefined ? "" : environment[chosen] ?? ""
}

// PATH's entries as libuv splits them for its own search (src/win/process.c,
// search_path): an entry that starts with a double or single quote runs to
// the matching quote before the next ";" is looked for, so a quoted
// directory can hold a ";". One leading and one trailing quote are dropped;
// nothing is trimmed, so " C:\Git" stays a relative entry, which is passed
// over. Empty entries are dropped.
function pathEntries(path: string): string[] {
  const entries: string[] = []
  let start = 0
  while (start <= path.length) {
    let end = start
    const quote = path[start]
    if (quote === "\"" || quote === "'") {
      const close = path.indexOf(quote, start + 1)
      end = close === -1 ? path.length : close
    }
    let separator = path.indexOf(";", end)
    if (separator === -1) separator = path.length
    let entry = path.slice(start, separator)
    if (entry.length > 0) {
      if (entry.startsWith("\"") || entry.startsWith("'")) entry = entry.slice(1)
      if (entry.endsWith("\"") || entry.endsWith("'")) entry = entry.slice(0, -1)
      entries.push(entry)
    }
    start = separator + 1
  }
  return entries
}

export function gitCommand(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  isFile: (path: string) => boolean = isFileOnDisk,
): string {
  if (platform !== "win32") return "git"
  const path = windowsPath(environment)
  const cache = isFile === isFileOnDisk
  const known = cache ? resolved.get(path) : undefined
  if (known !== undefined) return known
  for (const directory of pathEntries(path)) {
    if (directory.includes("\0") || !/^[A-Za-z]:[\\/]|^\\\\[^\\]/u.test(directory)) continue
    const candidate = win32.join(directory, "git.exe")
    if (isFile(candidate)) {
      if (cache) resolved.set(path, candidate)
      return candidate
    }
  }
  throw new GitNotFoundError()
}
