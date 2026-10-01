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

// Windows environment names ignore case: Path is the usual spelling.
function windowsPath(environment: NodeJS.ProcessEnv): string {
  for (const [name, value] of Object.entries(environment)) {
    if (name.toUpperCase() === "PATH" && value !== undefined) return value
  }
  return ""
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
  for (const entry of path.split(";")) {
    const directory = entry.trim().replace(/^"(.*)"$/su, "$1")
    if (directory.includes("\0") || !/^[A-Za-z]:[\\/]|^\\\\[^\\]/u.test(directory)) continue
    const candidate = win32.join(directory, "git.exe")
    if (isFile(candidate)) {
      if (cache) resolved.set(path, candidate)
      return candidate
    }
  }
  throw new GitNotFoundError()
}
