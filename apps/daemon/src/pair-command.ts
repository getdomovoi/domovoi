import type { DeviceIssueCodeResult } from "@getdomovoi/protocol"

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
  } catch {
    // The underlying error is not printed: it can quote the request, and this
    // command runs where someone may be reading the screen aloud.
    dependencies.stderr("Could not ask the daemon for a pairing code\n")
    return 1
  }

  const minutes = Math.round(pairingCodeTtlMs / 60_000)
  dependencies.stdout(`\nPairing code: ${issued.code}\n`)
  dependencies.stdout(`Enter it on the machine you are pairing from.\n`)
  dependencies.stdout(`It works once and lasts ${minutes} minutes.\n\n`)
  return 0
}
