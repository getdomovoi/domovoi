import { once } from "node:events"

import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import {
  demoWorkspace,
  protocolVersion,
  workspaceSnapshotSchema,
  type ExecutionResolution,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent } from "./codex.js"
import type { WorkspaceStore } from "./store.js"
import { waitForDaemon } from "./test-wait-for.js"

const gate = vi.hoisted(() => ({
  park: false,
  execution: undefined as unknown,
  parked: undefined as undefined | ((value: unknown) => void),
  arrived: () => {},
}))

vi.mock("./execution-resolution.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./execution-resolution.js")>()
  return {
    ...original,
    // The card is raised with the package script resolved; the read the
    // Allow makes is the one held open.
    resolveExecution: vi.fn(() => gate.park
      ? new Promise((resolve) => {
        gate.parked = resolve
        gate.arrived()
      })
      : Promise.resolve(gate.execution)),
  }
})

const { DomovoiDaemon } = await import("./server.js")

const daemons: InstanceType<typeof DomovoiDaemon>[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

const execution: ExecutionResolution = {
  state: "resolved",
  digest: `sha256:${"a".repeat(64)}`,
  record: {
    version: 1,
    coverage: "command-and-script-text",
    cwd: ".",
    kind: "shell",
    entries: [{
      id: 0,
      source: { kind: "request" },
      parts: [{ operator: null, argv: ["pnpm", "run", "test"], expandsTo: [1] }],
    }, {
      id: 1,
      source: {
        kind: "package-script", manager: "pnpm", manifest: "package.json", name: "test", phase: "main",
        arguments: [], sourceDigest: `sha256:${"b".repeat(64)}`,
      },
      parts: [{ operator: null, argv: ["vitest", "run"], expandsTo: [] }],
    }],
  },
}

function billingSession(worktree: boolean): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const session = snapshot.sessions.find((candidate) => candidate.id === "session-billing")!
  session.runtime = { ...session.runtime, provider: "codex", model: "gpt-5.6-sol" }
  session.state = "idle"
  if (worktree) session.workspacePath = "/worktrees/session-billing"
  else delete session.workspacePath
  session.providerThreadId = "thread-billing"
  delete session.activeTurnId
  // A stored card expires when the daemon starts, so the gate is raised after.
  snapshot.approvals = []
  return workspaceSnapshotSchema.parse(snapshot)
}

describe("an approval allowed while an emergency stop runs", () => {
  // Later steps also miss a card the stop removed, but with a worktree a late
  // allow would first take a checkpoint after the stop. Both cases are
  // refused where the package scripts have just been read.
  it.each([
    { worktree: true, label: "with a worktree" },
    { worktree: false, label: "without a worktree" },
  ])("keeps the stop's denial when the package script check finishes afterwards, $label", async ({ worktree }) => {
    let emit: (event: AgentEvent) => void = () => {}
    const provider = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => []),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "turn-billing"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn((listener: (event: AgentEvent) => void) => { emit = listener; return () => {} }),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const store = {
      load: () => billingSession(worktree),
      save: vi.fn(),
      close: vi.fn(),
    } satisfies WorkspaceStore
    const daemon = new DomovoiDaemon({ port: 0, store, agents: { codex: provider }, errorSink: vi.fn() })
    daemons.push(daemon)
    const { port } = await daemon.start()
    const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { handshakeTimeout: 5_000 })
    sockets.push(socket)
    await once(socket, "open")
    const responses = new Map<number, (message: { result?: unknown; error?: { code: number; message: string } }) => void>()
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { id?: number; result?: unknown; error?: { code: number; message: string } }
      if (message.id !== undefined) responses.get(message.id)?.(message)
    })
    let nextId = 0
    const rpc = (method: string, params: Record<string, unknown>) =>
      new Promise<{ result?: unknown; error?: { code: number; message: string } }>((resolve) => {
        const id = ++nextId
        responses.set(id, resolve)
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      })
    expect((await rpc("system.hello", {
      client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
    })).error).toBeUndefined()

    gate.park = false
    gate.execution = execution
    // A session without a worktree cannot start a turn, so its provider
    // raises the gate on the thread without one.
    if (worktree) {
      expect((await rpc("session.send", { sessionId: "session-billing", prompt: "run the tests", client: "desktop" })).error).toBeUndefined()
    }
    emit({
      type: "approval-requested", requestId: 17, threadId: "thread-billing", itemId: "call_test", command: "pnpm run test",
      ...(worktree ? { turnId: "turn-billing" } : {}),
    })
    const card = await waitForDaemon(async () => {
      const [raised] = workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result).approvals
      expect(raised?.execution).toMatchObject({ state: "resolved" })
      return raised!
    })

    gate.park = true
    const arrived = new Promise<void>((resolve) => { gate.arrived = resolve })
    const allowed = rpc("approval.resolve", { approvalId: card.id, decision: "allow-once", client: "desktop", revision: card.revision })
    await arrived
    expect((await rpc("system.emergencyStop", { client: "desktop" })).error).toBeUndefined()
    expect(provider.resolveApproval).toHaveBeenCalledWith(17, "deny")
    gate.parked!(execution)

    // Refused as withdrawn, before a checkpoint is attempted or the card
    // could be rewritten, not by a later step that happens to miss it.
    expect((await allowed).error?.message).toBe("The approval was withdrawn before it could be allowed")
    expect(provider.resolveApproval).not.toHaveBeenCalledWith(17, "allow-once")
    await waitForDaemon(async () => {
      const workspace = workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
      expect(workspace.thread.filter((item) => item.kind === "receipt").map((item) => item.kind === "receipt" && item.decision))
        .not.toContain("allow-once")
      expect(workspace.sessions.find((session) => session.id === "session-billing")?.state).not.toBe("active")
    })
  })
})
