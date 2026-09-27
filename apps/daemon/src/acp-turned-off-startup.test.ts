import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import WebSocket from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import { demoWorkspace, protocolVersion, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import type { ProviderProbe } from "./providers.js"
import { DomovoiDaemon } from "./server.js"
import type { WorkspaceStore } from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { waitForDaemon } from "./test-wait-for.js"

const running: DomovoiDaemon[] = []
const scratchDirectories: string[] = []
// A probe held open for the test is failed before stop, which waits for it.
const heldProbes: Array<() => void> = []

afterEach(async () => {
  for (const fail of heldProbes.splice(0)) fail()
  await Promise.all(running.splice(0).map((daemon) => daemon.stop()))
  vi.unstubAllEnvs()
  await removeScratchDirectories(scratchDirectories.splice(0))
})

const offReason = (name: string) =>
  `${name} is turned off in Domovoi for now. ${name} loads MCP servers, hooks and permission rules from the repository it works in, `
  + "and Domovoi does not load repository-brought configuration until a trust gate ships."

const turnedOffRows = [
  { id: "cursor-agent", command: "agent", status: "unknown", sessionCapable: false, problem: offReason("Cursor") },
  { id: "grok", command: "grok", status: "unknown", sessionCapable: false, problem: offReason("Grok") },
]

// A snapshot saved while Cursor and Grok could start sessions. Its active
// turn makes startup recovery write the snapshot back before the listener
// opens, so the test also sees what the daemon stores.
function storedSnapshot(): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.machine.providers = [
    { id: "claude-code", command: "claude", status: "ready", version: "2.1.247", sessionCapable: true },
    { id: "cursor-agent", command: "agent", status: "ready", version: "2026.08.1", sessionCapable: true },
    { id: "grok", command: "grok", status: "ready", version: "0.18.0", sessionCapable: true },
  ]
  const session = snapshot.sessions[0]!
  session.state = "active"
  session.activeTurnId = "turn-stored"
  return snapshot
}

type Frame = { id?: unknown; method?: string; result?: WorkspaceSnapshot; params?: WorkspaceSnapshot }

// Sends hello, then one request, and returns its response together with every
// workspace.changed notification the client saw before it.
async function request(daemon: DomovoiDaemon, address: { host: string; port: number }, method: string, params: object) {
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
    headers: { authorization: `Bearer ${daemon.authToken}` },
  })
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const changed: WorkspaceSnapshot[] = []
    const response = new Promise<Frame>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Frame
        if (message.method === "workspace.changed" && message.params) changed.push(message.params)
        if (message.id === 2) resolve(message)
      })
    })
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "system.hello",
      params: { client: "desktop", clientId: "desktop-test-client", clientVersion: "0.0.1", protocolVersion },
    }))
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }))
    return { response: await response, changed }
  } finally {
    socket.close()
  }
}

async function firstWorkspace(daemon: DomovoiDaemon, address: { host: string; port: number }) {
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
    headers: { authorization: `Bearer ${daemon.authToken}` },
  })
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const response = new Promise<{ result?: WorkspaceSnapshot }>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: unknown; result?: WorkspaceSnapshot }
        if (message.id === 2) resolve(message)
      })
    })
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "system.hello",
      params: { client: "desktop", clientId: "desktop-test-client", clientVersion: "0.0.1", protocolVersion },
    }))
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "workspace.get", params: {} }))
    return await response
  } finally {
    socket.close()
  }
}

describe("stored Cursor and Grok readiness at startup", () => {
  it.each([
    ["fails", () => Promise.reject(new Error("probe failed"))],
    ["has not answered", () => new Promise<never>((_, reject) => {
      heldProbes.push(() => reject(new Error("probe released after the test")))
    })],
  ] as const)("is replaced with the turned-off rows when the probe %s", async (_, inspect) => {
    const home = await mkdtemp(join(tmpdir(), "domovoi-acp-off-"))
    scratchDirectories.push(home)
    vi.stubEnv("HOME", home)
    const store = {
      load: vi.fn(storedSnapshot),
      save: vi.fn(),
      close: vi.fn(),
    } satisfies WorkspaceStore
    const providerProbe = { inspect: vi.fn<ProviderProbe["inspect"]>(inspect) }
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      providerProbe,
      profileDirectory: join(home, ".domovoi"),
      errorSink: () => {},
    })
    running.push(daemon)

    const address = await daemon.start()
    const response = await firstWorkspace(daemon, address)

    await waitForDaemon(() => expect(providerProbe.inspect).toHaveBeenCalledOnce())
    expect(response.result?.machine.providers).toEqual([
      { id: "claude-code", command: "claude", status: "ready", version: "2.1.247", sessionCapable: true },
      ...turnedOffRows,
    ])
    expect(store.save).toHaveBeenCalled()
    for (const [saved] of store.save.mock.calls) {
      expect((saved as WorkspaceSnapshot).machine.providers).toEqual(expect.arrayContaining(turnedOffRows))
      expect((saved as WorkspaceSnapshot).machine.providers.filter(({ sessionCapable }) => sessionCapable))
        .toEqual([expect.objectContaining({ id: "claude-code" })])
    }
  })
})

describe("Cursor and Grok readiness from a provider probe", () => {
  it("is replaced with the turned-off rows before the refresh is saved, broadcast or returned", async () => {
    const home = await mkdtemp(join(tmpdir(), "domovoi-acp-off-"))
    scratchDirectories.push(home)
    vi.stubEnv("HOME", home)
    const snapshot = structuredClone(demoWorkspace)
    snapshot.machine.providers = []
    const store = {
      load: vi.fn(() => snapshot),
      save: vi.fn(),
      close: vi.fn(),
    } satisfies WorkspaceStore
    // A probe other than CliProviderProbe, which does not know they are off.
    const providerProbe = {
      inspect: vi.fn<ProviderProbe["inspect"]>(async () => [
        { id: "claude-code", command: "claude", status: "ready", version: "2.1.247" },
        { id: "cursor-agent", command: "agent", status: "ready", version: "2026.08.1" },
        { id: "grok", command: "grok", status: "ready", version: "0.18.0" },
      ]),
    }
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      providerProbe,
      profileDirectory: join(home, ".domovoi"),
      errorSink: () => {},
    })
    running.push(daemon)
    const address = await daemon.start()
    await waitForDaemon(() => expect(store.save).toHaveBeenCalled())

    const { response, changed } = await request(daemon, address, "provider.refresh", { client: "desktop" })

    expect(providerProbe.inspect).toHaveBeenCalledTimes(2)
    const expected = [
      { id: "claude-code", command: "claude", status: "ready", version: "2.1.247", sessionCapable: true },
      ...turnedOffRows,
    ]
    expect(response.result?.machine.providers).toEqual(expected)
    expect(changed).not.toEqual([])
    for (const broadcast of changed) expect(broadcast.machine.providers).toEqual(expected)
    expect(store.save.mock.calls.length).toBeGreaterThanOrEqual(2)
    for (const [saved] of store.save.mock.calls) expect((saved as WorkspaceSnapshot).machine.providers).toEqual(expected)
  })
})
