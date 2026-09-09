import type { ThreadItem } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { groupThreadActivity } from "./thread-activity-groups"

function tool(id: string, status: "running" | "completed" | "failed"): ThreadItem {
  return {
    id,
    sessionId: "session-1",
    kind: "tool",
    tool: "command",
    status,
    title: `pnpm run ${id}`,
    createdAt: "2026-09-08T09:00:00.000Z",
  }
}

function message(id: string): ThreadItem {
  return {
    id,
    sessionId: "session-1",
    kind: "assistant",
    body: "Looking at the handler",
    createdAt: "2026-09-08T09:00:00.000Z",
  }
}

describe("collapsing tool calls into one row", () => {
  it("groups a consecutive run into a single activity row", () => {
    const rows = groupThreadActivity([tool("a", "completed"), tool("b", "failed"), tool("c", "completed")])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe("activity")
    expect(rows[0]!.kind === "activity" && rows[0]!.items.map((item) => item.id)).toEqual(["a", "b", "c"])
  })

  it("does not merge across a message, which would reorder what happened", () => {
    const rows = groupThreadActivity([tool("a", "completed"), message("m"), tool("b", "completed")])
    expect(rows.map((row) => row.kind)).toEqual(["activity", "item", "activity"])
  })

  it("marks a failed call as failed rather than leaving it to colour", () => {
    const rows = groupThreadActivity([tool("a", "failed")])
    expect(rows[0]!.kind === "activity" && rows[0]!.items[0]!.failed).toBe(true)
  })

  it("carries output only when there is some", () => {
    const withOutput: ThreadItem = { ...tool("a", "failed"), output: "1 failed" } as ThreadItem
    const rows = groupThreadActivity([withOutput, tool("b", "completed")])
    const items = rows[0]!.kind === "activity" ? rows[0]!.items : []
    expect(items[0]!.log).toBe("1 failed")
    expect(items[1]!.log).toBeUndefined()
  })

  it("leaves every other kind of item exactly where it was", () => {
    const items = [message("m1"), tool("a", "completed"), message("m2")]
    const rows = groupThreadActivity(items)
    expect(rows.map((row) => row.kind === "item" ? row.item.id : row.kind)).toEqual(["m1", "activity", "m2"])
  })
})
