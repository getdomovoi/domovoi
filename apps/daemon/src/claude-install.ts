import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { basename, extname } from "node:path"
import { promisify } from "node:util"

import { resolveCommandPathSync } from "./tool-path.js"

// The Claude Agent SDK passes the flags of the Claude Code it was built
// against, which its package.json names as `claudeCodeVersion` (2.1.263 for
// SDK 0.3.263). An older claude can reject them, so that is the floor. A test
// compares this with the installed SDK's package.json, so an SDK bump that
// leaves it behind fails.
export const claudeMinimumVersion = "2.1.263"

const notInstalled = "Claude Code is not installed: no claude executable was found on the tool PATH"

function shimProblem(path: string): string {
  return `Claude Code at ${path} is a script shim, which the Claude Agent SDK cannot start without a shell. Install the native claude.exe and put it on PATH.`
}

// The SDK spawns the executable directly, without a shell. On Windows only the
// native claude.exe starts that way; the npm `claude` sh shim and claude.cmd
// fail with a raw spawn error, so they are refused with the path found.
export function resolveClaudeSdkExecutable(
  path: string,
  platform: NodeJS.Platform,
): { executable: string } | { problem: string } {
  if (platform === "win32") {
    const native = resolveCommandPathSync("claude.exe", path, platform)
    if (native !== undefined) return { executable: native }
    const shim = resolveCommandPathSync("claude", path, platform)
    return { problem: shim === undefined ? notInstalled : shimProblem(shim) }
  }
  const executable = resolveCommandPathSync("claude", path, platform)
  return executable === undefined ? { problem: notInstalled } : { executable }
}

// Only a resolved script is a shim: a .cmd, .bat or .ps1, or a path with no
// extension (the npm sh shim). A bare name, as a probe with no PATH runs it, is
// started by Windows as claude.exe.
function windowsShim(command: string): boolean {
  const normal = command.replaceAll("\\", "/")
  const extension = extname(basename(normal)).toLowerCase()
  if ([".cmd", ".bat", ".ps1"].includes(extension)) return true
  return extension === "" && normal.includes("/")
}

export function claudeInstallProblem(input: {
  command: string
  version: string | undefined
  platform: NodeJS.Platform
}): string | undefined {
  if (input.platform === "win32" && windowsShim(input.command)) return shimProblem(input.command)
  if (input.version !== undefined && compareVersions(input.version, claudeMinimumVersion) < 0) {
    return `Update Claude Code to ${claudeMinimumVersion} or newer. The claude on this machine is ${input.version}.`
  }
  return undefined
}

export function parseClaudeVersion(output: string): string | undefined {
  return output.match(/\b\d+(?:\.\d+){1,3}\b/)?.[0]
}

// The version of an executable the SDK is about to start, read once per path
// and modification time, so an update is seen without a daemon restart. It is
// read without blocking the event loop: a claude slow to answer must not stop
// every client, terminal and approval meanwhile.
const versions = new Map<string, Promise<string | undefined>>()
const execFileAsync = promisify(execFile)

export async function installedClaudeVersion(executable: string): Promise<string | undefined> {
  let key: string
  try {
    key = `${executable}\0${(await stat(executable)).mtimeMs}`
  } catch {
    return undefined
  }
  let version = versions.get(key)
  if (version === undefined) {
    version = execFileAsync(executable, ["--version"], { encoding: "utf8", timeout: 5_000 }).then(
      ({ stdout }) => parseClaudeVersion(stdout),
      () => undefined,
    )
    versions.set(key, version)
  }
  return version
}

// Everything the SDK needs from this machine before a query starts: the
// executable it can start, at a version it can drive. Run before the query
// factory, which is synchronous.
export async function checkClaudeInstall(path: string, platform: NodeJS.Platform): Promise<void> {
  const resolved = resolveClaudeSdkExecutable(path, platform)
  if ("problem" in resolved) throw new Error(resolved.problem)
  const problem = claudeInstallProblem({
    command: resolved.executable,
    version: await installedClaudeVersion(resolved.executable),
    platform,
  })
  if (problem !== undefined) throw new Error(problem)
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0)
  const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}
