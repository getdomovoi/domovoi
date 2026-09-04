import { describe, expect, it } from "vitest"

import { connectionNotice } from "./connection-notice"
import type { ConnectionFault } from "./lib/connection-fault"

const rejected: ConnectionFault = {
  retriable: false,
  headline: "The daemon refused this credential",
  detail: "Pair again in Settings.",
}

const unreachable: ConnectionFault = {
  retriable: true,
  headline: "Cannot reach the daemon",
  detail: "Cannot reach ws://desk:8787",
}

describe("connectionNotice", () => {
  it("says nothing at all while connected, because this is not a status board", () => {
    expect(connectionNotice("open", undefined, true)).toBeUndefined()
    expect(connectionNotice("open", unreachable, true)).toBeUndefined()
  })

  it("marks what is on screen as not live when the socket is down", () => {
    const notice = connectionNotice("closed", unreachable, true)

    expect(notice?.tone).toBe("warning")
    expect(notice?.detail).toContain("Nothing here is live")
  })

  it("points at Settings when there is nothing on screen to be stale", () => {
    expect(connectionNotice("closed", unreachable, false)?.detail).toContain("Settings")
  })

  it("carries a permanent refusal through instead of saying it is retrying", () => {
    const notice = connectionNotice("closed", rejected, true)

    expect(notice).toEqual({
      tone: "destructive",
      headline: rejected.headline,
      detail: rejected.detail,
    })
  })

  it("distinguishes connecting from not connected", () => {
    expect(connectionNotice("connecting", undefined, false)?.headline).toBe("Connecting")
    expect(connectionNotice("closed", undefined, false)?.headline).toBe("Not connected")
  })
})
