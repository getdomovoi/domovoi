import { afterEach, describe, expect, it, vi } from "vitest"

import type { Runtime } from "@getdomovoi/protocol"

// Security review round 3 of #687: the tool catalog is read immediately
// before the prompt is sent, after everything else the prompt waits on, so a
// tool server added while the prompt's instructions are read is still seen.
// The instruction read is replaced here so the test can add one then.
const instructionsRead = vi.hoisted(() => ({ hook: undefined as (() => void) | undefined }))
vi.mock("./project-instructions.js", () => ({
  projectInstructions: vi.fn(async () => {
    instructionsRead.hook?.()
    return undefined
  }),
}))

const { OpenCodeSdkAdapter, openCodeBuiltInToolIds } = await import("./opencode.js")

afterEach(() => {
  instructionsRead.hook = undefined
})

const runtime: Runtime = { provider: "opencode", model: "anthropic/sonnet", reasoning: "medium", permissionMode: "build", auto: false }

function client() {
  const stream = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<never>>(() => {}) }) }
  return {
    config: { get: vi.fn(async () => ({ data: {} })), providers: vi.fn(async () => ({ data: { providers: [], default: {} } })) },
    session: {
      create: vi.fn(async () => ({ data: { id: "open-session" } })),
      get: vi.fn(async () => ({ data: { id: "open-session" } })),
      delete: vi.fn(async () => ({ data: true })),
      abort: vi.fn(async () => ({ data: true })),
      promptAsync: vi.fn(async () => ({ data: undefined })),
      messages: vi.fn(async (_options?: unknown): Promise<{ data: unknown; response?: Response }> => ({ data: [] })),
      status: vi.fn(async (_options?: unknown): Promise<{ data?: unknown }> => ({ data: {} })),
    },
    event: { subscribe: vi.fn(async () => ({ stream })) },
    postSessionIdPermissionsPermissionId: vi.fn(async () => ({ data: true })),
    mcp: { status: vi.fn(async (_options?: unknown): Promise<{ data?: unknown }> => ({ data: {} })) },
    tool: { ids: vi.fn(async () => ({ data: [...openCodeBuiltInToolIds] })) },
    app: { agents: vi.fn(async () => ({ data: [{ name: "build", mode: "primary", permission: [{ permission: "*", pattern: "*", action: "ask" }] }] })) },
  }
}

describe("the prompt's tool check", () => {
  it("reads the catalog after the prompt's instructions, right before sending it", async () => {
    const fake = client()
    const adapter = new OpenCodeSdkAdapter(async () => ({ client: fake, server: { close: vi.fn(), stop: vi.fn(async () => true) } }), () => "turn-1")
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime })
    instructionsRead.hook = () => fake.mcp.status.mockResolvedValue({ data: { plan: { status: "connected" } } })
    await expect(adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Hello", runtime })).rejects.toThrow(`tool server named "plan"`)
    expect(fake.session.promptAsync).not.toHaveBeenCalled()
    await adapter.close()
  })
})
