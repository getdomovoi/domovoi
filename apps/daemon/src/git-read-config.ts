import { execFile, spawn } from "node:child_process"
import { access } from "node:fs/promises"
import { resolve } from "node:path"

// A read-only Git command still runs whatever programs Git is configured to
// run: an fsmonitor helper, an external diff or textconv, a filter,
// a signature verifier, or a post-index-change hook when git status rewrites
// the index. Any of them could read outside the worktree, so the command may
// skip the card only when none is configured. Config comes from every scope
// Git reads (system, global, repository, worktree, includes, GIT_CONFIG_*),
// and a read that fails counts as a program that could run.
//
// Two exceptions and one addition (owner rulings 2026-09-23): the four filter
// lines `git lfs install` writes are allowed exactly as written (git-lfs
// v3.8.0 lfs/attribute.go); and a repository with a submodule always asks,
// because git status runs each populated gitlink under that submodule's own
// configuration, which this check does not read.
//
// Pager settings are not checked (owner ruling 2026-09-23): Git starts a pager
// only when its output is a terminal, and Claude Code runs Bash commands
// without one. A command that fakes a terminal (script, unbuffer) is not a
// listed read, so it asks before this check runs.

const programKeys: readonly RegExp[] = [
  /^diff\.external$/,
  /^diff\..+\.(?:textconv|command)$/,
  /^filter\./,
  /^gpg\.program$/,
  /^gpg\..+\.program$/,
]
const standardLfsFilter: Readonly<Record<string, string>> = {
  "filter.lfs.clean": "git-lfs clean -- %f",
  "filter.lfs.smudge": "git-lfs smudge -- %f",
  "filter.lfs.process": "git-lfs filter-process",
  "filter.lfs.required": "true",
}
const switchedKeys = new Set(["core.fsmonitor", "log.showsignature"])
// Every signature placeholder (%G?, %GG, %GS, %GK, %GF, %GP, %GT, %GR) starts
// with %G, and git log runs the signature program to fill any of them.
const signatureFormatKeys = /^(?:format\.pretty|pretty\..+)$/
const falseValues = new Set(["false", "no", "off", "0", ""])
// Git runs GIT_EXTERNAL_DIFF for diffs and finds its helper programs under
// GIT_EXEC_PATH.
const programEnvironment = ["GIT_EXTERNAL_DIFF", "GIT_EXEC_PATH"] as const
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
    const raw = separator === -1 ? undefined : entry.slice(separator + 1)
    const value = raw === undefined ? "true" : raw.trim().toLowerCase()
    if (raw !== undefined && Object.hasOwn(standardLfsFilter, key) && standardLfsFilter[key] === raw) continue
    if (programKeys.some((pattern) => pattern.test(key))) return true
    if (switchedKeys.has(key) && !falseValues.has(value)) return true
    if (signatureFormatKeys.test(key) && raw !== undefined && raw.includes("%G")) return true
  }
  if (await hasGitlink(directory, env)) return true
  const hook = await run(directory, ["rev-parse", "--git-path", "hooks/post-index-change"], env)
  if (hook === undefined) return true
  try {
    await access(resolve(directory, hook.replace(/\r?\n$/, "")))
    return true
  } catch {
    return false
  }
}

// A gitlink (mode 160000) in the index is what git status recurses into,
// with or without a .gitmodules file. The index is read as a stream and the
// scan stops at the first gitlink; a failed or slow read counts as one.
function hasGitlink(directory: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((done) => {
    let settled = false
    const finish = (found: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      done(found)
    }
    const child = spawn("git", ["-C", directory, "ls-files", "--stage", "-z"], { env, stdio: ["ignore", "pipe", "ignore"] })
    const timer = setTimeout(() => finish(true), limits.timeout)
    let pending = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      const entries = (pending + chunk).split("\0")
      pending = entries.pop() ?? ""
      if (entries.some((entry) => entry.startsWith("160000 "))) finish(true)
    })
    child.on("error", () => finish(true))
    child.on("close", (code) => finish(code !== 0 || pending.startsWith("160000 ")))
  })
}
