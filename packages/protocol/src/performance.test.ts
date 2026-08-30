import { describe, expect, it } from "vitest"
import { boundedClientThread, maximumClientSnapshotThreadItems } from "./performance.js"

describe("boundedClientThread", () => {
  it("keeps an exact hard cap when source entries repeat by reference", () => {
    const inactive = { sessionId: "inactive" }
    const active = { sessionId: "active" }
    const items = [
      ...Array.from({ length: 200 }, () => inactive),
      ...Array.from({ length: 50 }, () => active),
    ]

    const bounded = boundedClientThread(items, "active")

    expect(bounded).toHaveLength(maximumClientSnapshotThreadItems)
    expect(bounded.slice(0, 50)).toEqual(Array.from({ length: 50 }, () => inactive))
    expect(bounded.slice(50)).toEqual(Array.from({ length: 50 }, () => active))
  })
})
