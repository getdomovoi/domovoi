import type { ConnectionFault } from "./lib/connection-fault"
import type { DaemonStatus } from "./lib/daemon"

export type LaunchPhase = {
  label: string
  state: string
  tone: "complete" | "active" | "waiting" | "failed"
}

export function route(address: string): { label: string, kind: string } {
  try {
    const url = new URL(address)
    const host = url.hostname || "Configured route"
    const kind = host === "127.0.0.1" || host === "localhost"
      ? "loopback"
      : host.endsWith(".ts.net") || host.includes("tailnet") ? "tailnet" : "direct"
    return { label: host, kind }
  } catch {
    return { label: "Configured route", kind: "direct" }
  }
}

export function launchPhases(input: {
  restoringCredential: boolean
  hasCredential: boolean
  hasSnapshot: boolean
  status: DaemonStatus
  fault: ConnectionFault | undefined
  address: string
}): LaunchPhase[] {
  if (input.restoringCredential) {
    return [
      { label: "Saved pairing", state: "checking keychain", tone: "active" },
      { label: "Configured route", state: "waiting for pairing", tone: "waiting" },
      { label: "Workspace", state: "waiting for route", tone: "waiting" },
    ]
  }
  if (!input.hasCredential) {
    return [
      { label: "Saved pairing", state: "not found", tone: "waiting" },
      { label: "Configured route", state: "not configured", tone: "waiting" },
      { label: "Workspace", state: "not read", tone: "waiting" },
    ]
  }
  const configured = route(input.address)
  if (input.hasSnapshot) {
    return [
      { label: "Saved pairing", state: "found", tone: "complete" },
      { label: configured.label, state: `${configured.kind} route answered`, tone: "complete" },
      { label: "Workspace", state: "read", tone: "complete" },
    ]
  }
  if (input.fault && !input.fault.retriable) {
    return [
      { label: "Saved pairing", state: "found", tone: "complete" },
      { label: configured.label, state: "refused", tone: "failed" },
      { label: "Workspace", state: "not read", tone: "waiting" },
    ]
  }
  return [
    { label: "Saved pairing", state: "found", tone: "complete" },
    { label: configured.label, state: input.status === "open" ? `${configured.kind} route answered` : `trying ${configured.kind} route`, tone: input.status === "open" ? "complete" : "active" },
    { label: "Workspace", state: input.status === "open" ? "reading" : "waiting for route", tone: input.status === "open" ? "active" : "waiting" },
  ]
}
