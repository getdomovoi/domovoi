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

// A new object each call, standing in for the item a token append replaces.
function growing(id: string, body: string): ThreadItem {
  return {
    id,
    sessionId: "session-1",
    kind: "assistant",
    body,
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

// A streaming reply rebuilds the thread array on every token but keeps the
// identity of every item it did not touch. Rebuilding each row from scratch
// throws that away and makes memoisation on a row impossible.
describe("reusing rows the delta did not touch", () => {
  it("returns the same activity row object when its tool calls are unchanged", () => {
    const toolA = tool("a", "completed")
    const toolB = tool("b", "completed")
    const before = groupThreadActivity([toolA, toolB, growing("m1", "Looking")])
    const after = groupThreadActivity([toolA, toolB, growing("m1", "Looking at")], before)

    const beforeRow = before[0]
    const afterRow = after[0]
    expect(afterRow).toBe(beforeRow)
    if (beforeRow?.kind !== "activity" || afterRow?.kind !== "activity") throw new Error("expected an activity row")
    expect(afterRow.items).toBe(beforeRow.items)
  })

  it("returns the same item row object when the item is unchanged", () => {
    const first = message("m1")
    const before = groupThreadActivity([first, growing("m2", "one")])
    const after = groupThreadActivity([first, growing("m2", "one two")], before)

    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
  })

  it("builds a fresh row when a tool call in the run changes", () => {
    const toolA = tool("a", "completed")
    const before = groupThreadActivity([toolA, tool("b", "running")])
    const after = groupThreadActivity([toolA, tool("b", "failed")], before)

    const afterRow = after[0]
    expect(afterRow).not.toBe(before[0])
    if (afterRow?.kind !== "activity") throw new Error("expected an activity row")
    expect(afterRow.items[1]!.failed).toBe(true)
  })

  it("builds fresh rows when the shape of the thread changes under them", () => {
    const toolA = tool("a", "completed")
    const before = groupThreadActivity([message("m1"), toolA])
    const after = groupThreadActivity([toolA], before)

    expect(after).toHaveLength(1)
    expect(after[0]!.kind).toBe("activity")
    expect(after[0]).not.toBe(before[0])
  })
})
