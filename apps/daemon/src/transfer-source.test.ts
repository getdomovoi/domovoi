import { createHash } from "node:crypto"

import { describe, expect, it, vi } from "vitest"

import {
  demoWorkspace,
  protocolVersion,
  type FleetMachine,
  type SessionSummary,
  type TransferReceipt,
} from "@getdomovoi/protocol"

import { maximumTransferChunkBytes } from "@getdomovoi/protocol"
import { sendSessionToMachine, transferSenderChunkBytes } from "./transfer-source.js"

const bundle = Buffer.from("PACK".repeat(400))
const digest = createHash("sha256").update(bundle).digest("hex")
const sourceMachineId = `machine-${"a".repeat(32)}`

const target: FleetMachine = {
  id: `machine-${"b".repeat(32)}`,
  label: "studio",
  platform: "linux",
  arch: "x64",
  version: "0.0.1",
  connection: "tailnet",
  capabilities: ["sessions"],
  heartbeat: { state: "online", lastSeenAt: "2026-09-01T09:00:00.000Z" },
  protocolVersion,
  transports: [
    { kind: "tailnet", endpoint: "wss://studio.tailnet:47831/rpc", authenticated: true },
  ],
  health: "healthy",
  self: false,
}

const session: SessionSummary = {
  ...demoWorkspace.sessions[0]!,
  state: "idle",
  workspacePath: "/worktrees/session-1",
}
delete (session as { activeTurnId?: string }).activeTurnId

type TransferCall = (method: string, params: Record<string, unknown>) => Promise<unknown>

function transferIo(overrides: { call?: TransferCall } = {}) {
  const recorded: TransferReceipt[] = []
  const call = vi.fn<TransferCall>(overrides.call ?? (async (method: string) => {
    if (method === "transfer.have") return {}
    if (method === "transfer.begin") return { transferId: `transfer-${"c".repeat(32)}` }
    return { state: "restored", workspacePath: "/worktrees/session-1", checkpointCommit: "d".repeat(40) }
  }))
  return {
    call,
    recorded,
    checkpoint: vi.fn(async () => ({ commit: "d".repeat(40), changedFiles: [] })),
    bundleSession: vi.fn(async (
      _worktree: string,
      bundlePath: string,
      _sinceCommit?: string,
    ) => ({ path: bundlePath, commit: "d".repeat(40), incremental: false })),
    readBundle: vi.fn(async () => bundle),
    removeBundle: vi.fn(async () => {}),
    recordReceipt: vi.fn((receipt: TransferReceipt) => { recorded.push(receipt) }),
    now: () => "2026-09-01T09:00:00.000Z",
  }
}

describe("sendSessionToMachine", () => {
  it("moves a session and records what happened", async () => {
    const { recorded, ...io } = transferIo()

    const outcome = await sendSessionToMachine({
      session,
      sourceMachineId,
      target,
      client: "desktop",
      ...io,
    })

    expect(outcome).toMatchObject({ outcome: "succeeded" })
    expect(io.call).toHaveBeenCalledWith("transfer.begin", expect.objectContaining({
      sessionId: session.id,
      sourceMachineId,
      digest,
      totalBytes: bundle.length,
    }))
    expect(recorded).toEqual([expect.objectContaining({
      sessionId: session.id,
      outcome: "succeeded",
      recoveryCheckpointRetained: true,
    })])
  })

  it("sends the bundle in chunks the target will take", async () => {
    const { recorded: _recorded, ...io } = transferIo()

    await sendSessionToMachine({ session, sourceMachineId, target, client: "desktop", ...io })

    const chunks = io.call.mock.calls.filter(([method]) => method === "transfer.chunk")
    expect(chunks.length).toBeGreaterThan(0)
    for (const [, params] of chunks) {
      const encoded = (params as { bytes: string }).bytes
      expect(Buffer.from(encoded, "base64").length).toBeLessThanOrEqual(maximumTransferChunkBytes)
    }
    expect((chunks.at(-1)![1] as { final: boolean }).final).toBe(true)
  })

  it("refuses a machine the preflight will not allow, before any bytes", async () => {
    const { recorded, ...io } = transferIo()

    const outcome = await sendSessionToMachine({
      session,
      sourceMachineId,
      target: { ...target, health: "unreachable" },
      client: "desktop",
      ...io,
    })

    expect(outcome).toMatchObject({ outcome: "refused", reason: "target-unreachable" })
    expect(io.call).not.toHaveBeenCalled()
    expect(io.bundleSession).not.toHaveBeenCalled()
    expect(recorded).toEqual([expect.objectContaining({ outcome: "refused", reason: "target-unreachable" })])
  })

  it("refuses to move a session with a turn in flight", async () => {
    const { recorded: _recorded, ...io } = transferIo()

    const outcome = await sendSessionToMachine({
      session: { ...session, state: "active" },
      sourceMachineId,
      target,
      client: "desktop",
      ...io,
    })

    expect(outcome).toMatchObject({ outcome: "refused", reason: "session-turn-active" })
    expect(io.call).not.toHaveBeenCalled()
  })

  it("records a refusal when the target will not take the bundle", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "transfer.have") return {}
      if (method === "transfer.begin") return { transferId: `transfer-${"c".repeat(32)}` }
      return { state: "refused", reason: "digest-mismatch" }
    })
    const { recorded, ...io } = transferIo({ call })

    const outcome = await sendSessionToMachine({
      session,
      sourceMachineId,
      target,
      client: "desktop",
      ...io,
    })

    // A bundle the target rejected is a refusal with a reason, not a transfer
    // that broke on the way.
    expect(outcome).toMatchObject({ outcome: "refused", reason: "digest-mismatch" })
    expect(recorded).toEqual([expect.objectContaining({
      outcome: "refused",
      reason: "digest-mismatch",
    })])
  })

  it("does not call a transfer done before the last chunk was sent", async () => {
    // A target claiming the session arrived while bytes remain has not taken
    // the whole worktree, whatever it says.
    const call = vi.fn<TransferCall>(async (method: string) => {
      if (method === "transfer.have") return {}
      if (method === "transfer.begin") return { transferId: `transfer-${"c".repeat(32)}` }
      return { state: "restored", workspacePath: "/worktrees/session-1", checkpointCommit: "d".repeat(40) }
    })
    const { recorded, ...io } = transferIo({ call })
    const large = Buffer.alloc(transferSenderChunkBytes * 2, 7)
    io.readBundle = vi.fn(async () => large)

    const outcome = await sendSessionToMachine({
      session,
      sourceMachineId,
      target,
      client: "desktop",
      ...io,
    })

    expect(outcome).toMatchObject({ outcome: "failed" })
    expect(recorded).toEqual([expect.objectContaining({ outcome: "failed" })])
  })

  it("keeps the source worktree whatever happens", async () => {
    const { recorded, ...io } = transferIo({
      call: async () => { throw new Error("the machine went away") },
    })

    const outcome = await sendSessionToMachine({
      session,
      sourceMachineId,
      target,
      client: "desktop",
      ...io,
    })

    // The session is still here, and the receipt says so.
    expect(outcome).toMatchObject({ outcome: "failed" })
    expect(recorded).toEqual([expect.objectContaining({ recoveryCheckpointRetained: true })])
  })
})

describe("sendSessionToMachine incremental", () => {
  it("bundles only what the target says it is missing", async () => {
    const held = "e".repeat(40)
    const bundled: (string | undefined)[] = []
    const call = vi.fn<TransferCall>(async (method: string) => {
      if (method === "transfer.have") return { commit: held }
      if (method === "transfer.begin") return { transferId: `transfer-${"c".repeat(32)}` }
      return { state: "restored", workspacePath: "/worktrees/session-1", checkpointCommit: "d".repeat(40) }
    })
    const { recorded: _recorded, ...io } = transferIo({ call })
    io.bundleSession = vi.fn(async (_worktree: string, bundlePath: string, sinceCommit?: string) => {
      bundled.push(sinceCommit)
      return { path: bundlePath, commit: "d".repeat(40), incremental: sinceCommit !== undefined }
    })

    await sendSessionToMachine({ session, sourceMachineId, target, client: "desktop", ...io })

    expect(bundled).toEqual([held])
  })

  it("sends everything when the target holds nothing for that session", async () => {
    const bundled: (string | undefined)[] = []
    const call = vi.fn<TransferCall>(async (method: string) => {
      if (method === "transfer.have") return {}
      if (method === "transfer.begin") return { transferId: `transfer-${"c".repeat(32)}` }
      return { state: "restored", workspacePath: "/worktrees/session-1", checkpointCommit: "d".repeat(40) }
    })
    const { recorded: _recorded, ...io } = transferIo({ call })
    io.bundleSession = vi.fn(async (_worktree: string, bundlePath: string, sinceCommit?: string) => {
      bundled.push(sinceCommit)
      return { path: bundlePath, commit: "d".repeat(40), incremental: false }
    })

    await sendSessionToMachine({ session, sourceMachineId, target, client: "desktop", ...io })

    expect(bundled).toEqual([undefined])
  })
})

describe("sendSessionToMachine bundle cleanup", () => {
  it("removes the bundle once its bytes have been read", async () => {
    const io = transferIo()
    await sendSessionToMachine({ session, sourceMachineId, target, client: "desktop", ...io })
    expect(io.removeBundle).toHaveBeenCalledWith("/worktrees/session-1.bundle")
  })

  it("removes the bundle when the target refuses it", async () => {
    const io = transferIo()
    io.call = vi.fn(async (method: string) => {
      if (method === "transfer.have") return { commit: undefined }
      if (method === "transfer.begin") throw new Error("refused: no room")
      return {}
    })
    await sendSessionToMachine({ session, sourceMachineId, target, client: "desktop", ...io })
    expect(io.removeBundle).toHaveBeenCalledWith("/worktrees/session-1.bundle")
  })

  it("removes the bundle even when reading it failed", async () => {
    const io = transferIo()
    io.readBundle = vi.fn(async () => { throw new Error("disk gone") })
    await sendSessionToMachine({ session, sourceMachineId, target, client: "desktop", ...io })
    expect(io.removeBundle).toHaveBeenCalledWith("/worktrees/session-1.bundle")
  })

  it("has nothing to remove when the preflight refused before bundling", async () => {
    const io = transferIo()
    await sendSessionToMachine({
      session,
      sourceMachineId,
      target: { ...target, health: "unreachable" },
      client: "desktop",
      ...io,
    })
    expect(io.bundleSession).not.toHaveBeenCalled()
    expect(io.removeBundle).not.toHaveBeenCalled()
  })
})
