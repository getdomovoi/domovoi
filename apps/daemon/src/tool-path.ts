import { accessSync } from "node:fs"
import { access, constants, mkdir, readFile, writeFile } from "node:fs/promises"
import { userInfo } from "node:os"
import { basename, delimiter as platformDelimiter, isAbsolute, join } from "node:path"

import { publishFileDurably } from "@getdomovoi/credential-store"

import type { CommandResult, ProviderCommandRunner } from "./providers.js"

// Domovoi's job is running other people's binaries, and an app launched from
// Finder, the Dock or a desktop entry inherits a PATH with none of them on it
// (macOS gives /usr/bin:/bin:/usr/sbin:/sbin). The daemon resolves the tool
// PATH once at startup: the person's override, then what their login shell
// says, then what the launcher gave. The result is written next to the
// profile so Settings can name the path each harness was found at and a
// person with an unusual setup can correct it.

export const toolPathFileName = "tools.json"

export const toolPathOverrideVariable = "DOMOVOI_TOOL_PATH"

export type ToolPathRecord = {
  version: 1
  resolvedAt: string
  launchPath: string
  loginShellPath?: string
  override?: string
  path: string
}

export type ResolvedToolPath = {
  path: string
  launchPath: string
  loginShellPath: string | undefined
  override: string | undefined
}

export function mergeToolPath(input: {
  override?: string | undefined
  loginShell?: string | undefined
  launch: string
  delimiter: string
}): string {
  const seen = new Set<string>()
  const entries: string[] = []
  for (const source of [input.override, input.loginShell, input.launch]) {
    for (const entry of (source ?? "").split(input.delimiter)) {
      if (!entry || seen.has(entry)) continue
      seen.add(entry)
      entries.push(entry)
    }
  }
  return entries.join(input.delimiter)
}

// A login shell (-l) sources the profile where Homebrew, nvm and friends add
// themselves; an interactive shell (-i) would also run rc files that may
// prompt or print, which is why it is not asked. fish spells PATH as a list.
export function loginShellPathCommand(shell: string): [string, string[]] {
  if (basename(shell) === "fish") return [shell, ["-l", "-c", "string join ':' $PATH"]]
  return [shell, ["-l", "-c", "printf '%s' \"$PATH\""]]
}

export async function readLoginShellPath(input: {
  shell: string | undefined
  platform: NodeJS.Platform
  run: ProviderCommandRunner
  signal?: AbortSignal
}): Promise<string | undefined> {
  // Windows apps inherit the user PATH from the registry, so there is nothing
  // a login shell knows that the launcher did not.
  if (input.platform === "win32" || !input.shell) return undefined
  let result: CommandResult
  try {
    const [command, args] = loginShellPathCommand(input.shell)
    result = await input.run(command, args, input.signal)
  } catch {
    return undefined
  }
  if (result.exitCode !== 0) return undefined
  const path = result.stdout.trim()
  return path ? path : undefined
}

function commandCandidates(command: string, path: string, platform: NodeJS.Platform): string[] {
  if (isAbsolute(command)) return [command]
  const delimiter = platform === "win32" ? ";" : ":"
  const extensions = platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""]
  return path.split(delimiter)
    .filter((directory) => directory !== "")
    .flatMap((directory) => extensions.map((extension) => join(directory, `${command}${extension}`)))
}

export async function resolveCommandPath(
  command: string,
  path: string,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  for (const candidate of commandCandidates(command, path, platform)) {
    if (await executable(candidate)) return candidate
  }
  return undefined
}

export function resolveCommandPathSync(
  command: string,
  path: string,
  platform: NodeJS.Platform,
): string | undefined {
  return commandCandidates(command, path, platform).find(executableSync)
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function executableSync(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function resolveToolPath(input: {
  environment: Record<string, string | undefined>
  platform: NodeJS.Platform
  profileDirectory: string
  run: ProviderCommandRunner
  now?: () => Date
  signal?: AbortSignal
}): Promise<ResolvedToolPath> {
  const delimiter = input.platform === "win32" ? ";" : platformDelimiter
  // A supervised daemon's environment is the service record, which carries
  // no PATH or SHELL; the process itself still has the supervisor's PATH, and
  // the account's login shell is on record even when no shell exported it.
  const launchPath = input.environment.PATH ?? input.environment.Path ?? process.env.PATH ?? ""
  const shell = input.environment.SHELL ?? process.env.SHELL ?? accountShell()
  const recordPath = join(input.profileDirectory, toolPathFileName)
  const override = input.environment[toolPathOverrideVariable]?.trim() || (await readOverride(recordPath))
  const loginShellPath = await readLoginShellPath({
    shell,
    platform: input.platform,
    run: input.run,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  const path = mergeToolPath({ override, loginShell: loginShellPath, launch: launchPath, delimiter })
  const record: ToolPathRecord = {
    version: 1,
    resolvedAt: (input.now ?? (() => new Date()))().toISOString(),
    launchPath,
    ...(loginShellPath ? { loginShellPath } : {}),
    ...(override ? { override } : {}),
    path,
  }
  // Staged and renamed over, so a reader sees one whole record or the other.
  await mkdir(input.profileDirectory, { recursive: true })
  const staging = `${recordPath}.${process.pid}.tmp`
  await writeFile(staging, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  await publishFileDurably(staging, recordPath)
  return { path, launchPath, loginShellPath, override }
}

function accountShell(): string | undefined {
  try {
    const shell = userInfo().shell
    return shell ? shell : undefined
  } catch {
    return undefined
  }
}

// Only the override survives from an existing record: everything else is
// re-derived at every start, because the launcher's PATH is the fact being
// corrected.
async function readOverride(recordPath: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(recordPath, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return undefined
    const override = (parsed as { override?: unknown }).override
    return typeof override === "string" && override.trim() ? override.trim() : undefined
  } catch {
    return undefined
  }
}
