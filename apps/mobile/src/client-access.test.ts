import { describe, expect, it, vi } from "vitest"

import { mutationCall, watchingReason } from "./client-access"

describe("client access", () => {
  it("refuses mutation at the handler boundary while watching", async () => {
    const call = vi.fn(async () => undefined)

    await expect(mutationCall("watching", call, "session.send", {})).rejects.toThrow(watchingReason)
    expect(call).not.toHaveBeenCalled()
  })

  it("passes a full-access mutation through unchanged", async () => {
    const call = vi.fn(async () => "sent")

    await expect(mutationCall("full", call, "session.send", { prompt: "ship it" })).resolves.toBe("sent")
    expect(call).toHaveBeenCalledWith("session.send", { prompt: "ship it" })
  })
})
