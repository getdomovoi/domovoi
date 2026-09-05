import { fleetDirectEndpointSchema, usableTransports, type FleetMachineFacts } from "@getdomovoi/protocol"

import type { AsyncMachineCredentials } from "./machine-credential-worker.js"
import { OperationDeadline, validateOperationDeadlineBudget } from "./operation-deadline.js"
import { MachineDescriptorError, MachineIdentityMismatchError, MachinePairingRequiredError, MachineProtocolMismatchError } from "./machine-socket.js"
import { configuredSshTunnelsSchema, isLoopbackHost, type ConfiguredSshTunnel } from "./transport-config.js"

export type MachineConnection = {
  call: (
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    deadline?: OperationDeadline,
  ) => Promise<unknown>
  close: () => void
}

export type MachineRouteConnection = MachineConnection & {
  endpoint: string
  routeSource: "verified" | "advertised" | "ssh"
}

const loopbackHosts = new Set(["127.0.0.1", "::1", "[::1]", "localhost"])

function leavesThisMachine(endpoint: string): boolean {
  if (endpoint.startsWith("wss://")) return false
  try {
    return !loopbackHosts.has(new URL(endpoint).hostname)
  } catch {
    return true
  }
}

// Reaching another machine needs three things this daemon already has: what the
// fleet says about it, the credential pairing left here, and the transport
// order the protocol defines.
export function createMachineDialer(input: {
  machine: (machineId: string) => Pick<FleetMachineFacts, "id" | "connection" | "transports" | "verifiedRoute"> | undefined
  credentials: AsyncMachineCredentials | undefined
  sshTunnels?: readonly ConfiguredSshTunnel[]
  dialTimeoutMs: number
  open: (input: {
    endpoint: string
    expectedMachineId: string
    credential: string
    deadline: OperationDeadline
    signal?: AbortSignal
  }) => Promise<MachineConnection>
}): (machineId: string, signal?: AbortSignal, deadline?: OperationDeadline) => Promise<MachineRouteConnection> {
  validateOperationDeadlineBudget(input.dialTimeoutMs)
  const sshTunnels = configuredSshTunnelsSchema.parse(input.sshTunnels ?? [])
  return async (machineId: string, signal?: AbortSignal, parentDeadline?: OperationDeadline) => {
    const deadline = parentDeadline?.limit(input.dialTimeoutMs)
      ?? OperationDeadline.start(input.dialTimeoutMs, signal ? { signal } : {})
    try {
      deadline.throwIfExpired()
      if (signal?.aborted) throw new Error("The transfer was cancelled")
      if (!input.machine(machineId)) throw new Error("That machine cannot be reached")

      const credential = await input.credentials?.forMachine(machineId, deadline)
      deadline.throwIfExpired()
      if (signal?.aborted) throw new Error("The transfer was cancelled")
      if (!credential) throw new Error("That machine has to be paired again")

      // Forget can mask the peer while the keychain is working. Credentials
      // read before that mutation do not authorize using yesterday's row.
      const machine = input.machine(machineId)
      if (!machine) throw new Error("That machine cannot be reached")

      const routes: Array<Pick<MachineRouteConnection, "endpoint" | "routeSource">> = []
      const addRoute = (endpoint: string, routeSource: MachineRouteConnection["routeSource"]) => {
        if (!routes.some((route) => route.endpoint === endpoint)) routes.push({ endpoint, routeSource })
      }
      if (machine.verifiedRoute && fleetDirectEndpointSchema.safeParse(machine.verifiedRoute.endpoint).success) {
        addRoute(machine.verifiedRoute.endpoint, "verified")
      }
      let refusedPlaintext = false
      for (const transport of usableTransports(machine.transports)) {
        // No relay can carry this plaintext RPC codec. A future encrypted relay
        // is a separate capability, not a caller-controlled availability flag.
        // A peer cannot assert that its loopback SSH forward is configured here.
        if (transport.kind === "relay" || transport.kind === "ssh") continue
        const staysHere = transport.kind === "local"
          && machine.connection === "local"
          && !leavesThisMachine(transport.endpoint)
        if ((!transport.endpoint.startsWith("wss://") && !staysHere)
          || !fleetDirectEndpointSchema.safeParse(transport.endpoint).success) {
          refusedPlaintext = true
          continue
        }
        // TLS authenticates a server name, not which machine owns loopback.
        // Remote advertisements cannot supply our local endpoint or disguise
        // a removable SSH forward as a permanent advertised route.
        if (machine.connection !== "local" && isLoopbackHost(new URL(transport.endpoint).hostname)) continue
        addRoute(transport.endpoint, "advertised")
      }
      // Source-local forwards follow the direct candidates in protocol order.
      // Eligibility and credentials were checked before adding any of them.
      const ssh = sshTunnels.find((tunnel) => tunnel.machineId === machineId)
      if (ssh) addRoute(ssh.endpoint, "ssh")
      if (routes.length === 0) throw new Error(refusedPlaintext
        ? "Refusing to authenticate over an unencrypted connection"
        : "That machine advertises no usable transport")
      let lastError: unknown
      for (const { endpoint, routeSource } of routes) {
        deadline.throwIfExpired()
        if (signal?.aborted) throw new Error("The transfer was cancelled")
        try {
          const connection = await boundedOpen(input.open({
            endpoint, expectedMachineId: machine.id, credential, deadline,
            ...(signal ? { signal } : {}),
          }), deadline, signal)
          return { ...connection, endpoint, routeSource }
        } catch (error) {
          // Failed identity/authority is not evidence to keep trying elsewhere.
          if (error instanceof MachinePairingRequiredError || error instanceof MachineIdentityMismatchError
            || error instanceof MachineProtocolMismatchError || error instanceof MachineDescriptorError) throw error
          lastError = error
        }
      }
      deadline.throwIfExpired()
      throw lastError
    } finally { deadline.clear() }
  }
}

function boundedOpen(opening: Promise<MachineConnection>, deadline: OperationDeadline, signal?: AbortSignal): Promise<MachineConnection> {
  return new Promise((resolve, reject) => {
    let settled = false
    const detach = () => {
      deadline.signal.removeEventListener("abort", abortDeadline)
      signal?.removeEventListener("abort", abortSignal)
    }
    const refuse = (error: unknown) => {
      if (settled) return
      settled = true
      detach()
      reject(error)
    }
    const abortDeadline = () => refuse(deadline.signal.reason)
    const abortSignal = () => refuse(new Error("The transfer was cancelled"))
    deadline.signal.addEventListener("abort", abortDeadline, { once: true })
    signal?.addEventListener("abort", abortSignal, { once: true })
    if (deadline.remainingMs() === 0) abortDeadline()
    if (signal?.aborted) abortSignal()
    opening.then((connection) => {
      if (deadline.remainingMs() === 0) abortDeadline()
      if (settled) { connection.close(); return }
      settled = true
      detach()
      resolve(connection)
    }, refuse)
  })
}
