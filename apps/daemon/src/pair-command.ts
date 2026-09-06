import { clientKindSchema, devicePairResultSchema, deviceRenameLabelSchema, type ClientKind, type DeviceIssueCodeResult, type DevicePairResult } from "@getdomovoi/protocol"

import { CliDeadlineError } from "./cli-rpc.js"
import { pairingCodeTtlMs } from "./pairing-codes.js"

export type PairCommandDependencies = {
  issue: () => Promise<DeviceIssueCodeResult>
  grantClient: (input: { targetClient: ClientKind; label: string }) => Promise<DevicePairResult>
  stdout: (text: string) => void
  stderr: (text: string) => void
}

const usage = "Usage: domovoid pair\n       domovoid pair --client <desktop|web|tablet|phone|cli> --label <device label>\n"

export async function runPairCommand(
  args: readonly string[],
  dependencies: PairCommandDependencies,
): Promise<number> {
  if (args[0] !== "pair") return 1
  if (args.length === 5 && args[1] === "--client" && args[3] === "--label") {
    const client = clientKindSchema.safeParse(args[2])
    const label = deviceRenameLabelSchema.safeParse(args[4])
    if (!client.success || !label.success) { dependencies.stderr(usage); return 1 }
    try {
      const granted = devicePairResultSchema.parse(await dependencies.grantClient({ targetClient: client.data, label: label.data }))
      if (granted.device.binding.kind !== "client" || granted.device.binding.client !== client.data) {
        throw new Error("The daemon returned a different credential kind")
      }
      dependencies.stdout(`This ${client.data} credential grants session sends, approvals and terminals.\n`)
      dependencies.stdout("It cannot manage paired devices or enroll more machines. Keep it private.\n")
      dependencies.stdout(`Client credential: ${granted.token}\n`)
      dependencies.stdout(`Enter it under Authorize this client on the enrolled machine's Fleet row.\n`)
      dependencies.stdout(`Revoke device ${granted.device.id} in this daemon's Devices list when it is no longer needed.\n`)
      return 0
    } catch (error) {
      dependencies.stderr(error instanceof CliDeadlineError ? `${error.message}\n`
        : "Could not grant a client credential. Use this daemon's own credential and an updated daemon. Check its Devices list before retrying if the reply was lost.\n")
      return 1
    }
  }
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
