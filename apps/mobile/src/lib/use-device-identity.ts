import { useEffect, useState } from "react"

import type { DaemonCall, DaemonStatus } from "./daemon"

// The paired device id the daemon holds for this phone's credential. The
// daemon attributes a turn by that id, so the approval screen compares it with
// a gate's origin to say whether this phone started the turn. Undefined until
// the open connection answers device.current, and for a credential that is not
// a paired device's.
//
// `credential` is whatever names the stored credential (its token). A new one
// may be another machine's pairing, so the id is forgotten at once and an
// answer still in flight for the old one is dropped.
export function useDeviceIdentity(
  call: DaemonCall,
  status: DaemonStatus,
  credential: string | undefined,
): string | undefined {
  const [held, setHeld] = useState<{ credential: string | undefined, deviceId: string | undefined }>({ credential, deviceId: undefined })

  useEffect(() => {
    if (status !== "open" || credential === undefined) return
    // A new credential or a dropped connection ends this effect, so an answer
    // that arrives after either is not this connection's.
    let live = true
    call("device.current", {}).then((answer) => {
      if (!live) return
      setHeld({ credential, deviceId: answer.kind === "client" ? answer.deviceId : undefined })
    }, (cause: unknown) => {
      // Not knowing leaves the screen saying only the client kind, which is
      // true; it never makes a turn this phone's.
      console.warn("Device identity not read:", cause instanceof Error ? cause.message : String(cause))
    })
    return () => { live = false }
  }, [call, credential, status])

  return held.credential === credential ? held.deviceId : undefined
}
