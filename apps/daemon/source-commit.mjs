import { execFileSync } from "node:child_process"
import { realpathSync } from "node:fs"

/**
 * @param {string} repositoryRoot
 * @returns {string | undefined}
 */
export function readSourceCommit(repositoryRoot) {
  // Prefer no commit rather than a wrong one for dirty or unpacked source.
  try {
    /** @param {...string} args */
    const git = (...args) => execFileSync("git", args, {
      cwd: repositoryRoot, stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim()
    // Native resolution expands Windows 8.3 paths as well as symlinks.
    if (realpathSync.native(git("rev-parse", "--show-toplevel")) !== realpathSync.native(repositoryRoot)) return undefined
    const commit = git("rev-parse", "HEAD")
    if (!/^[a-f0-9]{40}$/.test(commit)) return undefined
    if (git("--no-optional-locks", "status", "--porcelain", "--untracked-files=no")) return undefined
    return commit
  } catch {
    return undefined
  }
}
