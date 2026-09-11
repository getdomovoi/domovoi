import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
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
  const parts = [`${drift.ahead} commit${drift.ahead === 1 ? "" : "s"} ahead of ${drift.baseline}`]
  if (drift.behind > 0) parts.push(`${drift.behind} behind`)
  parts.push(`${drift.baseline} last moved ${drift.mainAgeDays} day${drift.mainAgeDays === 1 ? "" : "s"} ago`)
  // Everything above is only as true as the ref it was read from.
  if (!drift.fetched) {
    parts.push(drift.baselineAge === undefined
      ? `could not fetch, and the age of this ${drift.baseline} is unknown`
      : `could not fetch, so this ${drift.baseline} is at least ${drift.baselineAge}h old and so is every number here`)
  }
  if (drift.staleLocal > 0) {
    parts.push(`local main is ${drift.staleLocal} behind ${drift.baseline}, so any count against it would be wrong`)
  }
  const line = `${drift.branch}: ${parts.join(", ")}`
  // Only the crossing is called out. A number with no reading is what the last
  // three days already had.
  if (drift.ahead >= stackThreshold && drift.mainAgeDays >= staleDays) {
    return `${line} — past ${stackThreshold} commits with main static, a stack of smaller pull requests is usually the answer`
  }
  return line
}

// origin/main is a local ref, exactly as stale as the last fetch, so reading it
// without fetching moves the bug up a level rather than out: "origin/main last
// moved a day ago" is a claim about when this copy changed, not about main.
//
// Measured on this repository 2026-09-10 rather than assumed: `git fetch origin
// main` is 0.44-0.48s against a 2.63s release:invariants, so the trade is about
// seventeen percent of a run that is not a hot loop, against three days of
// planning built on a stale ref. It fetches.
//
// Offline it does not fail. It falls back to the ref it has and says how old
// that ref is, because a baseline whose age is stated is usable and one that
// looks fresh is not.
async function fetchBaseline(git) {
  try {
    await git(["fetch", "--quiet", "origin", "main"])
    return { fetched: true }
  } catch {
    return { fetched: false }
  }
}

async function baselineAgeHours(root) {
  try {
    const { mtimeMs } = await stat(join(root, ".git", "FETCH_HEAD"))
    return Math.floor((Date.now() - mtimeMs) / 3_600_000)
  } catch {
    return undefined
  }
}

async function remoteBaseline(git) {
  try {
    await git(["rev-parse", "--verify", "origin/main"])
    return "origin/main"
  } catch {
    return "main"
  }
}

export async function branchDrift(root = repositoryRoot) {
  const git = async (args) => (await run("git", args, { cwd: root })).stdout.trim()
  try {
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"])
    if (branch === "main" || branch === "HEAD") return { detached: true, branch }
    // Local main is a cache, and a stale one answers every question wrongly
    // while looking exactly like a fresh one. Measured 2026-09-10: local main
    // was 60 commits behind the remote, which made a 62-commit branch report as
    // 121 and put five already-merged commits inside the proposed first pull
    // request. A number with an unstated baseline is an undated tick.
    const { fetched } = await fetchBaseline(git)
    const baseline = await remoteBaseline(git)
    const baselineAge = fetched ? 0 : await baselineAgeHours(root)
    const counts = await git(["rev-list", "--left-right", "--count", `${baseline}...HEAD`])
    const [behind, ahead] = counts.split(/\s+/u).map(Number)
    const mainSeconds = Number(await git(["log", "-1", "--format=%ct", baseline]))
    const mainAgeDays = Math.floor((Date.now() / 1_000 - mainSeconds) / 86_400)
    const staleLocal = baseline === "main"
      ? 0
      : Number(await git(["rev-list", "--count", `main..${baseline}`]).catch(() => "0"))
    return { detached: false, branch, baseline, ahead, behind, mainAgeDays, staleLocal, fetched, baselineAge }
  } catch {
    // A shallow clone, a worktree with no main, or no git at all. Saying the
    // check did not run beats reporting zero, which reads as "no drift".
    return { detached: true, branch: "unknown" }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write(`${driftReport(await branchDrift())}\n`)
}
