import { once } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import { demoWorkspace, protocolVersion, type ImageUpload } from "@getdomovoi/protocol"
import type { AgentAdapter } from "./agents.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=", "base64")
const image: ImageUpload = { mimeType: "image/png", width: 1, height: 1, data: png.toString("base64") }
const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

async function fixture(vision: boolean | "unknown" = true, client: "phone" | "tablet" = "phone") {
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
  const startTurn = vi.fn<AgentAdapter["startTurn"]>(async () => "turn-images")
  const steerTurn = vi.fn<AgentAdapter["steerTurn"]>(async () => {})
  const agent: AgentAdapter = {
    ...(vision === "unknown" ? {} : { capabilities: { vision } }),
    connect: vi.fn(async () => {}), listModels: async () => [],
    startThread: async () => "thread-images", resumeThread: vi.fn(async () => {}),
    stopThread: async () => {}, interruptTurn: async () => {},
    startTurn, steerTurn, resolveApproval: () => {}, onEvent: () => () => {}, close: async () => {},
  }
  const store = new SqliteWorkspaceStore(":memory:", snapshot)
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
  return { send, startTurn, steerTurn, agent, store, sessionId: session.id }
}

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
    expect(await f.send([image])).toMatchObject({ error: { code: -32602, data: {
      kind: "session-attachment-refused", reason: "image-input-unsupported",
    } } })
    expect(f.startTurn).not.toHaveBeenCalled()
    expect(f.agent.resumeThread).not.toHaveBeenCalled()
    expect(f.store.load().thread).toEqual(before)
    expect(await f.send()).not.toHaveProperty("error")
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
})
