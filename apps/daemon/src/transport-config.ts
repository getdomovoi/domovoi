import { z } from "zod"

import { fleetDirectEndpointSchema, machineIdSchema, maximumFleetMachines } from "@getdomovoi/protocol"

export const maximumSshConfigurationBytes = 32 * 1_024

export function endpointHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
}

export function isLoopbackHost(host: string): boolean {
  try {
    const normalized = new URL(`wss://${endpointHost(host)}/`).hostname
    return normalized === "localhost" || normalized === "[::1]" || normalized.startsWith("127.")
  } catch { return false }
}

// This is an operator's explicit route classification, not inferred membership
// or evidence that a name/IP range protects traffic. Remote listeners still need TLS.
export const tailnetHostSchema = z.string().min(1).max(253).refine((host) => {
  if (/[\s/@?#\\%]/u.test(host)) return false
  try {
    const url = new URL(`wss://${endpointHost(host)}:1/rpc`)
    return url.port === "1" && url.pathname === "/rpc"
      && !["0.0.0.0", "[::]"].includes(url.hostname) && !isLoopbackHost(host)
  } catch { return false }
})

// These forwards exist on the dialing machine. They are never target-authored
// advertisements, and this setting neither starts SSH nor accepts remote URLs.
const configuredSshTunnelSchema = z.object({
  machineId: machineIdSchema,
  endpoint: fleetDirectEndpointSchema.refine((endpoint) =>
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname)),
}).strict()

export const configuredSshTunnelsSchema = z.array(configuredSshTunnelSchema).max(maximumFleetMachines)
  .refine((tunnels) => new Set(tunnels.map((tunnel) => tunnel.machineId)).size === tunnels.length,
    "Only one SSH forward may be configured per machine")

export type ConfiguredSshTunnel = z.infer<typeof configuredSshTunnelSchema>
