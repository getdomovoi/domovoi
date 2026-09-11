import { fleetClientRouteResultSchema, fleetSnapshotSchema, workspaceSnapshotSchema } from "@getdomovoi/protocol"

import type { RpcCall } from "./pair.js"

export type StatusReport = {
  endpoint: string
  machine: { id: string; name: string; platform: string; version: string; protocolVersion: string }
  sessions: { total: number; byState: Record<string, number> }
  // fleet.clientRoute is wired in the daemon and, before this command, read
  // by nothing. One line per machine: which route the daemon would choose for
  // this client and why, or the refusal.
  fleet: { machineId: string; label: string; health: string; route: string }[]
}

export async function collectStatus(input: { endpoint: string; call: RpcCall }): Promise<StatusReport> {
  const snapshot = workspaceSnapshotSchema.parse(await input.call("workspace.get", {}))
  const byState: Record<string, number> = {}
  for (const session of snapshot.sessions) byState[session.state] = (byState[session.state] ?? 0) + 1
  const fleet = fleetSnapshotSchema.parse(await input.call("fleet.list", {}))
  const machines = []
  for (const entry of fleet.entries) {
    if (entry.kind !== "machine") continue
    let route: string
    try {
      const chosen = fleetClientRouteResultSchema.parse(await input.call("fleet.clientRoute", { machineId: entry.machine.id, allowSourceLocal: true }))
      route = chosen.outcome === "ready" ? `${chosen.transport.kind} ${describeTransport(chosen.transport)}` : `refused: ${chosen.reason}`
    } catch (error) {
      route = `unknown: ${error instanceof Error ? error.message : String(error)}`
    }
    machines.push({ machineId: entry.machine.id, label: entry.machine.label, health: String(entry.machine.health), route })
  }
  return {
    endpoint: input.endpoint,
    machine: {
      id: snapshot.machine.id, name: snapshot.machine.name, platform: snapshot.machine.platform,
      version: snapshot.machine.version, protocolVersion: snapshot.protocolVersion,
    },
    sessions: { total: snapshot.sessions.length, byState },
    fleet: machines,
  }
}

function describeTransport(transport: { kind: string; endpoint?: unknown }): string {
  return typeof transport.endpoint === "string" ? transport.endpoint : ""
}

export function renderStatus(report: StatusReport): string {
  const lines = [
    `daemon    ${report.machine.name} (${report.machine.id})`,
    `endpoint  ${report.endpoint}`,
    `version   ${report.machine.version}, protocol ${report.machine.protocolVersion}, ${report.machine.platform}`,
    `sessions  ${report.sessions.total}${report.sessions.total === 0 ? "" : ` (${Object.entries(report.sessions.byState).map(([state, count]) => `${count} ${state}`).join(", ")})`}`,
  ]
  if (report.fleet.length > 0) {
    lines.push("fleet")
    for (const machine of report.fleet) lines.push(`  ${machine.label.padEnd(24)} ${machine.health.padEnd(10)} ${machine.route}`)
  }
  return `${lines.join("\n")}\n`
}
