import {
  fleetClientRouteResultSchema, protocolCompatibility, protocolVersion, transportCandidateSchema,
  type FleetClientRouteParams, type FleetClientRouteRefusal, type FleetClientRouteResult,
  type FleetMachine, type TransportCandidate,
} from "@getdomovoi/protocol"

import type { AsyncMachineCredentials } from "./machine-credential-worker.js"
import { MachineCredentialUnavailableError } from "./machine-credentials.js"
import { createMachineDialer, type MachineRouteConnection } from "./machine-dial.js"
import {
  MachineDescriptorError, MachineIdentityMismatchError, MachinePairingRequiredError,
  MachineProtocolMismatchError, openMachineSocket, defaultMachineCallTimeoutMs,
} from "./machine-socket.js"
import { OperationDeadlineExceededError, type OperationDeadline } from "./operation-deadline.js"
import { isLoopbackHost, type ConfiguredSshTunnel } from "./transport-config.js"
import { WslTransportError } from "./wsl-transport.js"

function eligibility(machine: FleetMachine | undefined): FleetClientRouteRefusal | undefined {
  if (!machine || machine.self) return "not-enrolled"
  if (protocolCompatibility(protocolVersion, machine.protocolVersion) !== "compatible"
    || machine.health === "version-mismatch" || machine.health === "upgrade-required") return "protocol-mismatch"
  if (machine.health === "pairing-required") return "pairing-required"
  if (machine.health === "credential-store-unavailable") return "credential-store-unavailable"
  if (machine.health !== "healthy" && machine.health !== "reconnecting") return "machine-unavailable"
  return undefined
}

function routeTransport(connection: MachineRouteConnection, machine: FleetMachine): TransportCandidate {
  if (connection.routeSource === "wsl") return connection.transport
  const { endpoint } = connection
  if (connection.routeSource === "ssh") return { kind: "ssh", endpoint, configured: true, authenticated: true }
  const advertised = machine.transports.find((candidate) => candidate.endpoint === endpoint
    && (candidate.kind === "local" || candidate.kind === "lan" || candidate.kind === "tailnet"))
  // A verified alias need not appear in advertisements. The transport's LAN
  // kind means direct remote TLS, not evidence of LAN membership. Preserve an
  // advertised tailnet classification when the exact endpoint supplies it.
  return transportCandidateSchema.parse(advertised ?? {
    kind: isLoopbackHost(new URL(endpoint).hostname) ? "local" : "lan", endpoint, authenticated: true,
  })
}

export async function resolveFleetClientRoute(input: {
  params: FleetClientRouteParams
  machine: () => FleetMachine | undefined
  credentials: AsyncMachineCredentials | undefined
  sshTunnels?: readonly ConfiguredSshTunnel[]
  deadline: OperationDeadline
}): Promise<FleetClientRouteResult> {
  const refuse = (reason: FleetClientRouteRefusal): FleetClientRouteResult => ({ outcome: "refused", reason })
  let connection: MachineRouteConnection | undefined
  try {
    input.deadline.throwIfExpired()
    const problem = eligibility(input.machine())
    if (problem) return refuse(problem)
    if (!input.credentials) return refuse("credential-store-unavailable")
    const dial = createMachineDialer({
      machine: () => {
        const machine = input.machine()
        return eligibility(machine) ? undefined : machine
      },
      credentials: input.credentials,
      allowSourceLocal: input.params.allowSourceLocal === true,
      ...(input.sshTunnels ? { sshTunnels: input.sshTunnels } : {}),
      dialTimeoutMs: input.deadline.remainingMs(),
      open: (options) => openMachineSocket({ ...options, callTimeoutMs: defaultMachineCallTimeoutMs }),
    })
    connection = await dial(input.params.machineId, input.deadline.signal, input.deadline)
    input.deadline.throwIfExpired()
    // Forget can start while the authenticated route is being discovered.
    // A successful old connection must not re-enable a masked fleet row.
    const machine = input.machine()
    const changed = eligibility(machine)
    if (changed) return refuse(changed)
    return fleetClientRouteResultSchema.parse({ outcome: "ready", machineId: input.params.machineId,
      transport: routeTransport(connection, machine!) })
  } catch (error) {
    if (error instanceof MachinePairingRequiredError) return refuse("pairing-required")
    if (error instanceof MachineProtocolMismatchError) return refuse("protocol-mismatch")
    if (error instanceof MachineIdentityMismatchError || error instanceof MachineDescriptorError) return refuse("identity-mismatch")
    if (error instanceof MachineCredentialUnavailableError) return refuse("credential-store-unavailable")
    if (error instanceof OperationDeadlineExceededError
      || error instanceof WslTransportError && error.reason === "timed-out") return refuse("route-timeout")
    return refuse(eligibility(input.machine()) ?? "client-route-unavailable")
  } finally {
    // Only a location is returned. The machine credential and authenticated
    // machine socket stay in this daemon, never in the renderer.
    connection?.close()
  }
}
