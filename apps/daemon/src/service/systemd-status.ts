import type { ServiceStatus } from "./install.js"

export const systemdStatusProperties = ["ActiveState", "MainPID", "ExecMainStartTimestamp", "NRestarts", "ExecMainCode", "ExecMainStatus"] as const

// No timestamp-format switch: older systemctl versions reject the entire
// request. Only interpret an unambiguous UTC timestamp; local abbreviations
// such as CST cannot establish an instant. Other facts remain readable.
function startTimestamp(value: string | undefined): string | undefined {
  const match = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (?:UTC|GMT)$/.exec(value ?? "")
  if (!match) return undefined
  const iso = `${match[1]}T${match[2]}.000Z`
  const time = Date.parse(iso)
  return Number.isFinite(time) && time > 0 && new Date(time).toISOString() === iso ? iso : undefined
}

export function systemdStatusFacts(stdout: string): Omit<ServiceStatus, "installed" | "detail"> & { state: string } {
  const properties = new Map<string, string | undefined>()
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf("=")
    if (separator < 0) continue
    const key = line.slice(0, separator)
    // Duplicate properties are ambiguous, including a third occurrence.
    properties.set(key, properties.has(key) ? undefined : line.slice(separator + 1))
  }
  const integer = (key: string, minimum: number, maximum: number): number | undefined => {
    const text = properties.get(key)
    if (!text || !/^[0-9]+$/.test(text)) return undefined
    const value = Number(text)
    return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined
  }
  const state = properties.get("ActiveState") || "unknown"
  // Matches systemctl is-active's success states, not just "active".
  const running = ["active", "reloading", "refreshing"].includes(state)
  const pid = running ? integer("MainPID", 1, 2_147_483_647) : undefined
  const startedAt = running ? startTimestamp(properties.get("ExecMainStartTimestamp")) : undefined
  // NRestarts is uint32, independent of Domovoi's four-crash supervisors.
  // It resets on non-automatic starts and explicit counter resets, not reload.
  const restartCount = integer("NRestarts", 0, 4_294_967_295)
  // ExecMainCode is waitid's CLD_* code. Zero means no recorded exit.
  // Only CLD_EXITED makes ExecMainStatus an exit code, including code zero.
  const exit = integer("ExecMainCode", 1, 1) === 1 ? integer("ExecMainStatus", 0, 255) : undefined
  return { state, running,
    ...(pid === undefined ? {} : { pid }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(restartCount === undefined ? {} : { restartCount }),
    ...(exit === undefined ? {} : { lastExit: `code ${exit}` }),
  }
}
