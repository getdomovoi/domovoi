import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { parseWslDistributions, wslDaemonTargets, type WslDaemonTarget } from "./wsl-distributions.js"

const execute = promisify(execFile)

export type WslListInput = {
  run?: (command: string, args: readonly string[]) => Promise<Buffer>
  platform?: NodeJS.Platform
}

async function runWsl(command: string, args: readonly string[]): Promise<Buffer> {
  const { stdout } = await execute(command, [...args], { encoding: "buffer" })
  return stdout
}

// Only Windows has a wsl.exe to ask, and a machine with no WSL installed
// answers with a failure rather than an empty listing. Neither is an error
// worth stopping for: it just means there is no distribution to offer.
export async function listWslDistributions(input: WslListInput = {}): Promise<WslDaemonTarget[]> {
  const platform = input.platform ?? process.platform
  if (platform !== "win32") return []

  const run = input.run ?? runWsl
  try {
    return wslDaemonTargets(parseWslDistributions(await run("wsl.exe", ["--list", "--verbose"])))
  } catch {
    return []
  }
}
