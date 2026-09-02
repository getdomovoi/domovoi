import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { parseWslDistributions, wslDaemonTargets, type WslDaemonTarget } from "./wsl-distributions.js"

const execute = promisify(execFile)

export type WslListInput = {
  run?: (command: string, args: readonly string[], options: { timeoutMs: number }) => Promise<Buffer>
  platform?: NodeJS.Platform
  timeoutMs?: number
}

// wsl.exe talks to a service that can be starting, stopping, or wedged, and a
// listing that never comes back would hold up whatever asked for it.
const defaultTimeoutMs = 10_000

async function runWsl(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number },
): Promise<Buffer> {
  const { stdout } = await execute(command, [...args], {
    encoding: "buffer",
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
  })
  return stdout
}

function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("wsl.exe did not answer in time")), timeoutMs)
    work.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

// Only Windows has a wsl.exe to ask, and a machine with no WSL installed
// answers with a failure rather than an empty listing. Neither is an error
// worth stopping for: it just means there is no distribution to offer.
export async function listWslDistributions(input: WslListInput = {}): Promise<WslDaemonTarget[]> {
  const platform = input.platform ?? process.platform
  if (platform !== "win32") return []

  const run = input.run ?? runWsl
  // A timeout of zero or less would leave the child with no deadline at all,
  // which is the opposite of what asking for one means.
  const requested = input.timeoutMs ?? defaultTimeoutMs
  const timeoutMs = Number.isFinite(requested) && requested > 0 ? requested : defaultTimeoutMs
  try {
    const listing = await withDeadline(
      run("wsl.exe", ["--list", "--verbose"], { timeoutMs }),
      timeoutMs,
    )
    return wslDaemonTargets(parseWslDistributions(listing))
  } catch {
    return []
  }
}
