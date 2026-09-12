import { describe, expect, it } from "vitest"

import { readLogs, renderLogs } from "./logs.js"

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id, occurredAt: "2026-09-12T12:00:00.000Z", actor: { kind: "daemon", component: "rpc" }, action: "device.claim", outcome: "succeeded", ...extra,
})

describe("logs", () => {
  it("passes only the filters given, with the limit", async () => {
    const seen: Record<string, unknown>[] = []
    const call = async (_method: string, params: Record<string, unknown>) => { seen.push(params); return { entries: [entry("1")], hasMore: false } }
    await readLogs({ call, query: { limit: 20, action: "device.claim" } })
    expect(seen).toEqual([{ limit: 20, action: "device.claim" }])
  })

  it("renders one line per entry and says how to page, never that it follows", async () => {
    const call = async () => ({ entries: [entry("2", { target: "device-1", detail: "line one\nline two" }), entry("1")], hasMore: true, nextCursor: "1" })
    const page = await readLogs({ call, query: { limit: 2 } })
    const text = renderLogs(page)
    expect(text.split("\n").filter(Boolean)).toHaveLength(3)
    expect(text).toMatch(/^2026-09-12T12:00:00\.000Z succeeded device\.claim device-1 \[daemon\] line one line two$/m)
    expect(text).toMatch(/^more: run again with --before 1$/m)
    expect(text).not.toMatch(/follow/)
  })
})
