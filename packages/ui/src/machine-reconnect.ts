import { daemonAuthenticationErrorCode } from "@getdomovoi/protocol"

import { DaemonRpcError } from "./client.js"

export const defaultMachineReconnectAttempts = 5
export const defaultMachineReconnectDelayMs = 500
export const defaultMaximumMachineReconnectDelayMs = 15_000

export class MachineReconnectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MachineReconnectError"
  }
}

// A machine that refuses the credential has revoked this device, and retrying
// only keeps presenting a credential that will never be accepted again.
function refusesCredential(error: unknown): boolean {
  return error instanceof DaemonRpcError && error.code === daemonAuthenticationErrorCode
}

export async function reconnectMachine<Connection>(input: {
  connect: () => Promise<Connection>
  wait: (ms: number) => Promise<void>
  attempts?: number
  initialDelayMs?: number
  maximumDelayMs?: number
}): Promise<Connection> {
  const attempts = input.attempts ?? defaultMachineReconnectAttempts
  const initialDelayMs = input.initialDelayMs ?? defaultMachineReconnectDelayMs
  const maximumDelayMs = input.maximumDelayMs ?? defaultMaximumMachineReconnectDelayMs

  let delayMs = initialDelayMs
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await input.connect()
    } catch (error) {
      if (refusesCredential(error)) {
        throw new MachineReconnectError("That machine no longer accepts this device")
      }
      // The failure text is not carried: a transport error can quote the
      // request that produced it, credential included.
      if (attempt === attempts) break
      await input.wait(delayMs)
      delayMs = Math.min(delayMs * 2, maximumDelayMs)
    }
  }

  throw new MachineReconnectError("That machine could not be reached again")
}
