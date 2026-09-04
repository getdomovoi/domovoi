import type { ConnectionFault } from "./lib/connection-fault"
import type { DaemonStatus } from "./lib/daemon"

export type ConnectionNotice = {
  tone: "warning" | "destructive"
  headline: string
  detail: string
}

// Silence is the connected state. The phone is not a status board, so a working
// connection says nothing at all; only a connection that has stopped being one
// earns space on the screen.
export function connectionNotice(
  status: DaemonStatus,
  fault: ConnectionFault | undefined,
  // Whether the screen is currently drawing daemon data. Stale content shown as
  // though it were live is the failure worth naming: yesterday's approvals read
  // exactly like today's.
  showingData: boolean,
): ConnectionNotice | undefined {
  if (status === "open") return undefined
  if (fault && !fault.retriable) {
    return { tone: "destructive", headline: fault.headline, detail: fault.detail }
  }
  const headline = status === "connecting" ? "Connecting" : "Not connected"
  return {
    tone: "warning",
    headline,
    detail: showingData
      ? "Nothing here is live. This is the last state the phone was sent."
      : "Trying again. Check the daemon address and token in Settings if this lasts.",
  }
}
