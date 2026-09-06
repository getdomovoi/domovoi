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
// Match a complete report line, not those words embedded in a distribution
// name or malformed row whose header could also be damaged.
const noDistributions = /^\s*(?:Windows Subsystem for Linux has no installed distributions\.?|(?:Error code:\s*)?(?:Wsl\/(?:\w+\/)*)?WSL_E_DEFAULT_DISTRO_NOT_FOUND)\s*$/im

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

  const result = parseWslDistributions(listing)
  if (result.kind === "listed") return result.distributions
  // An explicit no-distributions answer has no table header. Once a header
  // exists, every nonblank row must parse, even one containing an error code
  // or an absence phrase that would otherwise hide the corruption.
  if (result.reason === "header" && noDistributions.test(wslText(listing))) return []
  throw new WslError(
    "corrupt",
    `wsl.exe answered ${listingCommand} with a corrupt distribution listing at line ${result.line}, so the distributions on this machine are unknown. Run ${listingCommand} yourself to inspect its output and check "wsl.exe --status" before trying again.`,
  )
}
