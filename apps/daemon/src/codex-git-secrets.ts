import { execFile } from "node:child_process"

import { codexWorktreeSecretPatterns } from "./codex.js"
import { gitReadCanRunProgram } from "./git-read-config.js"

// The Codex sandbox refuses reads of these files on disk, but Git can still
// print any committed copy. The scan is bounded so a session never waits long
// on a large history: at most this many commits that touch a matching path,
// this long, and this much output. A scan that fails or reaches a bound
// returns undefined, which the notice reports as unfinished.
//
// The scan is a Git read like any other, so it runs only when the same check
// that gates Claude's Git reads finds no program Git could run (a partial
// clone fetches missing trees through the remote's programs, measured with
// --filter=tree:0). It also runs with the repository's hooks and fsmonitor
// switched off, no ext:: transport, and lazy fetching disabled, so a setting
// that check does not know about still cannot fetch or run a hook.
export type HistoryScanLimits = { commits: number; timeoutMs: number; outputBytes: number }

export const codexHistoryScanLimits: Readonly<HistoryScanLimits> = { commits: 1_000, timeoutMs: 3_000, outputBytes: 256 * 1_024 }

const commitMarker = "\u0001"

const inertGit = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "protocol.ext.allow=never",
] as const

export async function committedCodexSecretPaths(
  worktree: string,
  limits: Readonly<HistoryScanLimits> = codexHistoryScanLimits,
): Promise<string[] | undefined> {
  if (await gitReadCanRunProgram(worktree)) return undefined
  const env = { ...process.env, GIT_NO_LAZY_FETCH: "1" }
  const args = [
    "-C", worktree, ...inertGit, "log", "--all", "--no-renames", "--name-only", "--format=%x01",
    `--max-count=${limits.commits}`,
    "--", ...codexWorktreeSecretPatterns.map((pattern) => `:(glob)${pattern}`),
  ]
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { timeout: limits.timeoutMs, maxBuffer: limits.outputBytes, env },
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
