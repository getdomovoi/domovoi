import { transportCandidateSchema, type TransportCandidate } from "@getdomovoi/protocol"

import type { MachineConnection } from "./machine-dial.js"
import { MachineDescriptorError, MachineIdentityMismatchError, MachinePairingRequiredError, MachineProtocolMismatchError } from "./machine-socket.js"
import { beforeDeadline, OperationDeadline, OperationDeadlineExceededError } from "./operation-deadline.js"
import { wslDaemonEndpointUrl } from "./wsl-discovery.js"
import { readDistroEndpoint } from "./wsl-endpoint.js"
import { listWslDistributions } from "./wsl-list.js"
import { assertDistributionName, runWslBytes, runWslText, WslError, type WslFailureKind } from "./wsl-run.js"

export class WslTransportError extends Error {
  constructor(readonly distribution: string,
    readonly reason: WslFailureKind | "stopped" | "wsl1" | "daemon-absent" | "unreachable") {
    super(`WSL route for ${distribution} refused (${reason}). Start this WSL 2 distribution and domovoid inside it, then check its pairing and try again.`)
    this.name = "WslTransportError"
  }
}

export type WslTransportConnection = MachineConnection & {
  routeSource: "wsl"
  endpoint: string
  transport: Extract<TransportCandidate, { kind: "wsl" }>
}

// Source-owned observation, never a target advertisement. The endpoint file
// only tells Windows where to try. Its root bearer is not used. Production
// supplies the same paired-machine opener as every other fleet route, so both
// authority and expected identity must be checked before a candidate exists.
export async function openWslTransport(input: {
  distribution: string
  expectedMachineId: string
  credential: string
  deadline: OperationDeadline
  signal?: AbortSignal
  open: (input: {
    endpoint: string; expectedMachineId: string; credential: string
    deadline: OperationDeadline; signal?: AbortSignal
  }) => Promise<MachineConnection>
}): Promise<WslTransportConnection> {
  const distribution = assertDistributionName(input.distribution)
  const { deadline } = input
  let connection: MachineConnection | undefined
  try {
    deadline.throwIfExpired()
    const listed = await beforeDeadline(listWslDistributions({
      platform: "win32", timeoutMs: Math.ceil(deadline.remainingMs()),
      run: (command, args, options) => runWslBytes(command, args, { ...options, signal: deadline.signal }),
    }), deadline)
    const found = listed.find((entry) => entry.name === distribution)
    if (!found) throw new WslTransportError(distribution, "absent")
    if (found.state !== "Running") throw new WslTransportError(distribution, "stopped")
    if (found.version !== 2) throw new WslTransportError(distribution, "wsl1")
    deadline.throwIfExpired()
    const endpoint = await beforeDeadline(readDistroEndpoint({
      distribution, timeoutMs: Math.ceil(deadline.remainingMs()),
      run: (command, args, options) => runWslText(command, args, { ...options, signal: deadline.signal }),
    }), deadline)
    if (!endpoint) throw new WslTransportError(distribution, "daemon-absent")
    deadline.throwIfExpired()
    const address = wslDaemonEndpointUrl(endpoint)
    // Parsing protects the resource seam even if a local file was replaced.
    const transport = transportCandidateSchema.parse({ kind: "wsl", endpoint: address, authenticated: true })
    if (transport.kind !== "wsl") throw new WslTransportError(distribution, "corrupt")
    connection = await input.open({ endpoint: transport.endpoint, expectedMachineId: input.expectedMachineId,
      credential: input.credential, deadline, ...(input.signal ? { signal: input.signal } : {}) })
    deadline.throwIfExpired()
    return { ...connection, routeSource: "wsl", endpoint: transport.endpoint, transport }
  } catch (error) {
    connection?.close()
    // Identity/authority failures terminate fallback, exactly as on direct
    // routes. Never hide one behind an availability error or quote peer text.
    if (error instanceof MachinePairingRequiredError || error instanceof MachineIdentityMismatchError
      || error instanceof MachineProtocolMismatchError || error instanceof MachineDescriptorError) throw error
    if (error instanceof WslTransportError) throw error
    if (deadline.signal.aborted && !(deadline.signal.reason instanceof OperationDeadlineExceededError)) throw deadline.signal.reason
    throw new WslTransportError(distribution, deadline.remainingMs() === 0 ? "timed-out"
      : error instanceof WslError ? error.kind : "unreachable")
  }
}
