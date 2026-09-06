import { fleetClientRouteParamsSchema, fleetClientRouteResultSchema, type FleetClientRouteResult } from "@getdomovoi/protocol"

import { callDaemonOnce } from "./cli-rpc.js"
import { OperationDeadline, OperationDeadlineExceededError } from "./operation-deadline.js"

// Desktop main supplies its acquired home endpoint, never a renderer's URL or
// a remote root token. Reuse the CLI's bounded connect/hello/exchange teardown.
export async function verifyLocalFleetClientRoute(input: {
  endpoint: { url: string; token: string }
  machineId: string
  timeoutMs: number
}): Promise<FleetClientRouteResult> {
  const deadline = OperationDeadline.start(input.timeoutMs)
  try {
    const params = fleetClientRouteParamsSchema.parse({ machineId: input.machineId, allowSourceLocal: true })
    const url = new URL(input.endpoint.url)
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/rpc") {
      return { outcome: "refused", reason: "client-route-unavailable" }
    }
    const result = fleetClientRouteResultSchema.parse(await callDaemonOnce({
      target: { host: url.hostname, port: Number(url.port || (url.protocol === "wss:" ? 443 : 80)),
        ...(url.protocol === "wss:" ? { tls: true } : {}) },
      token: input.endpoint.token, method: "fleet.clientRoute", params, deadline,
    }))
    deadline.throwIfExpired()
    return result.outcome === "ready" && result.machineId !== input.machineId
      ? { outcome: "refused", reason: "identity-mismatch" } : result
  } catch (error) {
    return { outcome: "refused", reason: deadline.signal.aborted || error instanceof OperationDeadlineExceededError
      ? "route-timeout" : "client-route-unavailable" }
  } finally { deadline.clear() }
}
