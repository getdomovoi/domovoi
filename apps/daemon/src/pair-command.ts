import { clientKindSchema, deviceRenameLabelSchema, encodePairingPayload, phoneAndTabletPromise, phoneAndTabletPromiseGap, type ClientKind, type DeviceIssueCodeResult } from "@getdomovoi/protocol"

import { CliDeadlineError } from "./cli-rpc.js"
import type { PairingAddress, PairingAddressProblem } from "./pairing-address.js"
import { pairingCodeTtlMs } from "./pairing-codes.js"

export type PairCommandDependencies = {
  issue: (targetClient?: ClientKind) => Promise<DeviceIssueCodeResult>
  // The address a scanned code tells a device to dial, or why there is none.
  pairingAddress: () => PairingAddress | PairingAddressProblem
  renderCode: (payload: string) => string
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
    let issued: DeviceIssueCodeResult
    try {
      issued = await dependencies.issue(client.data)
    } catch (error) {
      dependencies.stderr(error instanceof CliDeadlineError ? `${error.message}\n`
        : "Could not ask the daemon for a pairing code. Use this daemon's own credential and an updated daemon.\n")
      return 1
    }

    if (client.data === "phone" || client.data === "tablet") {
      // The same four lines the machine's pairing card shows, and the same
      // note about the one it does not keep yet, so a headless machine and a
      // desktop say the same thing about the device being paired.
      dependencies.stdout(`A paired ${client.data} can:\n`)
      for (const line of phoneAndTabletPromise) dependencies.stdout(`  ${line}\n`)
      dependencies.stdout(`${phoneAndTabletPromiseGap}\n\n`)
    }

    const address = dependencies.pairingAddress()
    if ("problem" in address) {
      // A symbol carrying an address the device cannot verify fails at TLS
      // with nothing to read, so say what is missing instead of drawing one.
      dependencies.stdout(`Pairing code: ${issued.code}\n`)
      dependencies.stderr(`${address.problem}\n`)
      return 1
    }
    const payload = encodePairingPayload({
      v: 1,
      url: address.url,
      code: issued.code,
      ...(address.label === undefined ? {} : { label: address.label }),
    })
    dependencies.stdout("Pairing code (scan it from the device):\n\n")
    dependencies.stdout(dependencies.renderCode(payload))
    // The same text the symbol carries, for a device whose camera is refused
    // or absent. It is what the device's paste field reads, so the two paths
    // are the same pairing and not one of them a different arrangement.
    dependencies.stdout(`\nCannot scan it? Paste this on the device:\n${payload}\n`)
    dependencies.stdout(`\nIt works once, and only for a ${client.data}. Showing it again pairs nothing.\n`)
    if (address.loopback) {
      dependencies.stdout(`This daemon answers on ${address.url}, which only this machine can reach. A phone on your network needs the daemon on an address it can dial.\n`)
    }
    dependencies.stdout(`The device appears in this daemon's Devices list once it pairs. Revoke it there when it is no longer needed.\n`)
    return 0
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
