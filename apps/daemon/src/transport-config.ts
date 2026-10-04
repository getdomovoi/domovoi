import { z } from "zod"

import { loopbackTransportEndpointSchema, machineIdSchema, maximumFleetMachines, utf16MaxLength } from "@getdomovoi/protocol"

export const maximumSshConfigurationBytes = 32 * 1_024

export function endpointHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
}

export function isLoopbackHost(host: string): boolean {
  try {
    const normalized = new URL(`wss://${endpointHost(host)}/`).hostname
    return normalized === "localhost" || normalized === "localhost." || normalized === "[::1]"
      || /^127\.\d+\.\d+\.\d+$/u.test(normalized) || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/u.test(normalized)
  } catch { return false }
}

// This is an operator's explicit route classification, not inferred membership
// or evidence that a name/IP range protects traffic. Remote listeners still need TLS.
// Re-review of 10dba4a2 (P2): every check reads the host the URL parser
// produces, and a name it rewrites (1.0x0 parses as 1.0.0.0) is refused, so
// what is checked is what is advertised. An IPv6 literal is only written in
// its compressed form, which says the same address.
export const tailnetHostSchema = z.string().min(1).check(utf16MaxLength(253)).refine((host) => {
  if (/[\s/@?#\\%]/u.test(host)) return false
  try {
    const url = new URL(`wss://${endpointHost(host)}:1/rpc`)
    const parsed = url.hostname
    const rewritten = !host.includes(":") && parsed !== host.toLowerCase()
    return url.port === "1" && url.pathname === "/rpc" && !rewritten
      && !["0.0.0.0", "[::]"].includes(parsed) && !isLoopbackHost(parsed)
  } catch { return false }
})

// These forwards exist on the dialing machine. They are never target-authored
// advertisements, and this setting neither starts SSH nor accepts remote URLs.
const configuredSshTunnelSchema = z.object({
  machineId: machineIdSchema,
  endpoint: loopbackTransportEndpointSchema,
}).strict()

export const configuredSshTunnelsSchema = z.array(configuredSshTunnelSchema).max(maximumFleetMachines)
  .refine((tunnels) => new Set(tunnels.map((tunnel) => tunnel.machineId)).size === tunnels.length,
    "Only one SSH forward may be configured per machine")

export type ConfiguredSshTunnel = z.infer<typeof configuredSshTunnelSchema>
