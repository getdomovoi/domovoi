import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { promisify } from "node:util"

import { repositoryGitFilterScopes, type RepositoryGitFilterScope } from "@getdomovoi/protocol"

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

export async function readRepositoryGitFilters(directory: string, signal?: AbortSignal): Promise<RepositoryGitFilter[]> {
  let output: string
  try {
    output = (await execute("git", [
      "-C", directory, ...inertRepositoryConfig,
      "config", "--show-scope", "--show-origin", "-z", "--get-regexp", filterKeyPattern,
    ], { env: gitEnvironment(), encoding: "utf8", maxBuffer: 4 * 1024 * 1024, ...(signal ? { signal } : {}) })).stdout
  } catch (error) {
    // Exit 1: no key matched.
    if ((error as { code?: unknown }).code === 1) return []
    throw error
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
    if (!repositoryScopes.has(scope)) throw new Error(`Git reported a config scope this daemon does not know: ${scope}`)
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
