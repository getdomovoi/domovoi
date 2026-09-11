import { execFile } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

const run = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// Three days of work sat on one branch, 120 commits and 226 files, while main
// did not move. Nobody was ignoring it: nothing made it a task, so it never
// surfaced, and every other failure this week was fixed by making a state
// visible rather than by relying on someone noticing.
//
// This reports and never fails. A long branch is not invalid, and a gate that
// blocks one would be wrong; what was missing is the number, not a rule. The
// thresholds below are the point at which a stack is usually the answer, and
// they are stated so the number means something to a reader who has none.
export const stackThreshold = 20
export const staleDays = 2

export function driftReport(drift) {
  if (drift.detached) return "branch drift unknown: no main to compare against"
  const parts = [`${drift.ahead} commit${drift.ahead === 1 ? "" : "s"} ahead of main`]
  if (drift.behind > 0) parts.push(`${drift.behind} behind`)
  parts.push(`main last moved ${drift.mainAgeDays} day${drift.mainAgeDays === 1 ? "" : "s"} ago`)
  const line = `${drift.branch}: ${parts.join(", ")}`
  // Only the crossing is called out. A number with no reading is what the last
  // three days already had.
  if (drift.ahead >= stackThreshold && drift.mainAgeDays >= staleDays) {
    return `${line} — past ${stackThreshold} commits with main static, a stack of smaller pull requests is usually the answer`
  }
  return line
}

export async function branchDrift(root = repositoryRoot) {
  const git = async (args) => (await run("git", args, { cwd: root })).stdout.trim()
  try {
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"])
    if (branch === "main" || branch === "HEAD") return { detached: true, branch }
    const counts = await git(["rev-list", "--left-right", "--count", "main...HEAD"])
    const [behind, ahead] = counts.split(/\s+/u).map(Number)
    const mainSeconds = Number(await git(["log", "-1", "--format=%ct", "main"]))
    const mainAgeDays = Math.floor((Date.now() / 1_000 - mainSeconds) / 86_400)
    return { detached: false, branch, ahead, behind, mainAgeDays }
  } catch {
    // A shallow clone, a worktree with no main, or no git at all. Saying the
    // check did not run beats reporting zero, which reads as "no drift".
    return { detached: true, branch: "unknown" }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write(`${driftReport(await branchDrift())}\n`)
}
