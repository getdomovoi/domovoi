import { fleetClientRouteResultSchema, isTransportLoopbackHost, type ClientKind, type FleetClientRouteParams, type FleetClientRouteResult } from "@getdomovoi/protocol"

import { DomovoiClient, type DomovoiEndpoint } from "./client.js"
import { ClientAdmissionError, type ClientAdmission } from "./client-admission-policy.js"
import { Deadline, DeadlineExceededError } from "./deadline.js"
import type { DesktopWindowBridge } from "./desktop-platform.js"
import { FleetWorkerSocket } from "./fleet-worker-socket.js"

export type FleetRouteReader = (params: FleetClientRouteParams, options: { deadline: Deadline }) => Promise<FleetClientRouteResult>
export type FleetAccess = Required<ClientAdmission> & { credential: string }

// IPC is bounded by the same clock as route discovery, open, hello and the
// receipt. The main process has its own maximum too; a late reply grants no use.
export function withinFleetDeadline<T>(deadline: Deadline, work: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (complete: () => void) => {
      if (done) return
      done = true
      deadline.signal.removeEventListener("abort", expire)
      complete()
    }
    const expire = () => finish(() => reject(new ClientAdmissionError("route-timeout")))
    if (deadline.remainingMs() === 0) { expire(); return }
    deadline.signal.addEventListener("abort", expire, { once: true })
    Promise.resolve().then(() => {
      if (deadline.remainingMs() === 0 || done) throw new ClientAdmissionError("route-timeout")
      return work()
    }).then(
      (value) => deadline.remainingMs() === 0 ? expire() : finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    )
  })
}

export async function prepareFleetEndpoint(input: {
  machineId: string; credential: string; homeUrl: string; kind: ClientKind; route: FleetRouteReader;
  bridge?: Pick<DesktopWindowBridge, "fleetRoute">; deadline: Deadline
}): Promise<DomovoiEndpoint> {
  try {
    let ticket: unknown
    const raw = await withinFleetDeadline(input.deadline, async () => {
      if (input.kind === "desktop") {
        if (!input.bridge?.fleetRoute) throw new ClientAdmissionError("verification-unavailable")
        const response = await input.bridge.fleetRoute(input.machineId, input.deadline.remainingMs())
        if (!response || typeof response !== "object") throw new ClientAdmissionError("verification-unavailable")
        const { ticket: selectedTicket, ...route } = response as Record<string, unknown>
        ticket = selectedTicket
        return route
      }
      return input.route({ machineId: input.machineId, allowSourceLocal: isTransportLoopbackHost(new URL(input.homeUrl).hostname) }, { deadline: input.deadline })
    })
    const route = fleetClientRouteResultSchema.parse(raw)
    if (route.outcome === "refused") throw new ClientAdmissionError(route.reason)
    if (route.machineId !== input.machineId) throw new ClientAdmissionError("identity-mismatch")
    if (input.kind === "desktop") {
      if (typeof ticket !== "string" || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u.test(ticket)) {
        throw new ClientAdmissionError("verification-unavailable")
      }
      const verifiedTicket = ticket
      return { url: route.transport.endpoint, token: input.credential,
        createSocket: (url) => {
          if (url !== route.transport.endpoint) throw new ClientAdmissionError("identity-mismatch")
          return new FleetWorkerSocket(url, verifiedTicket)
        } }
    }
    return { url: route.transport.endpoint, token: input.credential }
  } catch (error) { throw fleetAccessError(error) }
}

export function fleetAccessError(error: unknown): ClientAdmissionError {
  return error instanceof ClientAdmissionError ? error : new ClientAdmissionError(error instanceof DeadlineExceededError ? "route-timeout" : "verification-unavailable")
}

// Every remote client is built here with required admission, including readers
// used by inventory fan-out. There is deliberately no machine credential input.
export function fleetClient(input: {
  access: ClientAdmission & { credential: string }; homeUrl: string; kind: ClientKind; route: FleetRouteReader;
  bridge?: Pick<DesktopWindowBridge, "fleetRoute">
}): DomovoiClient {
  return new DomovoiClient(input.homeUrl, input.kind, {
    budgets: { connectMs: 30_000, requestMs: 120_000 },
    admission: input.access,
    resolveEndpoint: (deadline) => prepareFleetEndpoint({ ...input, ...input.access, deadline }),
  })
}
