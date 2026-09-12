import { deviceCurrentResultSchema, fleetClientRouteResultSchema, fleetSnapshotSchema, isTransportLoopbackHost, workspaceSnapshotSchema } from "@getdomovoi/protocol"

import type { RpcCall } from "./pair.js"

export type DoctorProbe = { name: string; ok: boolean; detail: string }
export type DoctorMachine = { machineId: string; label: string; health: string; route: string; because: string[] }
export type DoctorReport = { endpoint: string; probes: DoctorProbe[]; machines: DoctorMachine[]; failed: boolean }

// The daemon's own refusal reasons, in the words a person can act on.
const refusalAdvice: Record<string, string> = {
  "not-enrolled": "the machine is not enrolled in this fleet",
  "machine-unavailable": "the daemon has not heard from the machine recently",
  "pairing-required": "this daemon holds no machine credential for it; pair the machines",
  "credential-store-unavailable": "this daemon's keychain did not answer",
  "protocol-mismatch": "the machines speak different protocol versions; update both daemons",
  "identity-mismatch": "the machine at that address is not the one this daemon paired with",
  "client-route-unavailable": "no advertised transport could be dialled",
  "route-timeout": "dialling timed out",
}

// Mirrors the daemon's dial order so the reasons match what it did: the
// verified route first, then advertised transports in protocol order, with
// relay, ssh and wsl advertisements never dialled and a foreign loopback
// address never trusted. Every kind gets a line, so "tailnet: not advertised"
// is said rather than left for the reader to infer from its absence.
const transportKinds = ["local", "wsl", "lan", "tailnet", "ssh", "relay"] as const
const absent: Record<(typeof transportKinds)[number], string> = {
  local: "local: not advertised", wsl: "wsl: not a WSL guest of this host", lan: "lan: not advertised",
  tailnet: "tailnet: not advertised", ssh: "ssh: no tunnel configured here", relay: "relay: not implemented",
}
// Loopback is judged on the parsed hostname, as the daemon judges it, not on
// a spelling of the URL: ws://LOCALHOST and ws://2130706433 are loopback,
// wss://localhost.remote.example is not.
function loopbackEndpoint(endpoint: string): boolean {
  try { return isTransportLoopbackHost(new URL(endpoint).hostname.toLowerCase()) } catch { return false }
}

function explain(machine: { connection: string; transports: { kind: string; endpoint: string }[]; verifiedRoute?: { endpoint: string } | undefined }, chosen: { kind: string; endpoint: string } | undefined): string[] {
  const because: string[] = []
  if (machine.verifiedRoute) {
    because.push(chosen?.endpoint === machine.verifiedRoute.endpoint ? "verified route matched" : `verified route ${machine.verifiedRoute.endpoint}: not the route chosen`)
  } else {
    because.push("no verified route yet")
  }
  for (const kind of transportKinds) {
    const advertised = machine.transports.filter((transport) => transport.kind === kind)
    // ssh and wsl are configured on the daemon host and never advertised, so
    // an empty advertisement list says nothing about them; only the daemon's
    // choice does.
    if (chosen?.kind === kind && advertised.every((transport) => transport.endpoint !== chosen.endpoint)) {
      because.push(kind === "ssh" ? "ssh: chosen; tunnels are configured on the daemon host, not advertised"
        : kind === "wsl" ? "wsl: chosen; inspected on the daemon host, not advertised" : `${kind}: chosen`)
      continue
    }
    if (advertised.length === 0) { because.push(absent[kind]); continue }
    for (const transport of advertised) {
      if (transport.endpoint === chosen?.endpoint) continue
      if (kind === "relay") because.push("relay: not implemented")
      else if (kind === "ssh") because.push("ssh: a peer cannot advertise a forward for this machine")
      else if (kind === "wsl") because.push("wsl: inspected on this host, not dialled from an advertisement")
      else if (machine.connection !== "local" && loopbackEndpoint(transport.endpoint)) because.push(`${kind} ${transport.endpoint}: loopback on another machine, never trusted`)
      else if (!transport.endpoint.startsWith("wss://") && kind !== "local") because.push(`${kind} ${transport.endpoint}: not encrypted, refused`)
      else because.push(`${kind} ${transport.endpoint}: advertised, not chosen`)
    }
  }
  return because
}

export async function diagnose(input: { endpoint: string; clientProtocolVersion: string; call: RpcCall }): Promise<DoctorReport> {
  const probes: DoctorProbe[] = []
  const snapshot = workspaceSnapshotSchema.parse(await input.call("workspace.get", {}))
  probes.push({ name: "daemon", ok: true, detail: `${snapshot.machine.name} (${snapshot.machine.id}) at ${input.endpoint}, version ${snapshot.machine.version}` })
  const current = deviceCurrentResultSchema.parse(await input.call("device.current", {}))
  probes.push(current.kind === "client"
    ? { name: "credential", ok: true, detail: `accepted as device ${current.deviceId} (${current.client})` }
    : { name: "credential", ok: false, detail: "accepted, but as a daemon credential; a client should not hold one" })
  const same = input.clientProtocolVersion === snapshot.protocolVersion
  probes.push({ name: "protocol", ok: same, detail: `client ${input.clientProtocolVersion}, daemon ${snapshot.protocolVersion}; negotiation: unknown until version negotiation lands` })
  // A source-local route (the daemon's own loopback, its WSL distro, its
  // SSH forward) is usable only by a client on the daemon's host. That is
  // this client exactly when the daemon endpoint is loopback.
  const allowSourceLocal = loopbackEndpoint(input.endpoint)
  const fleet = fleetSnapshotSchema.parse(await input.call("fleet.list", {}))
  const machines: DoctorMachine[] = []
  for (const entry of fleet.entries) {
    if (entry.kind !== "machine") continue
    const machine = entry.machine
    // The daemon lists itself. There is no route to choose to it: this
    // connection is the route.
    if (machine.self) {
      machines.push({ machineId: machine.id, label: machine.label, health: machine.health, route: `this daemon, ${input.endpoint}`, because: [] })
      continue
    }
    let route: string
    let chosen: { kind: string; endpoint: string } | undefined
    let advice: string | undefined
    try {
      const result = fleetClientRouteResultSchema.parse(await input.call("fleet.clientRoute", { machineId: machine.id, allowSourceLocal }))
      if (result.outcome === "ready") {
        chosen = { kind: result.transport.kind, endpoint: result.transport.endpoint }
        route = `${result.transport.kind} ${result.transport.endpoint}`
      } else {
        route = `refused: ${result.reason}`
        advice = refusalAdvice[result.reason] ?? result.reason
      }
    } catch (error) {
      route = `unknown: ${error instanceof Error ? error.message : String(error)}`
    }
    const because = explain(machine, chosen)
    if (advice) because.push(advice)
    machines.push({ machineId: machine.id, label: machine.label, health: machine.health, route, because })
  }
  const failed = probes.some((probe) => !probe.ok) || machines.some((machine) => !machine.route.match(/^([a-z]+ wss?:|this daemon)/))
  return { endpoint: input.endpoint, probes, machines, failed }
}

export function renderDoctor(report: DoctorReport): string {
  const lines: string[] = []
  for (const probe of report.probes) lines.push(`${probe.ok ? "ok  " : "FAIL"} ${probe.name.padEnd(11)} ${probe.detail}`)
  for (const machine of report.machines) {
    lines.push(`${machine.route.startsWith("refused") || machine.route.startsWith("unknown") ? "FAIL" : "ok  "} ${machine.label.padEnd(11)} ${machine.route}`)
    for (const reason of machine.because) lines.push(`                 ${reason}`)
  }
  lines.push(report.failed ? "doctor: problems found" : "doctor: no problems found")
  return `${lines.join("\n")}\n`
}
