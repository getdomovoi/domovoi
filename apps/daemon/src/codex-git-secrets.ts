import { execFile } from "node:child_process"

import { codexWorktreeSecretPatterns } from "./codex.js"

// The Codex sandbox refuses reads of these files on disk, but Git can still
// print any committed copy. The scan is bounded so a session never waits long
// on a large history: at most this many commits that touch a matching path,
// this long, and this much output. A scan that fails or hits a bound lists
// nothing.
export const codexHistoryScanLimits = { commits: 1_000, timeoutMs: 3_000, outputBytes: 256 * 1_024 } as const

export function committedCodexSecretPaths(worktree: string): Promise<string[] | undefined> {
  const args = [
    "-C", worktree, "log", "--all", "--no-renames", "--name-only", "--format=",
    `--max-count=${codexHistoryScanLimits.commits}`,
    "--", ...codexWorktreeSecretPatterns.map((pattern) => `:(glob)${pattern}`),
  ]
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { timeout: codexHistoryScanLimits.timeoutMs, maxBuffer: codexHistoryScanLimits.outputBytes },
      (error, stdout) => {
        if (error) {
          resolve(undefined)
          return
        }
        const paths = new Set(stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0))
        resolve([...paths].sort())
      },
    )
  })
}
