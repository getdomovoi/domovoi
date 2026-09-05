import { parseWslDistributions, type WslDistribution } from "./wsl-distributions.js"
import {
  classifyWslFailure,
  firstSaid,
  runWslBytes,
  withWslDeadline,
  WslError,
  wslSeconds,
  wslText,
  wslTimeoutMs,
  type WslCallFailure,
  type WslRunner,
} from "./wsl-run.js"

export type WslListInput = {
  run?: WslRunner<Buffer>
  platform?: NodeJS.Platform
  timeoutMs?: number
}

const listingCommand = "\"wsl.exe --list --verbose\""

// wsl.exe answers a machine with no distribution by saying so, with an exit
// status that would otherwise read as a failure. Newer builds add an error
// code that survives translation. A header with no rows is the same answer.
const noDistributions = /no installed distributions|WSL_E_DEFAULT_DISTRO_NOT_FOUND/i
const listingHeader = /\bNAME\b.*\bSTATE\b.*\bVERSION\b/i

function saidNoDistributions(error: unknown): boolean {
  const failure = error as { stdout?: unknown; stderr?: unknown }
  return noDistributions.test(`${wslText(failure.stdout)}\n${wslText(failure.stderr)}`)
}

function listingFailure(failure: WslCallFailure, timeoutMs: number): WslError {
  switch (failure.kind) {
    case "absent":
      return new WslError(
        "absent",
        `WSL is not installed on this machine (${failure.detail}), so there is no distribution to list. Install it with "wsl.exe --install" and try again.`,
      )
    case "denied":
      return new WslError(
        "denied",
        `wsl.exe denied ${listingCommand}: ${failure.detail}. Run domovoid from a session that is allowed to run wsl.exe and try again.`,
      )
    case "timed-out":
      return new WslError(
        "timed-out",
        `wsl.exe did not answer ${listingCommand} within ${wslSeconds(timeoutMs)}, so the distributions on this machine are unknown. Check "wsl.exe --status" and try again.`,
      )
    case "unavailable":
      return new WslError(
        "unavailable",
        `wsl.exe could not list the distributions on this machine: ${failure.detail}. Check "wsl.exe --status" and try again.`,
      )
  }
}

// Only Windows has a wsl.exe to ask. A machine with WSL and no distribution
// answers with an empty listing. Anything else wsl.exe cannot answer is
// reported as what it was, since "no distribution" would send whoever asked
// to install one they may already have.
export async function listWslDistributions(input: WslListInput = {}): Promise<WslDistribution[]> {
  const platform = input.platform ?? process.platform
  if (platform !== "win32") return []

  const run = input.run ?? runWslBytes
  const timeoutMs = wslTimeoutMs(input.timeoutMs)
  let listing: Buffer
  try {
    listing = await withWslDeadline(
      run("wsl.exe", ["--list", "--verbose"], { timeoutMs }),
      timeoutMs,
    )
  } catch (error) {
    if (saidNoDistributions(error)) return []
    const failure = error as { stderr?: unknown; stdout?: unknown }
    throw listingFailure(classifyWslFailure(error, firstSaid(failure.stderr, failure.stdout)), timeoutMs)
  }

  const distributions = parseWslDistributions(listing)
  if (distributions.length > 0) return distributions
  const text = wslText(listing)
  if (noDistributions.test(text) || listingHeader.test(text.split(/\r?\n/)[0] ?? "")) return []
  throw new WslError(
    "corrupt",
    `wsl.exe answered ${listingCommand} with something other than a distribution listing, so the distributions on this machine are unknown. Run ${listingCommand} yourself to see what it prints.`,
  )
}
