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
    expect(text).toMatch(/^2026-09-12T12:00:00\.000Z succeeded device\.claim device-1 \[daemon rpc\] line one line two$/m)
    expect(text).toMatch(/^more: run again with --before 1$/m)
    expect(text).not.toMatch(/follow/)
  })
})

describe("logs, after peer review", () => {
  it("renders the client's clientId from the protocol type", async () => {
    const call = async () => ({ entries: [entry("3", { actor: { kind: "client", client: "cli", clientId: `device-${"1".repeat(32)}` } })], hasMore: false })
    const text = renderLogs(await readLogs({ call, query: { limit: 1 } }))
    expect(text).toMatch(/\[client device-1111111\]/)
  })
})

// A newline, an escape sequence and a right-to-left override, built from code
// points so the source shows which invisible character each is.
const hostile = `\nX\u001b[31mY${String.fromCodePoint(0x202e)}Z`
const shown = "\\nX\\e[31mY\\u{202e}Z"

describe("logs, with entries that carry control characters", () => {
  it("shows each one escaped and keeps one entry per line; detail still folds whitespace", async () => {
    const call = async () => ({
      entries: [entry(`9${hostile}`, { action: `device.claim${hostile}`, target: `device${hostile}`, sessionId: `ses${hostile}`, detail: `line one${hostile}` })],
      hasMore: true, nextCursor: `9${hostile}`,
    })
    const text = renderLogs(await readLogs({ call, query: { limit: 1 } }))
    expect(text.split("\n")).toEqual([
      `2026-09-12T12:00:00.000Z succeeded device.claim${shown} device${shown} [daemon rpc] session ses${shown} line one X\\e[31mY\\u{202e}Z`,
      `more: run again with --before 9${shown}`,
      "",
    ])
  })

  it("escapes the actor and the time, whatever reached the renderer", () => {
    const text = renderLogs({
      entries: [{ id: "1", occurredAt: `2026-09-12${hostile}`, actor: { kind: "daemon", component: `rpc${hostile}` }, action: "device.claim", outcome: "succeeded" }],
      hasMore: false,
    })
    expect(text).toBe(`2026-09-12${shown} succeeded device.claim [daemon rpc${shown}]\n`)
  })

  it("leaves text in any script unchanged", async () => {
    const call = async () => ({ entries: [entry("1", { target: "מכונה-café", detail: "привет мир" })], hasMore: false })
    expect(renderLogs(await readLogs({ call, query: { limit: 1 } })))
      .toBe("2026-09-12T12:00:00.000Z succeeded device.claim מכונה-café [daemon rpc] привет мир\n")
  })
})
