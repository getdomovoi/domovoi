import { parseWslDistributions, type WslDistribution } from "./wsl-distributions.js"
import { runWslBytes, withWslDeadline, wslTimeoutMs, type WslRunner } from "./wsl-run.js"

export type WslListInput = {
  run?: WslRunner<Buffer>
  platform?: NodeJS.Platform
  timeoutMs?: number
}

// Only Windows has a wsl.exe to ask, and a machine with no WSL installed
// answers with a failure rather than an empty listing. Neither is an error
// worth stopping for: it just means there is no distribution to offer.
export async function listWslDistributions(input: WslListInput = {}): Promise<WslDistribution[]> {
  const platform = input.platform ?? process.platform
  if (platform !== "win32") return []

  const run = input.run ?? runWslBytes
  const timeoutMs = wslTimeoutMs(input.timeoutMs)
  try {
    const listing = await withWslDeadline(
      run("wsl.exe", ["--list", "--verbose"], { timeoutMs }),
      timeoutMs,
    )
    return parseWslDistributions(listing)
  } catch {
    return []
  }
}
