import { execFile } from "node:child_process"
import { access } from "node:fs/promises"
import { resolve } from "node:path"

// A read-only Git command still runs whatever programs Git is configured to
// run: an fsmonitor helper, a pager, an external diff or textconv, a filter,
// a signature verifier, or a post-index-change hook when git status rewrites
// the index. Any of them could read outside the worktree, so the command may
// skip the card only when none is configured. Config comes from every scope
// Git reads (system, global, repository, worktree, includes, GIT_CONFIG_*),
// and a read that fails counts as a program that could run.

const programKeys: readonly RegExp[] = [
  /^core\.pager$/,
  /^pager\./,
  /^diff\.external$/,
  /^diff\..+\.(?:textconv|command)$/,
  /^filter\./,
  /^gpg\.program$/,
  /^gpg\..+\.program$/,
]
const switchedKeys = new Set(["core.fsmonitor", "log.showsignature"])
const falseValues = new Set(["false", "no", "off", "0", ""])
const programEnvironment = ["GIT_EXTERNAL_DIFF", "GIT_PAGER"] as const
const limits = { timeout: 3_000, maxBuffer: 1024 * 1024 }

function run(directory: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((done) => {
    execFile("git", ["-C", directory, ...args], { ...limits, env }, (error, stdout) => {
      done(error ? undefined : stdout)
    })
  })
}

export async function gitReadCanRunProgram(directory: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (programEnvironment.some((name) => (env[name] ?? "").length > 0)) return true
  const listed = await run(directory, ["config", "--list", "-z"], env)
  if (listed === undefined) return true
  for (const entry of listed.split("\0")) {
    if (entry.length === 0) continue
    const separator = entry.indexOf("\n")
    const key = (separator === -1 ? entry : entry.slice(0, separator)).toLowerCase()
    const value = separator === -1 ? "true" : entry.slice(separator + 1).trim().toLowerCase()
    if (programKeys.some((pattern) => pattern.test(key))) return true
    if (switchedKeys.has(key) && !falseValues.has(value)) return true
  }
  const hook = await run(directory, ["rev-parse", "--git-path", "hooks/post-index-change"], env)
  if (hook === undefined) return true
  try {
    await access(resolve(directory, hook.trim()))
    return true
  } catch {
    return false
  }
}
