import { describe, expect, it, vi } from "vitest"

import { mutationCall, watchingReason } from "./client-access"

describe("client access", () => {
  it("refuses mutation at the handler boundary while watching", async () => {
    const call = vi.fn(async () => undefined)

    await expect(mutationCall("watching", call, "session.send", { sessionId: "session-1", prompt: "ship it", client: "phone" })).rejects.toThrow(watchingReason)
    expect(call).not.toHaveBeenCalled()
  })

  it("passes a full-access mutation through unchanged", async () => {
    const call = vi.fn(async () => "sent")

    const params = { sessionId: "session-1", prompt: "ship it", client: "phone" as const }
    await expect(mutationCall("full", call, "session.send", params)).resolves.toBe("sent")
    expect(call).toHaveBeenCalledWith("session.send", params)
  })
})
