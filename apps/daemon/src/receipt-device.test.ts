import { once } from "node:events"

import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import { demoWorkspace, protocolVersion, workspaceSnapshotSchema, type ClientKind, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent } from "./codex.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { waitForDaemon } from "./test-wait-for.js"
import type { WorkspaceService } from "./workspace.js"

// Ruling Q424 A: a receipt names the paired device that decided, from the
// device record the daemon verified on the deciding connection, in the shape a
// terminal owner names it. A connection on the daemon credential has no paired
// device, so its receipts carry none.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

const sessionId = "session-billing"
const threadId = "thread-billing"
const checkpointCommit = "c".repeat(40)

function pendingApproval(): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId)!
  session.runtime = { ...session.runtime, provider: "codex", model: "gpt-5.6-sol" }
  session.state = "idle"
  session.workspacePath = "/worktrees/session-billing"
  session.providerThreadId = threadId
  delete session.activeTurnId
  snapshot.approvals = []
  return workspaceSnapshotSchema.parse(snapshot)
}

type Reply = { result?: unknown, error?: { code: number, message: string } }

async function connect(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`)
  sockets.push(socket)
  await once(socket, "open")
  const responses = new Map<number, (message: Reply) => void>()
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as { id?: number }
    if (message.id !== undefined) responses.get(message.id)?.(message as Reply)
  })
  let nextId = 0
  return (method: string, params: Record<string, unknown>) => new Promise<Reply>((resolve) => {
    const id = ++nextId
    responses.set(id, resolve)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  })
}

async function start() {
  let emit: (event: AgentEvent) => void = () => {}
  const provider = {
    connect: vi.fn(async () => {}), listModels: vi.fn(async () => []),
    startThread: vi.fn(async () => "unused"), resumeThread: vi.fn(async () => {}), stopThread: vi.fn(async () => {}),
    startTurn: vi.fn(async () => "turn-billing"), steerTurn: vi.fn(async () => {}), interruptTurn: vi.fn(async () => {}),
    resolveApproval: vi.fn(),
    onEvent: vi.fn((listener: (event: AgentEvent) => void) => { emit = listener; return () => {} }),
    close: vi.fn(async () => {}),
  } satisfies AgentAdapter
  const workspaceService = {
    inspect: vi.fn(), createSessionWorkspace: vi.fn(), removeSessionWorkspace: vi.fn(), restore: vi.fn(),
    checkpoint: vi.fn(async () => ({ commit: "a".repeat(40), changedFiles: [] })),
    snapshot: vi.fn(async () => ({ commit: checkpointCommit, changedFiles: ["db/schema.sql"] })),
    archiveSessionWorkspace: vi.fn(async () => {}),
    revertFile: vi.fn(async (_workspace: string, path: string) => ({
      path, outcome: "restored" as const, baseCommit: "b".repeat(40), recoveryCommit: "d".repeat(40),
    })),
  } satisfies WorkspaceService
  const store = new SqliteWorkspaceStore(":memory:", pendingApproval())
  const daemon = new DomovoiDaemon({
    port: 0, store,
    agents: { codex: provider }, workspaceService, errorSink: vi.fn(),
  })
  daemons.push(daemon)
  const { port } = await daemon.start()
  const owner = await connect(port)
  expect((await owner("system.hello", { client: "cli", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken })).error).toBeUndefined()
  const snapshot = async () => workspaceSnapshotSchema.parse((await owner("workspace.get", {})).result)

  // A connection holding a paired device credential, as the daemon verified it.
  const paired = async (label: string, client: ClientKind) => {
    const minted = await owner("device.pair", { label, client: "cli", targetClient: client })
    expect(minted.error?.message).toBeUndefined()
    const { token, device } = minted.result as { token: string, device: { id: string, label: string } }
    expect(device.label).toBe(label)
    const rpc = await connect(port)
    expect((await rpc("system.hello", { client, clientVersion: "0.0.1", protocolVersion, authToken: token })).error).toBeUndefined()
    return { rpc, device }
  }

  const raiseGate = async (client: ClientKind, rpc = owner) => {
    const sent = await rpc("session.send", { sessionId, prompt: "run the migrations", client })
    expect(sent.error?.message).toBeUndefined()
    return raiseAnotherGate(41)
  }

  // A further gate on the turn the first one opened, with nothing decided
  // between: the turn is still running, so no second send is needed.
  const raiseAnotherGate = async (requestId: number) => {
    emit({ type: "approval-requested", requestId, threadId, turnId: "turn-billing", itemId: `call_migrate_${requestId}`, command: "pnpm migrate" })
    await waitForDaemon(async () => expect((await snapshot()).approvals).toHaveLength(1))
    return (await snapshot()).approvals[0]!
  }

  const receipts = async () => (await snapshot()).thread.filter((item) => item.kind === "receipt")
  const history = async () => {
    const page = await owner("session.history", { sessionId, categories: ["approvals"] })
    return (page.result as { items: Array<Record<string, unknown>> }).items
  }
  return { provider, owner, store, snapshot, paired, raiseGate, raiseAnotherGate, receipts, history, emit: (event: AgentEvent) => emit(event) }
}

describe("the deciding device on a receipt", () => {
  it("names the paired device that allowed, on the receipt and in approval history", async () => {
    const { paired, raiseGate, receipts, history } = await start()
    const phone = await paired("dana", "phone")
    const card = await raiseGate("phone", phone.rpc)
    expect((await phone.rpc("approval.resolve", { approvalId: card.id, decision: "allow-once", revision: card.revision, client: "phone" })).error).toBeUndefined()
    const [receipt] = await receipts()
    expect(receipt).toMatchObject({ decision: "allow-once", client: "phone", device: { id: phone.device.id, label: "dana" } })
    expect((await history())[0]).toMatchObject({ category: "approvals", device: { id: phone.device.id, label: "dana" } })
  })

  // The label is a person's own text, so a secret in it is replaced before
  // the receipt enters the snapshot; history copies the receipt, so it reads
  // the same. The device's id is an identifier and stays.
  it("redacts a secret in the deciding device's label on the receipt and in history", async () => {
    const { paired, raiseGate, receipts, history, snapshot } = await start()
    const phone = await paired("office NPM_TOKEN=label-secret-1", "phone")
    const card = await raiseGate("phone", phone.rpc)
    expect((await phone.rpc("approval.resolve", { approvalId: card.id, decision: "allow-once", revision: card.revision, client: "phone" })).error).toBeUndefined()
    const [receipt] = await receipts()
    expect(receipt).toMatchObject({ device: { id: phone.device.id, label: "office NPM_TOKEN=[REDACTED]" } })
    expect((await history())[0]).toMatchObject({ device: { id: phone.device.id, label: "office NPM_TOKEN=[REDACTED]" } })
    expect(JSON.stringify(await snapshot())).not.toContain("label-secret-1")
  })

  // The receipt names the label the device had when it acted, read from the
  // registry row at the decision, not the label the credential carried at
  // hello. A receipt written before the rename keeps the earlier label.
  it("names the label the device has at the decision, not the one it had at hello", async () => {
    const { owner, paired, raiseGate, raiseAnotherGate, receipts } = await start()
    const phone = await paired("office", "phone")
    const first = await raiseGate("phone", phone.rpc)
    expect((await phone.rpc("approval.resolve", { approvalId: first.id, decision: "allow-once", revision: first.revision, client: "phone" })).error).toBeUndefined()
    expect((await owner("device.rename", { deviceId: phone.device.id, label: "travel" })).error).toBeUndefined()
    const second = await raiseAnotherGate(42)
    expect((await phone.rpc("approval.resolve", { approvalId: second.id, decision: "deny", revision: second.revision, client: "phone" })).error).toBeUndefined()
    expect(await receipts()).toEqual([
      expect.objectContaining({ decision: "allow-once", device: { id: phone.device.id, label: "office" } }),
      expect.objectContaining({ decision: "deny", device: { id: phone.device.id, label: "travel" } }),
    ])
  })

  it("names the label the device has when it presses the emergency stop", async () => {
    const { owner, paired, raiseGate, receipts } = await start()
    const desktop = await paired("studio-mac", "desktop")
    await raiseGate("desktop", desktop.rpc)
    expect((await owner("device.rename", { deviceId: desktop.device.id, label: "kitchen-mac" })).error).toBeUndefined()
    expect((await desktop.rpc("system.emergencyStop", { client: "desktop" })).error).toBeUndefined()
    expect(await receipts()).toContainEqual(expect.objectContaining({
      explanation: "Emergency stop", device: { id: desktop.device.id, label: "kitchen-mac" },
    }))
  })

  // A device revoked between hello and the decision is refused at the
  // request, as every request on a paired credential rechecks that it is
  // still active, so no receipt is written and the gate stays open.
  it("refuses a decision from a device revoked since hello and writes no receipt", async () => {
    const { store, paired, raiseGate, receipts, snapshot } = await start()
    const phone = await paired("office", "phone")
    const card = await raiseGate("phone", phone.rpc)
    store.devices.revoke(phone.device.id)
    const refused = await phone.rpc("approval.resolve", { approvalId: card.id, decision: "allow-once", revision: card.revision, client: "phone" })
    expect(refused.error?.message).toBe("Daemon authentication failed")
    expect(await receipts()).toEqual([])
    expect((await snapshot()).approvals).toHaveLength(1)
  })

  it("writes no device for a decision made on the daemon credential", async () => {
    const { owner, raiseGate, receipts, history } = await start()
    const card = await raiseGate("cli")
    expect((await owner("approval.resolve", { approvalId: card.id, decision: "deny", client: "cli" })).error).toBeUndefined()
    const [receipt] = await receipts()
    expect(receipt).toMatchObject({ decision: "deny", client: "cli" })
    expect(receipt).not.toHaveProperty("device")
    expect((await history())[0]).not.toHaveProperty("device")
  })

  it("names the device that archived the session on the receipts the archive denies", async () => {
    const { paired, raiseGate, receipts } = await start()
    const desktop = await paired("studio-mac", "desktop")
    await raiseGate("desktop", desktop.rpc)
    expect((await desktop.rpc("session.archive", { sessionId, client: "desktop" })).error).toBeUndefined()
    expect(await receipts()).toContainEqual(expect.objectContaining({
      decision: "deny", explanation: "Session archived", client: "desktop", device: { id: desktop.device.id, label: "studio-mac" },
    }))
  })

  it("names the device that pressed the emergency stop on the receipts the stop denies", async () => {
    const { paired, raiseGate, receipts } = await start()
    const desktop = await paired("studio-mac", "desktop")
    await raiseGate("desktop", desktop.rpc)
    expect((await desktop.rpc("system.emergencyStop", { client: "desktop" })).error).toBeUndefined()
    expect(await receipts()).toContainEqual(expect.objectContaining({
      decision: "deny", explanation: "Emergency stop", client: "desktop", device: { id: desktop.device.id, label: "studio-mac" },
    }))
  })

  it("names the device that reverted a file on the revert receipt", async () => {
    const { paired, receipts } = await start()
    const desktop = await paired("studio-mac", "desktop")
    expect((await desktop.rpc("session.revertFile", { sessionId, path: "db/schema.sql", client: "desktop" })).error).toBeUndefined()
    expect(await receipts()).toContainEqual(expect.objectContaining({
      decision: "allow-once", operation: "Revert db/schema.sql", client: "desktop", device: { id: desktop.device.id, label: "studio-mac" },
    }))
  })
})
