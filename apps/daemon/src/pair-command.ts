import { clientKindSchema, deviceRenameLabelSchema, encodePairingPayload, pairingAddressSchema, phoneAndTabletPromise, type ClientKind, type DeviceIssueCodeResult } from "@getdomovoi/protocol"

import { CliDeadlineError } from "./cli-rpc.js"
import { pairingCodeTtlMs } from "./pairing-codes.js"

export type PairCommandDependencies = {
  // The daemon answers with the code and the address a scanned code tells a
  // device to dial, or why there is none; this command never guesses.
  issue: (targetClient?: ClientKind, label?: string) => Promise<DeviceIssueCodeResult>
  renderCode: (payload: string) => string
  stdout: (text: string) => void
  stderr: (text: string) => void
}

const usage = "Usage: domovoid pair\n       domovoid pair --client <desktop|web|tablet|phone|cli> [--label <suggested name>]\n\n--label is kept with the code as a suggested name for the device. The device's own name is the one used.\n"

export async function runPairCommand(
  args: readonly string[],
  dependencies: PairCommandDependencies,
): Promise<number> {
  if (args[0] !== "pair") return 1
  if (args[1] === "--client" && (args.length === 3 || (args.length === 5 && args[3] === "--label"))) {
    const client = clientKindSchema.safeParse(args[2])
    const label = args.length === 5 ? deviceRenameLabelSchema.safeParse(args[4]) : undefined
    if (!client.success || (label !== undefined && !label.success)) { dependencies.stderr(usage); return 1 }
    let issued: DeviceIssueCodeResult
    try {
      issued = label === undefined
        ? await dependencies.issue(client.data)
        : await dependencies.issue(client.data, label.data)
    } catch (error) {
      dependencies.stderr(error instanceof CliDeadlineError ? `${error.message}\n`
        : label === undefined
          ? "Could not ask the daemon for a pairing code. Use this daemon's own credential and an updated daemon.\n"
          : "Could not ask the daemon for a pairing code. A daemon older than this command refuses --label, so if this daemon is older, update and restart it, or run this again without --label. Otherwise check that the daemon is running and that this command uses its own credential.\n")
      return 1
    }

    if (client.data === "phone" || client.data === "tablet") {
      // The machine's pairing card, in a terminal. A line the daemon does not
      // yet keep is marked rather than dropped, so a headless machine and a
      // desktop say the same thing about the device being paired.
      dependencies.stdout(`A paired ${client.data} can:\n`)
      for (const line of phoneAndTabletPromise) {
        dependencies.stdout(`  ${line.tone === "unbuilt" ? "!" : line.tone === "limit" ? "-" : "+"} ${line.text}\n`)
      }
      dependencies.stdout("\n")
    }

    // A daemon older than this command answers with the code alone. Say so,
    // rather than drawing a symbol with no address a device could dial.
    const named = pairingAddressSchema.safeParse((issued as { pairingAddress?: unknown }).pairingAddress)
    if (!named.success) {
      dependencies.stdout(`Pairing code: ${issued.code}\n`)
      dependencies.stderr("This daemon does not say which address a device should dial, so no symbol was drawn. Update the daemon to match this command, then run this again.\n")
      return 1
    }
    const address = named.data
    if ("problem" in address) {
      // A symbol carrying an address the device cannot verify fails at TLS
      // with nothing to read, so say what is missing instead of drawing one.
      dependencies.stdout(`Pairing code: ${issued.code}\n`)
      dependencies.stderr(`${address.problem}\n`)
      return 1
    }
    if (client.data === "web") {
      // The browser connect page reads the word code, not a pairing payload.
      dependencies.stdout(`Web code: ${issued.code}\n\n`)
      dependencies.stdout(issued.webAppUrl === undefined
        ? "Open Domovoi in the browser on that device and type the code.\n"
        : `Open this address in the browser on that device, then type the code:\n  ${issued.webAppUrl}\n`)
    } else {
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
    }
    const minutes = Math.round(pairingCodeTtlMs / 60_000)
    dependencies.stdout(`\nIt works once, and only for a ${client.data === "web" ? "web browser" : client.data}. Showing it again pairs nothing.\n`)
    // Standing next to a phone, the two things worth knowing are how long this
    // has and that running the command again is free. Without the second line
    // a code that dies mid-scan reads as a dead end.
    dependencies.stdout(`It lasts ${minutes} minutes. Run this again for a fresh one, which stops the old code.\n`)
    if (address.loopback) {
      dependencies.stdout(`This daemon answers on ${address.url}, which only this machine can reach. ${client.data === "web" ? "A browser on another device" : "A phone on your network"} needs the daemon on an address it can dial.\n`)
    }
    dependencies.stdout("The device appears in this daemon's Devices list once it pairs. Revoke it there when it is no longer needed.\n")
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
