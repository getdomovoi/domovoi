import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { promisify } from "node:util"

import {
  repositoryGitConfigUnreadableReasons, repositoryGitFilterOperations, repositoryGitFilterScopes, type RepositoryGitFilterScope,
} from "@getdomovoi/protocol"

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
//
// The exemption covers git-lfs itself, not what the repository's config tells
// it to start (Q207 A as amended 2026-09-30). git-lfs reads the same Git
// config and starts a custom transfer agent, or an extension's clean or
// smudge command, that config names, so each such setting is listed like a
// filter command. Keys as git-lfs v3.8.0 matches them: a custom transfer's
// path by the unanchored, case-insensitive `customtransfer.<name>.path`
// (tq/custom.go) and its args as `lfs.customtransfer.<name>.args`; the
// standalone agent plain or URL-scoped (tq/manifest.go, config.URLConfig);
// lfs.extension.<name>.clean and .smudge (config/git_fetcher.go). The
// tracked .lfsconfig cannot set any of them: git-lfs reads only its safeKeys
// list, extension priorities, remote.<name>.* and *.access keys from it
// (git_fetcher.go readGitConfig), so this reads Git's config alone.

export type RepositoryGitFilterOperation = (typeof repositoryGitFilterOperations)[number]

export type RepositoryGitFilter = {
  scope: RepositoryGitFilterScope
  // The key as `git config` prints it: filter.<driver>.<operation>, or the
  // lfs.* setting.
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

// Every filter and lfs setting; classify() picks the ones that start a program.
const filterKeyPattern = String.raw`^(filter|lfs)\.`
const repositoryScopes: ReadonlySet<string> = new Set(repositoryGitFilterScopes)

// The driver and operation of a setting that starts a program, or undefined.
// `git config` prints section and variable names in lower case.
function classify(key: string, value: string): { driver: string; operation: RepositoryGitFilterOperation } | undefined {
  const filter = /^filter\.(.+)\.(clean|smudge|process)$/u.exec(key)
  if (filter) return { driver: filter[1]!, operation: filter[2] as RepositoryGitFilterOperation }
  if (!key.startsWith("lfs.")) return undefined
  const path = /customtransfer\.([^.]+)\.path/iu.exec(key)
  if (path) return { driver: path[1]!, operation: "lfs-transfer-path" }
  const args = /customtransfer\.([^.]+)\.args$/iu.exec(key)
  if (args) return { driver: args[1]!, operation: "lfs-transfer-args" }
  if (/^lfs\.(?:.+\.)?standalonetransferagent$/u.test(key)) return { driver: value, operation: "lfs-standalone-agent" }
  const extension = /^lfs\.extension\.([^.]+)\.(clean|smudge)$/iu.exec(key)
  if (extension) return { driver: extension[1]!, operation: `lfs-extension-${extension[2]!.toLowerCase() as "clean" | "smudge"}` }
  return undefined
}

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

// One filter or lfs setting as Git read it, from any scope.
export type GitFilterSetting = { scope: string; key: string; value: string; origin: string | undefined }

export async function readRepositoryGitFilters(directory: string, signal?: AbortSignal): Promise<RepositoryGitFilter[]> {
  return repositoryGitFilters(await readGitFilterSettings(directory, signal))
}

// The settings from the repository's own config that start a program.
export function repositoryGitFilters(settings: readonly GitFilterSetting[]): RepositoryGitFilter[] {
  const filters: RepositoryGitFilter[] = []
  for (const { scope, key, value, origin } of settings) {
    if (trustedConfigScopes.has(scope)) continue
    // An empty value runs nothing.
    if (value === "" || isStandardLfsFilterLine(key, value)) continue
    const classified = classify(key, value)
    if (classified === undefined) continue
    filters.push({ scope: scope as RepositoryGitFilterScope, key, ...classified, value, origin })
  }
  return filters
}

// Every filter and lfs setting Git reads in `directory`, in Git's order, from
// every scope. A scope this reader does not know fails the read, so no caller
// runs or hides what it sets.
export async function readGitFilterSettings(directory: string, signal?: AbortSignal): Promise<GitFilterSetting[]> {
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
  const settings: GitFilterSetting[] = []
  // Each record is scope NUL origin NUL key LF value NUL.
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const scope = fields[index]!
    const origin = fields[index + 1]!
    const record = fields[index + 2]!
    if (!trustedConfigScopes.has(scope) && !repositoryScopes.has(scope)) throw new RepositoryGitConfigUnreadableError("git-failed")
    const newline = record.indexOf("\n")
    // A key with no value is a config error for a filter or a program Git
    // LFS would start: Git or git-lfs stops before running anything.
    if (newline === -1) continue
    settings.push({
      scope,
      key: record.slice(0, newline),
      value: record.slice(newline + 1),
      origin: origin.startsWith("file:") ? resolve(directory, origin.slice("file:".length)) : undefined,
    })
  }
  return settings
}
