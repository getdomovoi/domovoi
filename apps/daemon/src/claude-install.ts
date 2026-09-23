import { execFileSync } from "node:child_process"
import { statSync } from "node:fs"
import { basename } from "node:path"

import { resolveCommandPathSync } from "./tool-path.js"

// The Claude Agent SDK passes the flags of the Claude Code it was built
// against, which its package.json names as `claudeCodeVersion` (2.1.263 for
// SDK 0.3.263). An older claude can reject them, so that is the floor.
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

export function claudeInstallProblem(input: {
  command: string
  version: string | undefined
  platform: NodeJS.Platform
}): string | undefined {
  if (input.platform === "win32" && basename(input.command.replaceAll("\\", "/")).toLowerCase() !== "claude.exe") {
    return shimProblem(input.command)
  }
  if (input.version !== undefined && compareVersions(input.version, claudeMinimumVersion) < 0) {
    return `Update Claude Code to ${claudeMinimumVersion} or newer. The claude on this machine is ${input.version}.`
  }
  return undefined
}

export function parseClaudeVersion(output: string): string | undefined {
  return output.match(/\b\d+(?:\.\d+){1,3}\b/)?.[0]
}

// The version of an executable the SDK is about to start, read once per path
// and modification time, so an update is seen without a daemon restart.
const versions = new Map<string, string | undefined>()

export function installedClaudeVersion(executable: string): string | undefined {
  let key: string
  try {
    key = `${executable}\0${statSync(executable).mtimeMs}`
  } catch {
    return undefined
  }
  if (versions.has(key)) return versions.get(key)
  let version: string | undefined
  try {
    version = parseClaudeVersion(execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 5_000 }))
  } catch {
    version = undefined
  }
  versions.set(key, version)
  return version
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
