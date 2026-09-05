import type { DeviceIssueCodeResult } from "@getdomovoi/protocol"

import { CliDeadlineError } from "./cli-rpc.js"
import { pairingCodeTtlMs } from "./pairing-codes.js"

export type PairCommandDependencies = {
  issue: () => Promise<DeviceIssueCodeResult>
  stdout: (text: string) => void
  stderr: (text: string) => void
}

const usage = "Usage: domovoid pair\n"

export async function runPairCommand(
  args: readonly string[],
  dependencies: PairCommandDependencies,
): Promise<number> {
  if (args[0] !== "pair") return 1
  if (args.length > 1) {
    dependencies.stderr(usage)
    return 1
  }

  let issued: DeviceIssueCodeResult
  try {
    issued = await dependencies.issue()
  } catch (error) {
    // Pairing is the first command a new machine runs, so a daemon that never
    // answers has to say which address was waited on and what to do next. Only
    // this CLI's own deadline refusal is repeated: any other error can quote
    // the request, and this command runs where someone may be reading the
    // screen aloud.
    dependencies.stderr(error instanceof CliDeadlineError
      ? `${error.message}\n`
      : "Could not ask the daemon for a pairing code\n")
    return 1
  }

  const minutes = Math.round(pairingCodeTtlMs / 60_000)
  dependencies.stdout(`\nPairing code: ${issued.code}\n`)
  dependencies.stdout(`Enter it on the machine you are pairing from.\n`)
  dependencies.stdout(`It works once and lasts ${minutes} minutes.\n\n`)
  return 0
}
