import {
  demoWorkspace,
  maximumProviderPromptCodeUnits,
  protocolVersion,
  type RpcMethod,
  type RpcResult,
} from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"
import WebSocket from "ws"

import type { AgentAdapter, AgentEvent } from "./agents.js"
import type { AuditLog } from "./audit-log.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore, type WorkspaceStore } from "./store.js"
import { waitForDaemon } from "./test-wait-for.js"

const running: DomovoiDaemon[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(running.splice(0).map((daemon) => daemon.stop()))
})

async function sendFor(options: { providerPromptBudgetCodeUnits: number; prompt: string }) {
  const snapshot = structuredClone(demoWorkspace)
  const session = snapshot.sessions[0]!
  session.state = "idle"
  session.workspacePath = "/worktrees/budget"
  session.providerThreadId = "thread-budget"
  delete session.activeTurnId
  snapshot.approvals = []
  snapshot.annotations = []
  snapshot.workingPlans = []
  snapshot.skillEnablements = []
  snapshot.thread = snapshot.thread.filter((item) => item.kind !== "system")
  const initial = structuredClone(snapshot)
  let durable = structuredClone(snapshot)
  const store = {
    load: () => structuredClone(durable),
    save: (next: typeof snapshot) => { durable = structuredClone(next) },
    close: () => {},
  } satisfies WorkspaceStore
  const auditLog = {
    append: (input: Parameters<AuditLog["append"]>[0]) => ({
      id: "audit-budget",
      occurredAt: "2026-09-04T20:00:00.000Z",
      ...input,
    }),
    query: () => ({ entries: [], hasMore: false }),
    export: () => ({
      format: "jsonl" as const,
      exportedAt: "2026-09-04T20:00:00.000Z",
      content: "",
      entryCount: 0,
      hasMore: false,
    }),
  } satisfies AuditLog
  const prompts: string[] = []
  const agent = {
    connect: async () => {},
    listModels: async () => [],
    startThread: async () => "thread-budget",
    resumeThread: async () => {},
    stopThread: async () => {},
    interruptTurn: async () => {},
    startTurn: async (input: Parameters<AgentAdapter["startTurn"]>[0]) => {
      prompts.push(input.prompt)
      return "turn-budget"
    },
    steerTurn: async () => {},
    resolveApproval: () => {},
    onEvent: (_listener: (event: AgentEvent) => void) => () => {},
    close: async () => {},
  } satisfies AgentAdapter

  const daemon = new DomovoiDaemon({
    port: 0,
    store,
    agents: { [session.runtime.provider]: agent },
    auditLog,
    artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    providerPromptBudgetCodeUnits: options.providerPromptBudgetCodeUnits,
  })
  running.push(daemon)
  const address = await daemon.start()
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
    headers: { authorization: `Bearer ${daemon.authToken}` },
  })
  sockets.push(socket)
  await waitForDaemon(() => expect(socket.readyState).toBe(WebSocket.OPEN))
  const responses = new Map<number, Record<string, unknown>>()
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown> & { id?: number }
    if (typeof message.id === "number") responses.set(message.id, message)
  })
  let nextId = 0
  const rpc = async <M extends RpcMethod>(method: M, params: Record<string, unknown>) => {
    const id = ++nextId
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    return waitForDaemon(() => {
      const response = responses.get(id)
      expect(response).toBeDefined()
      return response as Record<string, unknown> & { result: RpcResult<M> }
    })
  }
  await rpc("system.hello", {
    client: "desktop",
    clientId: "desktop-budget",
    clientVersion: "0.0.1",
    protocolVersion,
  })
  const sent = await rpc("session.send", {
    sessionId: session.id,
    prompt: options.prompt,
    client: "desktop",
  })
  return { durable, initial, prompts, sent }
}

describe("provider prompt budget option", () => {
  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    maximumProviderPromptCodeUnits + 1,
  ])("rejects an invalid budget before loading workspace state: %s", (providerPromptBudgetCodeUnits) => {
    const loadStore = vi.spyOn(SqliteWorkspaceStore.prototype, "load")
    expect(() => {
      const daemon = new DomovoiDaemon({ statePath: ":memory:", providerPromptBudgetCodeUnits })
      running.push(daemon)
    }).toThrow(RangeError)
    expect(loadStore).not.toHaveBeenCalled()
  })

  it("records the configured budget on the sent turn", async () => {
    const { durable, prompts, sent } = await sendFor({
      providerPromptBudgetCodeUnits: 20_000,
      prompt: "Ship it",
    })

    expect(sent).not.toHaveProperty("error")
    expect(prompts).toHaveLength(1)
    expect(durable.thread.findLast((item) => item.kind === "user")).toMatchObject({
      providerPromptDelivery: {
        budget: { unit: "utf16-code-units", limit: 20_000, used: prompts[0]!.length },
      },
    })
  })

  it("refuses a request the configured budget cannot carry", async () => {
    const { durable, initial, prompts, sent } = await sendFor({
      providerPromptBudgetCodeUnits: 20_000,
      prompt: "u".repeat(20_001),
    })

    expect(sent).toMatchObject({
      error: {
        code: -32602,
        message: expect.stringMatching(/user request exceed the 20000 UTF-16 code units/),
      },
    })
    expect(prompts).toEqual([])
    expect(durable.thread).toEqual(initial.thread)
  })
})
