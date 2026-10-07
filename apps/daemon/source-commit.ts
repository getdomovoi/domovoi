import { execFileSync } from "node:child_process"
import { realpathSync } from "node:fs"

export function readSourceCommit(repositoryRoot: string): string | undefined {
  // Prefer no commit rather than a wrong one for dirty or unpacked source.
  try {
    const git = (...args: string[]) => execFileSync("git", args, {
      cwd: repositoryRoot, stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim()
    if (realpathSync(git("rev-parse", "--show-toplevel")) !== realpathSync(repositoryRoot)) return undefined
    const commit = git("rev-parse", "HEAD")
    if (!/^[a-f0-9]{40}$/.test(commit)) return undefined
    if (git("status", "--porcelain", "--untracked-files=no")) return undefined
    return commit
  } catch {
    return undefined
  }
}
