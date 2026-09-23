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

import type { AgentAdapter } from "./codex.js"
import type { WorkspaceStore } from "./store.js"
import { waitForDaemon } from "./test-wait-for.js"

const gate = vi.hoisted(() => ({
  parked: undefined as undefined | ((value: unknown) => void),
  arrived: () => {},
}))

vi.mock("./execution-resolution.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./execution-resolution.js")>()
  return {
    ...original,
    resolveExecution: vi.fn(() => new Promise((resolve) => {
      gate.parked = resolve
      gate.arrived()
    })),
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

function waitingOnPackageScript(): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const session = snapshot.sessions.find((candidate) => candidate.id === "session-billing")!
  session.runtime = { ...session.runtime, provider: "codex", model: "gpt-5.6-sol" }
  session.state = "waiting"
  session.workspacePath = "/worktrees/session-billing"
  session.providerThreadId = "thread-billing"
  delete session.activeTurnId
  snapshot.approvals = [{
    ...demoWorkspace.approvals[0]!, risk: "normal", command: "pnpm run test", providerRequestId: 17, execution,
  }]
  return workspaceSnapshotSchema.parse(snapshot)
}

describe("an approval allowed while an emergency stop runs", () => {
  it("keeps the stop's denial when the package script check finishes afterwards", async () => {
    const provider = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => []),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "unused"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const store = {
      load: () => waitingOnPackageScript(),
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

    const arrived = new Promise<void>((resolve) => { gate.arrived = resolve })
    const allowed = rpc("approval.resolve", { approvalId: "approval-migrate", decision: "allow-once", client: "desktop" })
    await arrived
    expect((await rpc("system.emergencyStop", { client: "desktop" })).error).toBeUndefined()
    expect(provider.resolveApproval).toHaveBeenCalledWith(17, "deny")
    gate.parked!(execution)

    expect((await allowed).error).toBeDefined()
    expect(provider.resolveApproval).not.toHaveBeenCalledWith(17, "allow-once")
    await waitForDaemon(async () => {
      const workspace = workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
      expect(workspace.thread.filter((item) => item.kind === "receipt").map((item) => item.kind === "receipt" && item.decision))
        .not.toContain("allow-once")
      expect(workspace.sessions.find((session) => session.id === "session-billing")?.state).not.toBe("active")
    })
  })
})
