import { devicePairResultSchema, type DevicePairResult, type RpcParams } from "@getdomovoi/protocol"

import { isLoopbackEndpoint } from "./transport-dial.js"

export class MachineClaimError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MachineClaimError"
  }
}

export type ClaimConnection = {
  // Typed against the protocol so a parameter the daemon requires cannot go
  // missing here and fail only against a running machine.
  call: <Method extends "device.claim">(
    method: Method,
    params: RpcParams<Method>,
  ) => Promise<unknown>
  close: () => void
}

export async function claimMachine(input: {
  endpoint: string
  code: string
  label: string
  machineId: string
  open: (endpoint: string) => Promise<ClaimConnection>
}): Promise<DevicePairResult> {
  // Parsed rather than prefix-matched, so an address with no machine behind it
  // never reaches the network layer.
  let endpoint: URL
  try {
    endpoint = new URL(input.endpoint)
  } catch {
    throw new MachineClaimError("A machine endpoint must be a WebSocket URL")
  }
  if (!["ws:", "wss:"].includes(endpoint.protocol) || !endpoint.hostname) {
    throw new MachineClaimError("A machine endpoint must be a WebSocket URL")
  }
  // A pairing code is a credential in its own right for the few minutes it
  // lives, so it never crosses a network in the clear.
  if (endpoint.protocol === "ws:" && !isLoopbackEndpoint(input.endpoint)) {
    throw new MachineClaimError("Refusing to send a pairing code over an unencrypted connection")
  }

  const connection = await input.open(input.endpoint)
  let claimed: unknown
  try {
    claimed = await connection.call("device.claim", {
      code: input.code,
      label: input.label,
      // The credential is bound to this machine at enrolment, so a paired token
      // cannot later present as a different machine or as a person's client.
      machineId: input.machineId,
    })
  } catch (error) {
    // The daemon's own refusal is kept, but nothing else: a transport error can
    // quote the request, and the request carries the code.
    const message = error instanceof Error && error.message.includes(input.code)
      ? "Pairing was refused"
      : error instanceof Error ? error.message : "Pairing was refused"
    throw new MachineClaimError(message)
  } finally {
    connection.close()
  }

  const described = devicePairResultSchema.safeParse(claimed)
  if (!described.success) throw new MachineClaimError("The machine returned an undescribed pairing")
  return described.data
}
