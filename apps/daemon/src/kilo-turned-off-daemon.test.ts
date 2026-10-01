import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import WebSocket from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import { demoWorkspace, protocolVersion, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import type { ProviderProbe } from "./providers.js"
import { DomovoiDaemon } from "./server.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { waitForDaemon } from "./test-wait-for.js"
import type { WorkspaceService } from "./workspace.js"

// The only way the Kilo adapter starts a Kilo server. Replaced so that no test
// here can start one, and so a test sees whether anything asked for one.
const startKilo = vi.hoisted(() => vi.fn(async () => {
  throw new Error("A test asked for a Kilo server")
}))
vi.mock("./kilo-runtime.js", () => ({ createDefaultKiloRuntime: startKilo }))

const kiloMechanism = "Kilo's server can switch on a rule that allows every tool, and it sends Domovoi no event "
  + "when that happens, so Domovoi cannot show an approval card before a tool runs."
const kiloOffReason = `Kilo is turned off in Domovoi for now. ${kiloMechanism}`
const kiloResumeRefusal = `This session uses Kilo, which is turned off in Domovoi for now. ${kiloMechanism} `
  + "The worktree and conversation are kept. Switch this session to another provider to continue."

const running: DomovoiDaemon[] = []
const scratchDirectories: string[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.stop()))
  vi.unstubAllEnvs()
  await removeScratchDirectories(scratchDirectories.splice(0))
  startKilo.mockClear()
})

function workspaceService(): WorkspaceService {
  return {
    inspect: vi.fn(async (path: string) => ({ root: path, name: "project", branch: "main", head: "a".repeat(40) })),
    createSessionWorkspace: vi.fn(),
    removeSessionWorkspace: vi.fn(),
    restore: vi.fn(),
    checkpoint: vi.fn(),
    snapshot: vi.fn(async () => ({ commit: "c".repeat(40), changedFiles: [] })),
  }
}

// A daemon with the default provider wiring: no agents are injected.
async function defaultDaemon(snapshot: WorkspaceSnapshot, providerProbe?: ProviderProbe) {
  const home = await mkdtemp(join(tmpdir(), "domovoi-kilo-off-"))
  scratchDirectories.push(home)
  vi.stubEnv("HOME", home)
  const daemon = new DomovoiDaemon({
    port: 0,
    store: { load: () => snapshot, save: vi.fn(), close: vi.fn() },
    profileDirectory: join(home, ".domovoi"),
    workspaceService: workspaceService(),
    ...(providerProbe ? { providerProbe } : {}),
    errorSink: () => {},
  })
  running.push(daemon)
  return daemon
}

type Frame = { id?: unknown; result?: WorkspaceSnapshot; error?: { code: number; message: string } }

// Sends hello, waits for its answer, then sends one request and returns its
// response.
async function request(
  daemon: DomovoiDaemon,
  address: { host: string; port: number },
  method: string,
  params: object,
): Promise<Frame> {
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
    headers: { authorization: `Bearer ${daemon.authToken}` },
  })
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let answerHello: (message: Frame) => void = () => {}
    const hello = new Promise<Frame>((resolve) => { answerHello = resolve })
    const response = new Promise<Frame>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Frame
        if (message.id === 1) answerHello(message)
        if (message.id === 2) resolve(message)
      })
    })
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "system.hello",
      params: { client: "desktop", clientId: "desktop-test-client", clientVersion: "0.0.1", protocolVersion },
    }))
    expect((await hello).result).toBeDefined()
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }))
    return await response
  } finally {
    socket.close()
  }
}

function idleSession(provider: string) {
  const snapshot = structuredClone(demoWorkspace)
  const session = snapshot.sessions[0]!
  session.runtime = { provider, model: "stored-model", reasoning: "none", permissionMode: "build", auto: false }
  session.state = "idle"
  session.workspacePath = "/worktrees/stored"
  session.providerThreadId = "thread-stored"
  delete session.activeTurnId
  return { snapshot, session }
}

const kiloRuntime = { provider: "kilo", model: "anthropic/claude-sonnet", reasoning: "none", permissionMode: "plan", auto: false }

describe("Kilo turned off in the default provider wiring", () => {
  it("refuses to create a Kilo session and says why", async () => {
    const daemon = await defaultDaemon(structuredClone(demoWorkspace))
    const address = await daemon.start()

    const response = await request(daemon, address, "session.create", { title: "Try Kilo", runtime: kiloRuntime, client: "desktop" })

    expect(response.error).toEqual({ code: -32602, message: kiloOffReason })
    expect(startKilo).not.toHaveBeenCalled()
  })

  it("refuses to move a session onto Kilo and says why", async () => {
    const { snapshot, session } = idleSession("codex")
    const daemon = await defaultDaemon(snapshot)
    const address = await daemon.start()

    const response = await request(daemon, address, "session.setRuntime", { sessionId: session.id, client: "desktop", runtime: kiloRuntime })

    expect(response.error).toEqual({ code: -32602, message: kiloOffReason })
    expect(startKilo).not.toHaveBeenCalled()
  })

  it("refuses to continue a stored Kilo session and keeps its worktree and conversation", async () => {
    const { snapshot, session } = idleSession("kilo")
    const daemon = await defaultDaemon(snapshot)
    const address = await daemon.start()

    const response = await request(daemon, address, "session.send", { sessionId: session.id, prompt: "Continue", client: "desktop" })

    expect(response.error).toEqual({ code: -32602, message: kiloResumeRefusal })
    expect(startKilo).not.toHaveBeenCalled()
  })

  it("serves the turned-off Kilo row whatever an injected probe reports", async () => {
    const snapshot = structuredClone(demoWorkspace)
    snapshot.machine.providers = []
    // A probe other than CliProviderProbe, which does not know Kilo is off.
    const providerProbe = {
      inspect: vi.fn<ProviderProbe["inspect"]>(async () => [
        { id: "kilo", command: "kilo", status: "ready", version: "7.8.1" },
      ]),
    }
    const daemon = await defaultDaemon(snapshot, providerProbe)
    const address = await daemon.start()
    await waitForDaemon(() => expect(providerProbe.inspect).toHaveBeenCalledOnce())

    const response = await request(daemon, address, "provider.refresh", { client: "desktop" })

    expect(response.result?.machine.providers).toEqual([
      { id: "kilo", command: "kilo", status: "unknown", sessionCapable: false, problem: kiloOffReason },
    ])
    expect(startKilo).not.toHaveBeenCalled()
  })
})
