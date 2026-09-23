import { execFile } from "node:child_process"

import { codexWorktreeSecretPatterns } from "./codex.js"

// The Codex sandbox refuses reads of these files on disk, but Git can still
// print any committed copy. The scan is bounded so a session never waits long
// on a large history: at most this many commits that touch a matching path,
// this long, and this much output. A scan that fails or reaches a bound
// returns undefined, which the notice reports as unfinished.
export type HistoryScanLimits = { commits: number; timeoutMs: number; outputBytes: number }

export const codexHistoryScanLimits: Readonly<HistoryScanLimits> = { commits: 1_000, timeoutMs: 3_000, outputBytes: 256 * 1_024 }

const commitMarker = "\u0001"

export function committedCodexSecretPaths(
  worktree: string,
  limits: Readonly<HistoryScanLimits> = codexHistoryScanLimits,
): Promise<string[] | undefined> {
  const args = [
    "-C", worktree, "log", "--all", "--no-renames", "--name-only", "--format=%x01",
    `--max-count=${limits.commits}`,
    "--", ...codexWorktreeSecretPatterns.map((pattern) => `:(glob)${pattern}`),
  ]
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { timeout: limits.timeoutMs, maxBuffer: limits.outputBytes },
      (error, stdout) => {
        if (error) {
          resolve(undefined)
          return
        }
        const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
        // Git stops quietly at --max-count, so reaching it means more history
        // may hold matching files that were never read.
        if (lines.filter((line) => line === commitMarker).length >= limits.commits) {
          resolve(undefined)
          return
        }
        resolve([...new Set(lines.filter((line) => line !== commitMarker))].sort())
      },
    )
  })
}
