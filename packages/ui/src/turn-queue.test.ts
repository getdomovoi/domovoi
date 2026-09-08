import { describe, expect, it } from "vitest"

import { submitFromComposer } from "./turn-queue"

describe("sending while a turn is running", () => {
  it("sends when nothing is running", () => {
    expect(submitFromComposer({ text: "  add a test  ", turnRunning: false, queued: undefined }))
      .toEqual({ action: "send", text: "add a test" })
  })

  it("queues rather than cancelling the turn", () => {
    const outcome = submitFromComposer({ text: "also update the readme", turnRunning: true, queued: undefined })
    expect(outcome.action).toBe("queue")
    // The word that must never appear here is cancel. There is no path from
    // this function to stopping a turn.
    expect(JSON.stringify(outcome)).not.toMatch(/cancel|stop|abort/i)
  })

  it("says a second message replaces the first rather than stacking", () => {
    const outcome = submitFromComposer({ text: "and the changelog", turnRunning: true, queued: "also update the readme" })
    expect(outcome).toEqual({
      action: "queue",
      text: "and the changelog",
      note: "replaces the queued message",
    })
  })

  it("ignores an empty submit in either state", () => {
    expect(submitFromComposer({ text: "   ", turnRunning: false, queued: undefined })).toEqual({ action: "ignore" })
    expect(submitFromComposer({ text: "", turnRunning: true, queued: "queued" })).toEqual({ action: "ignore" })
  })
})
