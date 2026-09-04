import {
  daemonAuthenticationErrorCode,
  protocolVersionMismatchErrorCode,
} from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { connectionFault } from "./connection-fault"
import { DaemonError } from "./daemon"

describe("connectionFault", () => {
  it("stops retrying a credential the daemon rejected, and says how to fix it", () => {
    const fault = connectionFault(
      new DaemonError("Daemon authentication failed", daemonAuthenticationErrorCode, undefined),
    )

    expect(fault.retriable).toBe(false)
    expect(fault.detail).toContain("Pair again in Settings")
  })

  it("stops retrying a protocol mismatch and keeps the versions the daemon named", () => {
    const fault = connectionFault(new DaemonError(
      "This daemon speaks protocol 0.4.0; the client speaks 0.1.0",
      protocolVersionMismatchErrorCode,
      undefined,
    ))

    expect(fault.retriable).toBe(false)
    expect(fault.detail).toContain("0.4.0")
    expect(fault.detail).toContain("0.1.0")
  })

  it("stops retrying a greeting the daemon cannot read, because the next one is the same", () => {
    expect(connectionFault(
      new DaemonError("Method parameters are invalid", -32602, undefined),
    ).retriable).toBe(false)
  })

  it("keeps retrying a socket that never opened, which is the normal case on a phone", () => {
    const fault = connectionFault(new Error("Cannot reach ws://desk:8787"))

    expect(fault.retriable).toBe(true)
    expect(fault.headline).toBe("Cannot reach the daemon")
  })

  it("keeps retrying a refusal it does not recognise rather than giving up on a guess", () => {
    const fault = connectionFault(new DaemonError("Daemon is starting", -32603, undefined))

    expect(fault.retriable).toBe(true)
    expect(fault.detail).toBe("Daemon is starting")
  })

  it("keeps retrying when the daemon closed the socket without answering", () => {
    // The daemon closes an authenticated socket on shutdown and on revocation
    // alike. Retrying once is what tells the two apart: a shut-down daemon
    // comes back, and a revoked credential is refused by code on the next
    // greeting and stops there.
    expect(connectionFault(new Error("The daemon closed the connection")).retriable).toBe(true)
  })
})
