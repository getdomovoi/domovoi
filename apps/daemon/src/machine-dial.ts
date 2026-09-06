import { fleetDirectEndpointSchema, usableTransports, type FleetMachineFacts } from "@getdomovoi/protocol"

import type { AsyncMachineCredentials } from "./machine-credential-worker.js"
import { OperationDeadline, OperationDeadlineExceededError, validateOperationDeadlineBudget } from "./operation-deadline.js"
import { MachineDescriptorError, MachineIdentityMismatchError, MachinePairingRequiredError, MachineProtocolMismatchError } from "./machine-socket.js"
import { configuredSshTunnelsSchema, isLoopbackHost, type ConfiguredSshTunnel } from "./transport-config.js"
import { openWslTransport, WslTransportError, type WslTransportConnection } from "./wsl-transport.js"

export type MachineConnection = {
  call: (
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    deadline?: OperationDeadline,
  ) => Promise<unknown>
  close: () => void
}

export type MachineRouteConnection = WslTransportConnection | MachineConnection & {
  endpoint: string
  routeSource: "verified" | "advertised" | "ssh"
}

export class MachineDialTimeoutError extends OperationDeadlineExceededError {
  readonly stage = "connect-and-hello" as const
  readonly target: string

  constructor(endpoint: string) {
    super()
    this.name = "MachineDialTimeoutError"
    // An address, not arbitrary transport failure text or URL credentials.
    this.target = new URL(endpoint).origin
    this.message = `The machine at ${this.target} did not complete connect and authenticated hello before the route deadline.`
      + " Check that route and try again."
  }
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
  machine: (machineId: string) => Pick<FleetMachineFacts, "id" | "connection" | "transports" | "verifiedRoute" | "wsl"> | undefined
  credentials: AsyncMachineCredentials | undefined
  // Test seam below the production factory. Remote peers cannot choose the
  // source platform or grant access to its registered distributions.
  wslPlatform?: NodeJS.Platform
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

      type Route = { routeSource: "wsl"; distribution: string }
        | { endpoint: string; routeSource: "verified" | "advertised" | "ssh" }
      const routes: Route[] = []
      const localWsl = (input.wslPlatform ?? process.platform) === "win32" && machine.wsl !== undefined
      const addRoute = (endpoint: string, routeSource: "verified" | "advertised" | "ssh") => {
        if (!routes.some((route) => route.routeSource !== "wsl" && route.endpoint === endpoint)) routes.push({ endpoint, routeSource })
      }
      if (machine.verifiedRoute && fleetDirectEndpointSchema.safeParse(machine.verifiedRoute.endpoint).success
        && !(localWsl && isLoopbackHost(new URL(machine.verifiedRoute.endpoint).hostname))) {
        addRoute(machine.verifiedRoute.endpoint, "verified")
      }
      // A remembered WSL loopback port is not permanent authority. Inspect the
      // distribution afresh on every attempt, including after it stops or its
      // daemon changes ports. Off-host direct routes retain their precedence.
      if (localWsl) routes.push({ routeSource: "wsl", distribution: machine.wsl!.distribution })
      let refusedPlaintext = false
      for (const transport of usableTransports(machine.transports)) {
        // No relay can carry this plaintext RPC codec. A future encrypted relay
        // is a separate capability, not a caller-controlled availability flag.
        // A peer cannot assert that its loopback SSH forward is configured here.
        if (transport.kind === "relay" || transport.kind === "ssh" || transport.kind === "wsl") continue
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
      for (const [index, route] of routes.entries()) {
        if (deadline.remainingMs() === 0 && lastError instanceof MachineDialTimeoutError) throw lastError
        deadline.throwIfExpired()
        if (signal?.aborted) throw new Error("The transfer was cancelled")
        // Reserve a share for every remaining eligible route. A silent open
        // or hello spends this attempt only, never the whole fallback budget.
        // Recompute after fast failures so later routes can use the spare time.
        const attempt = deadline.limit(Math.max(1, deadline.remainingMs() / (routes.length - index)))
        try {
          // The keychain or distribution lookup can overlap Forget. Check the
          // current eligibility at the actual socket seam, not just at entry.
          const open: typeof input.open = (options) => {
            attempt.throwIfExpired()
            if (!input.machine(machineId)) throw new Error("That machine cannot be reached")
            return input.open(options)
          }
          if (route.routeSource === "wsl") {
            return await boundedOpen(openWslTransport({ ...route, expectedMachineId: machine.id,
              credential, deadline: attempt, open, ...(signal ? { signal } : {}) }), attempt, signal)
          }
          const { endpoint, routeSource } = route
          const connection = await boundedOpen(open({
            endpoint, expectedMachineId: machine.id, credential, deadline: attempt,
            ...(signal ? { signal } : {}),
          }), attempt, signal)
          return { ...connection, endpoint, routeSource }
        } catch (error) {
          // Failed identity/authority is not evidence to keep trying elsewhere.
          if (error instanceof MachinePairingRequiredError || error instanceof MachineIdentityMismatchError
            || error instanceof MachineProtocolMismatchError || error instanceof MachineDescriptorError) throw error
          lastError = error instanceof OperationDeadlineExceededError
            ? route.routeSource === "wsl" ? new WslTransportError(route.distribution, "timed-out")
              : new MachineDialTimeoutError(route.endpoint)
            : error
        } finally { attempt.clear() }
      }
      if (lastError instanceof MachineDialTimeoutError || lastError instanceof WslTransportError) throw lastError
      deadline.throwIfExpired()
      throw lastError
    } finally { deadline.clear() }
  }
}

function boundedOpen<T extends MachineConnection>(opening: Promise<T>, deadline: OperationDeadline, signal?: AbortSignal): Promise<T> {
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
