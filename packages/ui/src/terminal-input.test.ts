import { describe, expect, it, vi } from "vitest"

import { settleTerminalWrite } from "./terminal-input"

describe("settleTerminalWrite", () => {
  it("ignores a deferred write after its terminal is replaced", async () => {
    let resolve!: () => void
    const request = new Promise<void>((done) => { resolve = done })
    const original = {}
    let current: object | null = original
    const focus = vi.fn()
    const reportError = vi.fn()
    const settled = settleTerminalWrite(request, original, () => current, focus, reportError)

    current = {}
    resolve()
    await settled

    expect(focus).not.toHaveBeenCalled()
    expect(reportError).not.toHaveBeenCalled()
  })

  it("reports failures only while the originating terminal is current", async () => {
    const terminal = {}
    const reportError = vi.fn()

    await settleTerminalWrite(
      Promise.reject(new Error("write failed")),
      terminal,
      () => terminal,
      vi.fn(),
      reportError,
    )

    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: "write failed" }))
  })
})
