import { describe, expect, it } from "vitest"

import { DaemonTimeoutError, defaultRequestTimeoutMs, requestTimeoutMs } from "./request-timeout"

describe("requestTimeoutMs", () => {
  it("gives a pull-to-refresh a shorter wait than work the person asked for", () => {
    expect(requestTimeoutMs("workspace.get")).toBeLessThan(requestTimeoutMs("session.send"))
    expect(requestTimeoutMs("session.send")).toBe(defaultRequestTimeoutMs)
  })
})

describe("DaemonTimeoutError", () => {
  it("says what went unanswered and for how long, in seconds a person reads", () => {
    const error = new DaemonTimeoutError("session.send", 30_000)

    expect(error.message).toBe("session.send got no answer in 30 seconds")
    expect(error.method).toBe("session.send")
    expect(error).toBeInstanceOf(Error)
  })
})
