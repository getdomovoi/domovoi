import { once } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import { demoWorkspace, protocolVersion, type ImageUpload } from "@getdomovoi/protocol"
import type { AgentAdapter, AgentEvent } from "./agents.js"
import { DomovoiDaemon } from "./server.js"
import { prepareSessionAttachmentText } from "./session-attachments.js"
import { SqliteWorkspaceStore } from "./store.js"

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=", "base64")
const image: ImageUpload = { mimeType: "image/png", width: 1, height: 1, data: png.toString("base64") }
const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
const scratchDirectories: string[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(
  vision: boolean | "unknown" = true,
  client: "phone" | "tablet" = "phone",
  statePath = ":memory:",
  adapterImageInput?: boolean,
) {
  const snapshot = structuredClone(demoWorkspace)
  const session = snapshot.sessions[0]!
  session.state = "idle"
  session.workspacePath = "/worktrees/images"
  session.providerThreadId = "thread-images"
  session.runtime.permissionMode = "build"
  session.runtime.auto = false
  delete session.activeTurnId
  snapshot.annotations = []
  snapshot.approvals = []
  snapshot.workingPlans = []
  snapshot.skillEnablements = []
  let turnOrdinal = 0
  const startTurn = vi.fn<AgentAdapter["startTurn"]>(async () => `turn-images-${++turnOrdinal}`)
  const steerTurn = vi.fn<AgentAdapter["steerTurn"]>(async () => {})
  const listeners = new Set<(event: AgentEvent) => void>()
  const agent: AgentAdapter = {
    ...(vision === "unknown" ? {} : { capabilities: { vision } }),
    connect: vi.fn(async () => {}),
    listModels: async () => [{
      provider: session.runtime.provider, id: session.runtime.model, displayName: session.runtime.model, description: "",
      supportedReasoningEfforts: [], defaultReasoningEffort: "medium", isDefault: true,
      ...(adapterImageInput === undefined ? {} : { imageInput: adapterImageInput }),
    }],
    startThread: async () => "thread-images", resumeThread: vi.fn(async () => {}),
    stopThread: async () => {}, interruptTurn: async () => {},
    startTurn, steerTurn, resolveApproval: () => {}, onEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }, close: async () => {},
  }
  const store = new SqliteWorkspaceStore(statePath, snapshot)
  const daemon = new DomovoiDaemon({ port: 0, store, agents: { [session.runtime.provider]: agent },
    artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
  })
  daemons.push(daemon)
  const address = await daemon.start()
  const open = async () => {
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    sockets.push(socket)
    await once(socket, "open", { signal: AbortSignal.timeout(5_000) })
    let nextId = 0
    return async (method: string, params: Record<string, unknown>) => {
      const id = ++nextId
      const result = new Promise<Record<string, unknown>>((resolve, reject) => {
        const finish = () => { clearTimeout(timer); socket.off("message", receive); socket.off("close", closed) }
        const closed = () => { finish(); reject(new Error("Socket closed before reply")) }
        const receive = (data: WebSocket.RawData) => {
          const reply = JSON.parse(data.toString()) as Record<string, unknown>
          if (reply.id === id) { finish(); resolve(reply) }
        }
        const timer = setTimeout(() => { finish(); reject(new Error(`${method} timed out`)) }, 5_000)
        socket.on("message", receive)
        socket.once("close", closed)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return result
    }
  }
  const owner = await open()
  expect(await owner("system.hello", { client: "cli", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken })).not.toHaveProperty("error")
  const paired = await owner("device.pair", { label: "Image device", client: "cli", targetClient: client })
  const rpc = await open()
  expect(await rpc("system.hello", { client, clientVersion: "0.0.1", protocolVersion, authToken: (paired.result as { token: string }).token })).toMatchObject({ result: { sessionImageAttachments: true } })
  expect(store.load()).not.toHaveProperty("sessionImageAttachments")
  const send = (attachments?: unknown[], extra = {}) => rpc("session.send", {
    sessionId: session.id, prompt: "Read this image", client,
    ...(attachments === undefined ? {} : { attachments }), ...extra,
  })
  return {
    send,
    rpc,
    owner,
    paired,
    open,
    emit: (event: AgentEvent) => { for (const listener of listeners) listener(event) },
    startTurn,
    steerTurn,
    agent,
    daemon,
    store,
    sessionId: session.id,
  }
}

describe("desktop text and workspace attachments", () => {
  it("stores full pasted text in the worktree and puts only forty lines in the provider prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-text-attachment-"))
    scratchDirectories.push(root)
    const content = Array.from({ length: 55 }, (_, index) => `line ${index + 1}`).join("\n")
    const prompt = await prepareSessionAttachmentText([
      { kind: "text", name: "terminal.txt", mimeType: "text/plain", content },
    ], root)
    expect(prompt).toContain("First 40 lines")
    expect(prompt).toContain("line 40")
    expect(prompt).not.toContain("line 41")
    const path = prompt.match(/\.domovoi\/attachments\/[a-z0-9-]+-terminal\.txt/u)?.[0]
    expect(path).toBeTruthy()
    expect(await readFile(join(root, path!), "utf8")).toBe(content)
  })

  it("accepts worktree files and refuses symlink or traversal escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-path-attachment-"))
    scratchDirectories.push(root)
    await mkdir(join(root, "src"))
    await writeFile(join(root, "src", "safe.ts"), "export {}")
    await expect(prepareSessionAttachmentText([{ kind: "workspace-file", path: "src/safe.ts" }], root))
      .resolves.toContain("Attached worktree file: src/safe.ts")
    await expect(prepareSessionAttachmentText([{ kind: "workspace-file", path: "../secret.txt" }], root))
      .rejects.toThrow("worktree")
  })
})

describe("session attachments over a paired socket", () => {
  it.each(["phone", "tablet"] as const)("delivers images on start and steer for %s without persisting or replaying them", async (client) => {
    const f = await fixture(true, client)
    const result = await f.send([image])
    expect(result).not.toHaveProperty("error")
    expect(f.startTurn.mock.calls[0]?.[0].visualContexts).toEqual([{ attachmentIndex: 0, mimeType: "image/png", bytes: png }])
    expect(f.startTurn.mock.calls[0]?.[0].prompt).toContain("Read this image")
    expect(await f.send([image])).not.toHaveProperty("error")
    expect(f.steerTurn.mock.calls[0]?.[3]).toEqual([{ attachmentIndex: 0, mimeType: "image/png", bytes: png }])
    expect(await f.send()).not.toHaveProperty("error")
    expect(f.steerTurn.mock.calls[1]?.[3]).toBeUndefined()
    expect(JSON.stringify(f.store.load())).not.toContain(image.data)
    expect(JSON.stringify(result)).not.toContain(image.data)
    expect(JSON.stringify(f.store.load())).not.toContain("attachmentIndex")
  })

  it.each([false, "unknown"] as const)("refuses the entire image send without vision capability: %s", async (vision) => {
    const f = await fixture(vision)
    const before = f.store.load().thread
    // Phone v2 frame 14b: the message names the model and the count. The data
    // keeps exactly the shape an older client's strict parser accepts; the
    // client knows the session's model and what it sent.
    const refused = await f.send([image, image])
    expect(refused).toMatchObject({ error: { code: -32602, message: "2 images cannot go to sonnet-4.6. Remove them or pick another model." } })
    expect((refused.error as { data: unknown }).data).toEqual({ kind: "session-attachment-refused", reason: "image-input-unsupported" })
    expect(f.startTurn).not.toHaveBeenCalled()
    expect(f.agent.resumeThread).not.toHaveBeenCalled()
    expect(f.store.load().thread).toEqual(before)
    expect(await f.send()).not.toHaveProperty("error")
  })

  it.each([[true, false], [false, true]] as const)("reports image input from the rule the send uses, whatever the adapter listed: vision %s, listed %s", async (vision, listed) => {
    const f = await fixture(vision, "phone", ":memory:", listed)
    const models = await f.rpc("runtime.models", { provider: "claude-code", client: "phone" })
    expect(models.result).toEqual([expect.objectContaining({ id: "sonnet-4.6", imageInput: vision })])
    const sent = await f.send([image])
    expect(sent.error === undefined).toBe(vision)
  })

  it.each([true, false, "unknown"] as const)("reports per model whether images are delivered, from the adapter's capability: %s", async (vision) => {
    const f = await fixture(vision)
    const models = await f.rpc("runtime.models", { provider: "claude-code", client: "phone" })
    expect(models.result).toEqual([expect.objectContaining({ id: "sonnet-4.6", imageInput: vision === true })])
  })

  it("carries two maximum-size uploads on an authenticated socket", async () => {
    const f = await fixture()
    const bytes = Buffer.alloc(1_500_000)
    png.copy(bytes)
    const upload = { ...image, data: bytes.toString("base64") }
    expect(await f.send([upload, upload])).not.toHaveProperty("error")
    expect(f.startTurn.mock.calls[0]?.[0].visualContexts?.map((entry) => entry.bytes.byteLength)).toEqual([1_500_000, 1_500_000])
  })

  it("refuses malformed, oversized and reference uploads without starting a turn", async () => {
    const f = await fixture()
    for (const attachments of [[image, image, image], [{ ...image, data: "AB==" }],
      [{ ...image, width: 2049 }], [{ ...image, url: "https://example.test/image.png" }],
      [{ ...image, data: Buffer.alloc(1_500_001).toString("base64") }]]) {
      expect(await f.send(attachments)).toHaveProperty("error")
    }
    expect(await f.send([image], { references: [{ kind: "file", path: "image.png" }] })).toHaveProperty("error")
    expect(f.startTurn).not.toHaveBeenCalled()
  })

  it("checks image headers and dimensions rather than trusting the declared size", async () => {
    const f = await fixture()
    for (const upload of [{ ...image, width: 2 }, { ...image, mimeType: "image/jpeg" }, { ...image, data: "AAAA" }]) {
      expect(await f.send([upload])).toMatchObject({ error: { data: { reason: "invalid-image" } } })
    }
    expect(f.startTurn).not.toHaveBeenCalled()
  })

  it("keeps omitted delivery as steering and stores no queue", async () => {
    const f = await fixture()
    await f.send()
    const steered = await f.send()
    expect(f.startTurn).toHaveBeenCalledOnce()
    expect(f.steerTurn).toHaveBeenCalledOnce()
    expect(steered).toMatchObject({ result: { queuedSends: [] } })
  })

  it("atomically replaces and ID-checks cancellation across two clients", async () => {
    const f = await fixture()
    await f.send()
    const first = await f.rpc("session.send", {
      sessionId: f.sessionId,
      prompt: "First queued prompt",
      client: "phone",
      delivery: "next-turn-replace",
    })
    const firstQueue = (first.result as { queuedSends: Array<{ id: string }> }).queuedSends[0]!
    const paired = await f.owner("device.pair", { label: "Second phone", client: "cli", targetClient: "phone" })
    const secondRpc = await f.open()
    await secondRpc("system.hello", {
      client: "phone",
      clientVersion: "0.0.1",
      protocolVersion,
      authToken: (paired.result as { token: string }).token,
    })
    const second = await secondRpc("session.send", {
      sessionId: f.sessionId,
      prompt: "Second queued prompt",
      client: "phone",
      delivery: "next-turn-replace",
    })
    const secondQueue = (second.result as { queuedSends: Array<{ id: string }> }).queuedSends[0]!
    expect(secondQueue.id).not.toBe(firstQueue.id)
    expect(await f.rpc("session.cancelQueuedSend", {
      sessionId: f.sessionId,
      queueId: firstQueue.id,
      client: "phone",
    })).toHaveProperty("error")
    expect(await secondRpc("session.cancelQueuedSend", {
      sessionId: f.sessionId,
      queueId: secondQueue.id,
      client: "phone",
    })).toMatchObject({ result: { queuedSends: [] } })
    expect(f.steerTurn).not.toHaveBeenCalled()
  })

  it("releases once after successful ordinary completion and never exposes attachment bytes", async () => {
    const f = await fixture()
    await f.send()
    const queued = await f.rpc("session.send", {
      sessionId: f.sessionId,
      prompt: "Release this once",
      client: "phone",
      attachments: [image],
      delivery: "next-turn-replace",
    })
    expect(JSON.stringify(queued)).not.toContain(image.data)
    expect(f.startTurn).toHaveBeenCalledOnce()
    f.emit({
      type: "turn-completed",
      params: { threadId: "thread-images", turnId: "turn-images-1", status: "completed" },
    })
    await vi.waitFor(() => expect(f.startTurn).toHaveBeenCalledTimes(2), {
      timeout: 10000,
    })
    expect(f.startTurn.mock.calls[1]?.[0]).toMatchObject({
      prompt: expect.stringContaining("Release this once"),
      visualContexts: [{ attachmentIndex: 0, mimeType: "image/png", bytes: png }],
    })
    f.emit({
      type: "turn-completed",
      params: { threadId: "thread-images", turnId: "turn-images-1", status: "completed" },
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(f.startTurn).toHaveBeenCalledTimes(2)
    const workspace = await f.rpc("workspace.get", {})
    expect(workspace).toMatchObject({ result: { queuedSends: [expect.objectContaining({ state: "delivered" })] } })
    expect(JSON.stringify(workspace)).not.toContain(image.data)
    expect(JSON.stringify(f.store.load())).not.toContain(image.data)
  })

  it("refuses a queued attachment when provider capability changes before release", async () => {
    const f = await fixture()
    await f.send()
    await f.rpc("session.send", {
      sessionId: f.sessionId,
      prompt: "Release only with image support",
      client: "phone",
      attachments: [image],
      delivery: "next-turn-replace",
    })
    if (!f.agent.capabilities) throw new Error("Vision capability missing")
    ;(f.agent.capabilities as { vision: boolean }).vision = false
    f.emit({
      type: "turn-completed",
      params: { threadId: "thread-images", turnId: "turn-images-1", status: "completed" },
    })
    await vi.waitFor(async () => {
      const workspace = await f.rpc("workspace.get", {})
      expect(workspace).toMatchObject({ result: { queuedSends: [expect.objectContaining({ state: "refused" })] } })
    }, {
      timeout: 10000,
    })
    expect(f.startTurn).toHaveBeenCalledOnce()
  })

  it("holds rather than drains after failed completion", async () => {
    const f = await fixture()
    await f.send()
    await f.rpc("session.send", {
      sessionId: f.sessionId,
      prompt: "Do not release after failure",
      client: "phone",
      delivery: "next-turn-replace",
    })
    f.emit({
      type: "turn-completed",
      params: { threadId: "thread-images", turnId: "turn-images-1", status: "failed" },
    })
    await vi.waitFor(async () => {
      const workspace = await f.rpc("workspace.get", {})
      expect(workspace).toMatchObject({ result: { queuedSends: [expect.objectContaining({ state: "held" })] } })
    }, {
      timeout: 10000,
    })
    expect(f.startTurn).toHaveBeenCalledOnce()
  })

  it("holds when originating control access is revoked before release", async () => {
    const f = await fixture()
    await f.send()
    await f.rpc("session.send", {
      sessionId: f.sessionId,
      prompt: "Do not release after revocation",
      client: "phone",
      delivery: "next-turn-replace",
    })
    const deviceId = (f.paired.result as { device: { id: string } }).device.id
    await f.owner("device.revoke", { deviceId, client: "cli" })
    f.emit({
      type: "turn-completed",
      params: { threadId: "thread-images", turnId: "turn-images-1", status: "completed" },
    })
await vi.waitFor(async () => {
       const workspace = await f.owner("workspace.get", {})
       expect(workspace).toMatchObject({ result: { queuedSends: [expect.objectContaining({ state: "held" })] } })
     }, {
       timeout: 10000,
     })
    expect(f.startTurn).toHaveBeenCalledOnce()
  })

  it("recovers queued payload after restart without snapshot bytes or automatic drain", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-queued-send-"))
    scratchDirectories.push(scratch)
    const statePath = join(scratch, "state.sqlite")
    const first = await fixture(true, "phone", statePath)
    await first.send()
    await first.rpc("session.send", {
      sessionId: first.sessionId,
      prompt: "Survive daemon restart",
      client: "phone",
      attachments: [image],
      delivery: "next-turn-replace",
    })
    await first.daemon.stop()
    const second = await fixture(true, "phone", statePath)
    const recovered = await second.rpc("workspace.get", {})
    expect(recovered).toMatchObject({ result: { queuedSends: [expect.objectContaining({
      sessionId: first.sessionId,
      state: "held",
    })] } })
    expect(JSON.stringify(recovered)).not.toContain(image.data)
    expect(JSON.stringify(second.store.load())).not.toContain(image.data)
    expect(second.startTurn).not.toHaveBeenCalled()
  })

  it("recovers an interrupted release as unconfirmed without retrying it", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-queued-release-"))
    scratchDirectories.push(scratch)
    const statePath = join(scratch, "state.sqlite")
    const first = await fixture(true, "phone", statePath)
    await first.send()
    const queued = await first.rpc("session.send", {
      sessionId: first.sessionId,
      prompt: "Do not duplicate an uncertain release",
      client: "phone",
      delivery: "next-turn-replace",
    })
    const queueId = (queued.result as { queuedSends: Array<{ id: string }> }).queuedSends[0]!.id
    expect(first.store.transitionQueuedSessionSend(first.sessionId, queueId, ["waiting"], "releasing")).toBe(true)
    await first.daemon.stop()
    const second = await fixture(true, "phone", statePath)
    const recovered = await second.rpc("workspace.get", {})
    expect(recovered).toMatchObject({ result: { queuedSends: [expect.objectContaining({
      id: queueId,
      state: "unconfirmed",
    })] } })
    expect(second.startTurn).not.toHaveBeenCalled()
  })

  it("refuses queue and cancellation controls to watching credentials", async () => {
    const f = await fixture()
    await f.send()
    const paired = await f.owner("device.pair", {
      label: "Watching phone",
      client: "cli",
      targetClient: "phone",
      clientAccess: "watching",
    })
    const watching = await f.open()
    await watching("system.hello", {
      client: "phone",
      clientVersion: "0.0.1",
      protocolVersion,
      authToken: (paired.result as { token: string }).token,
    })
    const queued = await f.rpc("session.send", {
      sessionId: f.sessionId,
      prompt: "Owned by full access",
      client: "phone",
      delivery: "next-turn-replace",
    })
    const queueId = (queued.result as { queuedSends: Array<{ id: string }> }).queuedSends[0]!.id
    expect(await watching("session.send", {
      sessionId: f.sessionId,
      prompt: "Watching cannot replace",
      client: "phone",
      delivery: "next-turn-replace",
    })).toMatchObject({ error: { message: "Watching-only credentials may only observe" } })
    expect(await watching("session.cancelQueuedSend", {
      sessionId: f.sessionId,
      queueId,
      client: "phone",
    })).toMatchObject({ error: { message: "Watching-only credentials may only observe" } })
  })
})
