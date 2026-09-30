import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { promisify } from "node:util"

import { repositoryGitConfigUnreadableReasons, repositoryGitFilterScopes, type RepositoryGitFilterScope } from "@getdomovoi/protocol"

import { gitEnvironment, inertRepositoryConfig, trustedConfigScopes } from "./git-environment.js"
import { isStandardLfsFilterLine } from "./git-read-config.js"

const execute = promisify(execFile)

// The git filter drivers a repository's own Git config sets, as Git reads
// them in one directory. Git decides what counts there: a worktree's own
// config.worktree, files the repository config includes, and conditional
// includes such as includeIf "onbranch:" all depend on the worktree, so a
// session worktree can hold a filter its main checkout does not. Reading runs
// `git config` alone, which runs no repository program.
//
// A driver from the person's global or system config is their own tool and is
// not listed. Neither are the exact lines `git lfs install` writes (ruling
// Q207 A), which run the person's own git-lfs, nor a line with no command,
// which runs nothing.

export type RepositoryGitFilterOperation = "clean" | "smudge" | "process"

export type RepositoryGitFilter = {
  scope: RepositoryGitFilterScope
  // The key as `git config` prints it: filter.<driver>.<operation>.
  key: string
  driver: string
  operation: RepositoryGitFilterOperation
  // The command as written, secrets included: for the digest and the gate,
  // never sent, stored or logged.
  value: string
  // The absolute path of the config file that sets it, or undefined when Git
  // names no file (a -c setting).
  origin: string | undefined
}

const filterKeyPattern = String.raw`^filter\..+\.(clean|smudge|process)$`
const repositoryScopes: ReadonlySet<string> = new Set(repositoryGitFilterScopes)

export type RepositoryGitConfigUnreadableReason = (typeof repositoryGitConfigUnreadableReasons)[number]

// The config could not be read, for a reason other than the folder not being
// a Git repository. Nothing is known about the filters it sets, so what asked
// must not read it as setting none.
export class RepositoryGitConfigUnreadableError extends Error {
  constructor(readonly reason: RepositoryGitConfigUnreadableReason, options?: { cause?: unknown }) {
    super(reason === "too-large"
      ? "The repository's Git config sets more filter settings than Domovoi reads"
      : "Git could not read the repository's Git config", options)
    this.name = "RepositoryGitConfigUnreadableError"
  }
}

export const maximumRepositoryGitConfigOutputBytes = 4 * 1024 * 1024

export async function readRepositoryGitFilters(directory: string, signal?: AbortSignal): Promise<RepositoryGitFilter[]> {
  let output: string
  try {
    output = (await execute("git", [
      "-C", directory, ...inertRepositoryConfig,
      "config", "--show-scope", "--show-origin", "-z", "--get-regexp", filterKeyPattern,
    ], { env: gitEnvironment(), encoding: "utf8", maxBuffer: maximumRepositoryGitConfigOutputBytes, ...(signal ? { signal } : {}) })).stdout
  } catch (error) {
    signal?.throwIfAborted()
    const { code, stderr } = error as { code?: unknown; stderr?: unknown }
    // Exit 1: no key matched.
    if (code === 1) return []
    // No repository here, so no repository config: Git refuses every
    // command in this folder, and no filter runs.
    if (code === 128 && typeof stderr === "string" && /not a git repository/iu.test(stderr)) return []
    throw new RepositoryGitConfigUnreadableError(code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "too-large" : "git-failed", { cause: error })
  }
  const fields = output.split("\0")
  const filters: RepositoryGitFilter[] = []
  // Each record is scope NUL origin NUL key LF value NUL.
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const scope = fields[index]!
    const origin = fields[index + 1]!
    const record = fields[index + 2]!
    if (trustedConfigScopes.has(scope)) continue
    // Fail closed on a scope this reader does not know: the operation that
    // asked stops rather than run or hide what it sets.
    if (!repositoryScopes.has(scope)) throw new RepositoryGitConfigUnreadableError("git-failed")
    const newline = record.indexOf("\n")
    // A key with no value is a config error for a filter: Git stops before
    // running anything. An empty value runs nothing.
    if (newline === -1) continue
    const key = record.slice(0, newline)
    const value = record.slice(newline + 1)
    if (value === "" || isStandardLfsFilterLine(key, value)) continue
    const operationAt = key.lastIndexOf(".")
    filters.push({
      scope: scope as RepositoryGitFilterScope,
      key,
      driver: key.slice("filter.".length, operationAt),
      operation: key.slice(operationAt + 1).toLowerCase() as RepositoryGitFilterOperation,
      value,
      origin: origin.startsWith("file:") ? resolve(directory, origin.slice("file:".length)) : undefined,
    })
  }
  return filters
}
