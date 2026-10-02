import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { promisify } from "node:util"

import {
  repositoryGitConfigUnreadableReasons, repositoryGitFilterOperations, repositoryGitFilterScopes, type RepositoryGitFilterScope,
} from "@getdomovoi/protocol"

import { gitCommand } from "./git-command.js"
import { gitEnvironment, inertRepositoryConfig, trustedConfigScopes } from "./git-environment.js"
import { isStandardLfsFilterLine } from "./git-read-config.js"
import { inventoryFieldCaps, redactInventoryText } from "./inventory-redaction.js"

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
  // For a filter.<driver>.* command, the value the repository's own config
  // gives filter.<driver>.required, when it gives one. It decides whether Git
  // stores unfiltered bytes when the filter fails, so the digest, the
  // comparison and the reviewed pins carry it with the command.
  required?: string
}

// Every filter and lfs setting; classify() picks the ones that start a program.
const filterKeyPattern = String.raw`^(filter|lfs)\.`
const repositoryScopes: ReadonlySet<string> = new Set(repositoryGitFilterScopes)

// The driver and operation of a setting that starts a program, or undefined.
// `git config` prints section and variable names in lower case.
export function classify(key: string, value: string): { driver: string; operation: RepositoryGitFilterOperation } | undefined {
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
  // detail: what Git stops on, when Domovoi found it: the key, redacted.
  constructor(readonly reason: RepositoryGitConfigUnreadableReason, options?: { cause?: unknown; detail?: string }) {
    super(`${reason === "too-large"
      ? "The repository's Git config sets more filter settings than Domovoi reads"
      : "Git could not read the repository's Git config"}${options?.detail === undefined ? "" : `: ${options.detail}`}`,
    options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = "RepositoryGitConfigUnreadableError"
  }
}

export const maximumRepositoryGitConfigOutputBytes = 4 * 1024 * 1024

// One filter or lfs setting as Git read it, from any scope.
export type GitFilterSetting = { scope: string; key: string; value: string; origin: string | undefined }

// A config read that has not finished by then fails as git-failed: a config
// can include a file that never ends, a FIFO, and tool.inventory and the
// trust step read with no signal of their own.
export const repositoryGitConfigReadTimeoutMs = 10_000

export async function readRepositoryGitFilters(
  directory: string,
  signal?: AbortSignal,
  timeoutMs: number = repositoryGitConfigReadTimeoutMs,
): Promise<RepositoryGitFilter[]> {
  return repositoryGitFilters(await readGitFilterSettings(directory, signal, timeoutMs))
}

// The settings from the repository's own config that start a program.
export function repositoryGitFilters(settings: readonly GitFilterSetting[]): RepositoryGitFilter[] {
  // The last value the repository's own config gives each driver's required.
  const required = new Map<string, string>()
  for (const { scope, key, value } of settings) {
    const driver = /^filter\.(.+)\.required$/u.exec(key)?.[1]
    if (driver !== undefined && !trustedConfigScopes.has(scope)) required.set(driver, value)
  }
  const filters: RepositoryGitFilter[] = []
  for (const { scope, key, value, origin } of settings) {
    if (trustedConfigScopes.has(scope)) continue
    // An empty value runs nothing.
    if (value === "" || isStandardLfsFilterLine(key, value)) continue
    const classified = classify(key, value)
    if (classified === undefined) continue
    const driverRequired = key.startsWith("filter.") ? required.get(classified.driver) : undefined
    filters.push({
      scope: scope as RepositoryGitFilterScope, key, ...classified, value, origin, ...(driverRequired === undefined ? {} : { required: driverRequired }),
    })
  }
  return filters
}

// Every filter and lfs setting Git reads in `directory`, in Git's order, from
// every scope. A scope this reader does not know fails the read, so no caller
// runs or hides what it sets.
export async function readGitFilterSettings(
  directory: string,
  signal?: AbortSignal,
  timeoutMs: number = repositoryGitConfigReadTimeoutMs,
): Promise<GitFilterSetting[]> {
  let output: string
  try {
    const env = gitEnvironment()
    // No Git found reads as a Git that failed: git-failed below.
    output = (await execute(gitCommand(env), [
      "-C", directory, ...inertRepositoryConfig,
      "config", "--show-scope", "--show-origin", "-z", "--get-regexp", filterKeyPattern,
    ], {
      env, encoding: "utf8", maxBuffer: maximumRepositoryGitConfigOutputBytes,
      timeout: timeoutMs, killSignal: "SIGKILL", ...(signal ? { signal } : {}),
    })).stdout
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
    const newline = record.indexOf("\n")
    const file = origin.startsWith("file:") ? resolve(directory, origin.slice("file:".length)) : undefined
    const key = newline === -1 ? record : record.slice(0, newline)
    const value = newline === -1 ? undefined : record.slice(newline + 1)
    refuseFilterSettingGitStopsOn(scope, key, value)
    if (value !== undefined) settings.push({ scope, key, value, origin: file })
    // A driver's `required` written alone is boolean true. Another key with
    // no value starts no program: Git LFS stops on it before running anything.
    else if (/^filter\..+\.required$/u.test(key)) settings.push({ scope, key, value: "true", origin: file })
  }
  return settings
}

// Refuses, naming the key, a filter or Git LFS setting Domovoi does not run
// past: one from a scope it does not know, a filter driver, Git LFS
// extension or custom transfer with an empty name (ruling Q319), a filter
// command written with no value, or a required that is not a Git boolean.
// The last two are errors Git stops on, whatever scope sets them (ruling
// Q318); dropping one would let a Git directory that reads less config, the
// isolated one, run an inherited command ordinary Git refuses over. `value`
// undefined is a key written with no value.
export function refuseFilterSettingGitStopsOn(scope: string, key: string, value: string | undefined): void {
  if (!trustedConfigScopes.has(scope) && !repositoryScopes.has(scope)) throw new RepositoryGitConfigUnreadableError("git-failed")
  if (emptyNamedDriverKey.test(key)) {
    throw new RepositoryGitConfigUnreadableError("git-failed", { detail: `${shownKey(key)} in ${scope} Git config names a filter driver with an empty name, which Domovoi does not run` })
  }
  // A Git LFS extension, custom transfer or standalone agent key with no value
  // stops git-lfs; it refuses here too, so no copy of the config writes it as
  // a value (ruling Q319).
  if (value === undefined && (filterCommandKey.test(key) || /^lfs\.(?:extension\.|customtransfer\.|(?:.+\.)?standalonetransferagent$)/iu.test(key))) {
    throw new RepositoryGitConfigUnreadableError("git-failed", { detail: `${shownKey(key)} in ${scope} Git config has no value` })
  }
  if (value !== undefined && /^filter\..+\.required$/u.test(key) && gitRequiredState(value) === undefined) {
    throw new RepositoryGitConfigUnreadableError("git-failed", { detail: `${shownKey(key)} in ${scope} Git config is not a boolean` })
  }
}

// A key of a filter driver, Git LFS extension or custom transfer named by an
// empty subsection (`[filter ""]`, printed filter..clean), which Git accepts.
// Domovoi refuses such a config rather than follow the empty name through
// every check that matches a driver by name (ruling Q319).
export const emptyNamedDriverKey = /^(?:filter\.\.|lfs\.(?:extension|customtransfer)\.\.)/iu

// A filter driver's command keys, as `git config` prints them.
export const filterCommandKey = /^filter\..+\.(?:clean|smudge|process)$/u

// A config key as a refusal shows it: the repository's own text, which can
// hold a credential, so redacted as the tool inventory shows text.
const shownKey = (key: string) => redactInventoryText(key, inventoryFieldCaps.detail)

// A driver's filter.<driver>.required as Git reads a boolean: true, yes and
// on, in any case, or a nonzero integer, are true; false, no, off, the empty
// value and 0 are false; no value at all is unset. Git refuses any other
// text, and so does this: undefined (rulings Q265, Q318).
export function gitRequiredState(value: string | undefined): "true" | "false" | "unset" | undefined {
  if (value === undefined) return "unset"
  const lower = value.toLowerCase()
  if (lower === "true" || lower === "yes" || lower === "on") return "true"
  if (lower === "false" || lower === "no" || lower === "off" || lower === "") return "false"
  const number = gitConfigInt(value)
  return number === undefined ? undefined : number === 0n ? "false" : "true"
}

const gitIntMinimum = -(2n ** 31n)
const gitIntMaximum = 2n ** 31n - 1n
const gitUnitFactors: Readonly<Record<string, bigint>> = { "": 1n, k: 1024n, m: 1024n ** 2n, g: 1024n ** 3n }

// An int as Git's config reads one (git_parse_signed): strtoimax in base 0
// after leading white space (an optional sign, then 0x and hex digits, a
// leading 0 and octal digits, or decimal digits), then nothing or exactly one
// k, m or g in either case, and the product within a C int. Checked against
// `git config --bool` at the edges: 09, 018, 2147483648 and 2g are refused,
// -2147483648 and -2097152k read.
function gitConfigInt(value: string): bigint | undefined {
  const match = /^[ \t\n\v\f\r]*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)(.*)$/su.exec(value)
  if (match === null) return undefined
  const [, sign, digits, unit] = match as unknown as [string, string, string, string]
  const factor = gitUnitFactors[unit.toLowerCase()]
  if (factor === undefined || unit.length > 1) return undefined
  const magnitude = /^0[xX]/u.test(digits) ? BigInt(digits) : digits.length > 1 && digits.startsWith("0") ? BigInt(`0o${digits.slice(1)}`) : BigInt(digits)
  const product = (sign === "-" ? -magnitude : magnitude) * factor
  return product < gitIntMinimum || product > gitIntMaximum ? undefined : product
}
