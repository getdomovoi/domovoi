import { describe, expect, it, vi } from "vitest"

import { createCursorAgentAdapter, createGrokAgentAdapter } from "./acp-factory.js"
import type { AcpPeer, AcpPeerHandlers } from "./acp.js"

const peer: AcpPeer = {
  initialize: vi.fn(async () => undefined),
  startSession: vi.fn(),
  resumeSession: vi.fn(),
  closeSession: vi.fn(async () => undefined),
  setMode: vi.fn(async () => undefined),
  setConfig: vi.fn(async () => undefined),
  prompt: vi.fn(),
  cancel: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
}

describe("ACP provider factories", () => {
  it("falls back to cursor-agent for model discovery", async () => {
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "agent") throw Object.assign(new Error("missing"), { code: "ENOENT" })
      expect([command, ...args]).toEqual(["cursor-agent", "models"])
      return { exitCode: 0, stdout: "gpt-5.4 (default)\n", stderr: "" }
    })
    const createPeer = vi.fn((_handlers: AcpPeerHandlers) => peer)

    const adapter = createCursorAgentAdapter({ run, createPeer })

    await expect(adapter.listModels()).resolves.toEqual([
      expect.objectContaining({ provider: "cursor-agent", id: "gpt-5.4", isDefault: true }),
    ])
  })

  it("uses Grok's documented model catalog command", async () => {
    const run = vi.fn(async (command: string, args: string[]) => {
      expect([command, ...args]).toEqual(["grok", "models"])
      return {
        exitCode: 0,
        stdout: JSON.stringify([{ id: "grok-code-fast-1", default: true }]),
        stderr: "",
      }
    })

    const adapter = createGrokAgentAdapter({ run, createPeer: () => peer })

    await expect(adapter.listModels()).resolves.toEqual([
      expect.objectContaining({ provider: "grok", id: "grok-code-fast-1" }),
    ])
  })

  it("returns a bounded catalog error without leaking CLI output", async () => {
    const run = vi.fn(async () => ({
      exitCode: 1,
      stdout: "token=super-secret",
      stderr: "account secret@example.com expired",
    }))
    const adapter = createGrokAgentAdapter({ run, createPeer: () => peer })

    await expect(adapter.listModels()).rejects.toThrow("Grok model catalog is unavailable")
    await expect(adapter.listModels()).rejects.not.toThrow(/super-secret|secret@example/)
  })
})
