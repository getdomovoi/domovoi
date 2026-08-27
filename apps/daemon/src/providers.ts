import { execFile } from "node:child_process"

import type { ProviderRuntime } from "@getdomovoi/protocol"

export type ProviderDetection = Omit<ProviderRuntime, "sessionCapable">

export type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type ProviderCommandRunner = (
  command: string,
  args: string[],
) => Promise<CommandResult>

export interface ProviderProbe {
  inspect(): Promise<ProviderDetection[]>
}

type ProviderDefinition = {
  id: string
  command: string
  authArgs?: string[]
  authStatus?: (result: CommandResult) => ProviderDetection["status"]
}

const definitions: ProviderDefinition[] = [
  {
    id: "claude-code",
    command: "claude",
    authArgs: ["auth", "status"],
    authStatus: claudeAuthStatus,
  },
  {
    id: "codex",
    command: "codex",
    authArgs: ["login", "status"],
    authStatus: textAuthStatus,
  },
  { id: "cursor-agent", command: "cursor-agent" },
  { id: "opencode", command: "opencode" },
  { id: "grok", command: "grok" },
  { id: "kilo", command: "kilo" },
]

export class CliProviderProbe implements ProviderProbe {
  readonly #run: ProviderCommandRunner

  constructor(run: ProviderCommandRunner = runProviderCommand) {
    this.#run = run
  }

  async inspect(): Promise<ProviderDetection[]> {
    return Promise.all(definitions.map((definition) => this.#inspect(definition)))
  }

  async #inspect(definition: ProviderDefinition): Promise<ProviderDetection> {
    let versionResult: CommandResult
    try {
      versionResult = await this.#run(definition.command, ["--version"])
    } catch (error) {
      if (isMissingCommand(error)) {
        return { id: definition.id, command: definition.command, status: "missing" }
      }
      return { id: definition.id, command: definition.command, status: "unknown" }
    }
    if (versionResult.exitCode !== 0) {
      return { id: definition.id, command: definition.command, status: "unknown" }
    }

    const version = parseVersion(`${versionResult.stdout}\n${versionResult.stderr}`)
    let status: ProviderDetection["status"] = "unknown"
    if (definition.authArgs && definition.authStatus) {
      try {
        status = definition.authStatus(await this.#run(definition.command, definition.authArgs))
      } catch {
        status = "unknown"
      }
    }
    return {
      id: definition.id,
      command: definition.command,
      status,
      ...(version ? { version } : {}),
    }
  }
}

export function runProviderCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 3_000, maxBuffer: 64 * 1_024 }, (error, stdout, stderr) => {
      if (error && "code" in error && error.code === "ENOENT") {
        reject(error)
        return
      }
      resolve({
        exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0,
        stdout,
        stderr,
      })
    })
  })
}

function parseVersion(output: string): string | undefined {
  return output.match(/\b\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0]
}

function claudeAuthStatus(result: CommandResult): ProviderDetection["status"] {
  try {
    const status = JSON.parse(result.stdout) as { loggedIn?: unknown }
    if (status.loggedIn === true) return "ready"
    if (status.loggedIn === false) return "auth-required"
  } catch {
    return textAuthStatus(result)
  }
  return textAuthStatus(result)
}

function textAuthStatus(result: CommandResult): ProviderDetection["status"] {
  const output = `${result.stdout}\n${result.stderr}`
  if (/not logged|login required|unauthenticated|token expired/i.test(output)) {
    return "auth-required"
  }
  if (/\blogged in\b|\bauthenticated\b/i.test(output)) return "ready"
  return "unknown"
}

function isMissingCommand(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
