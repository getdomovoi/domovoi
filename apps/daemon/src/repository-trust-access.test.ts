import { once } from "node:events"

import { createEmptyWorkspace, demoWorkspace, protocolVersion } from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DomovoiDaemon, repositoryTrustProjectRefusal } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"

// Ruling Q68 A (2026-09-27): the trust methods are for the owner's bearer
// credential, which counts as desktop, and for a paired desktop or web
// credential with full access. Everything else is refused on its credential,
// whatever client it declares.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
const rpcDeadlineMs = 3_000
const digest = `sha256:${"a".repeat(64)}`
const trustRefusal = "Repository trust requires the daemon credential or a paired desktop or web credential with full access"
const desktopPairingRefusal = "A web, phone or tablet connection cannot pair a desktop credential"

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

async function fixture() {
  const store = new SqliteWorkspaceStore(":memory:", createEmptyWorkspace(demoWorkspace.machine))
  const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:", store, errorSink: vi.fn() })
  daemons.push(daemon)
  await daemon.start()
  return { daemon, store }
}

async function connect(daemon: DomovoiDaemon, headerToken?: string) {
  const address = daemon.address!
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, headerToken ? { headers: { authorization: `Bearer ${headerToken}` } } : {})
  sockets.push(socket)
  await once(socket, "open", { signal: AbortSignal.timeout(rpcDeadlineMs) })
  let id = 0
  return async (method: string, params: Record<string, unknown>) => {
    const requestId = ++id
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => settle(() => reject(new Error(`${method} deadline expired`))), rpcDeadlineMs)
      const settle = (finish: () => void) => {
        clearTimeout(timer)
        socket.off("message", receive)
        finish()
      }
      const receive = (data: WebSocket.RawData) => {
        const reply = JSON.parse(data.toString()) as Record<string, unknown>
        if (reply.id === requestId) settle(() => resolve(reply))
      }
      socket.on("message", receive)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
    })
  }
}

async function hello(daemon: DomovoiDaemon, client: string, authToken: string) {
  const call = await connect(daemon)
  const reply = await call("system.hello", { client, clientVersion: "0.0.1", protocolVersion, authToken })
  expect(reply, `hello as ${client}`).toHaveProperty("result")
  return call
}

const trust = (client: string) => ["repository.trust", { projectId: "project-acme", configDigest: digest, client }] as const
const revoke = (client: string) => ["repository.revokeTrust", { projectId: "project-acme", client }] as const

// The fixture opens no project, so a call the credential check admits reaches
// the handler and ends in its project refusal rather than a credential refusal.
// server-repository-trust.test.ts covers what the handler records.
const reachesHandler = { error: { code: -32602, message: repositoryTrustProjectRefusal } }

describe("repository trust credentials", () => {
  it.each(["desktop", "web"])("admits the owner's bearer declared as %s", async (client) => {
    const { daemon } = await fixture()
    const call = await hello(daemon, client, daemon.authToken)
    expect(await call(...trust(client))).toMatchObject(reachesHandler)
    expect(await call(...revoke(client))).toMatchObject(reachesHandler)
  })

  it.each(["desktop", "web"] as const)("admits a paired %s credential with full access", async (client) => {
    const { daemon, store } = await fixture()
    const { token } = store.devices.pair({ label: client, binding: { kind: "client", client, clientAccess: "full" } })
    const call = await hello(daemon, client, token)
    expect(await call(...trust(client))).toMatchObject(reachesHandler)
    expect(await call(...revoke(client))).toMatchObject(reachesHandler)
  })

  it("refuses a paired credential whose declared client differs from the request", async () => {
    const { daemon, store } = await fixture()
    const { token } = store.devices.pair({ label: "desktop", binding: { kind: "client", client: "desktop", clientAccess: "full" } })
    const call = await hello(daemon, "desktop", token)
    for (const [method, params] of [trust("web"), revoke("web")]) {
      expect(await call(method, params), method).toMatchObject({ error: { message: "RPC client does not match the authenticated client" } })
    }
  })

  it("refuses a paired command-line credential", async () => {
    const { daemon, store } = await fixture()
    const { token } = store.devices.pair({ label: "cli", binding: { kind: "client", client: "cli", clientAccess: "full" } })
    const call = await hello(daemon, "cli", token)
    for (const [method, params] of [trust("desktop"), revoke("desktop"), trust("cli")]) {
      expect(await call(method, params), method).toMatchObject({ error: { code: -32001, message: trustRefusal } })
    }
  })

  it.each(["phone", "tablet"] as const)("refuses a paired %s credential", async (client) => {
    const { daemon, store } = await fixture()
    const { token } = store.devices.pair({ label: client, binding: { kind: "client", client, clientAccess: "full" } })
    const call = await hello(daemon, client, token)
    for (const [method, params] of [trust("desktop"), revoke("desktop")]) {
      expect(await call(method, params), method).toMatchObject({ error: { code: -32001, message: /A phone or tablet credential may only/ } })
    }
  })

  it.each(["desktop", "web"] as const)("refuses a watching %s credential", async (client) => {
    const { daemon, store } = await fixture()
    const { token } = store.devices.pair({ label: client, binding: { kind: "client", client, clientAccess: "watching" } })
    const call = await hello(daemon, client, token)
    for (const [method, params] of [trust(client), revoke(client)]) {
      expect(await call(method, params), method).toMatchObject({ error: { code: -32001, message: "Watching-only credentials may only observe" } })
    }
  })

  it("refuses a machine credential", async () => {
    const { daemon, store } = await fixture()
    const { token } = store.devices.pair({ label: "studio", binding: { kind: "machine", machineId: `machine-${"b".repeat(32)}` } })
    const call = await hello(daemon, "machine", token)
    for (const [method, params] of [trust("desktop"), revoke("desktop")]) {
      expect(await call(method, params), method).toMatchObject({ error: { code: -32001, message: trustRefusal } })
    }
  })

  it.each(["cli", "phone", "tablet"])("refuses the owner's bearer declared as %s", async (client) => {
    const { daemon } = await fixture()
    const call = await hello(daemon, client, daemon.authToken)
    for (const [method, params] of [trust("desktop"), revoke("desktop")]) {
      expect(await call(method, params), method).toMatchObject({ error: { code: -32001, message: trustRefusal } })
    }
  })

  it("refuses a bearer connection that never declared a client", async () => {
    const { daemon } = await fixture()
    const call = await connect(daemon, daemon.authToken)
    // Authenticated by the header, but no hello, so no declared client.
    expect(await call("workspace.get", {})).toMatchObject({ error: { code: -32001, message: "Connection identity is required" } })
    for (const [method, params] of [trust("desktop"), revoke("desktop")]) {
      expect(await call(method, params), method).toMatchObject({ error: { code: -32001, message: trustRefusal } })
    }
  })
})

describe("desktop credential pairing", () => {
  it.each(["web", "phone", "tablet"])("refuses a desktop credential to a bearer declared as %s", async (client) => {
    const { daemon, store } = await fixture()
    const call = await hello(daemon, client, daemon.authToken)
    const reply = await call("device.pair", { label: "Minted", client, targetClient: "desktop" })
    expect(reply).toMatchObject({ error: { code: -32001, message: desktopPairingRefusal } })
    expect(store.devices.list()).toEqual([])
  })

  it.each(["desktop", "cli"])("pairs a desktop credential from a bearer declared as %s", async (client) => {
    const { daemon } = await fixture()
    const call = await hello(daemon, client, daemon.authToken)
    expect(await call("device.pair", { label: "Studio", client, targetClient: "desktop" })).toMatchObject({
      result: { device: { binding: { kind: "client", client: "desktop" } } },
    })
  })

  it.each(["web", "phone", "tablet"])("refuses a desktop pairing code to a bearer declared as %s", async (client) => {
    const { daemon } = await fixture()
    const call = await hello(daemon, client, daemon.authToken)
    expect(await call("device.issueCode", { targetClient: "desktop" })).toMatchObject({ error: { code: -32001, message: desktopPairingRefusal } })
  })

  it.each(["desktop", "cli"])("issues a desktop pairing code to a bearer declared as %s", async (client) => {
    const { daemon } = await fixture()
    const call = await hello(daemon, client, daemon.authToken)
    expect(await call("device.issueCode", { targetClient: "desktop" })).toHaveProperty("result.code")
  })

  it.each(["phone", "tablet", "web"])("still issues a %s pairing code to a bearer declared as web", async (targetClient) => {
    const { daemon } = await fixture()
    const call = await hello(daemon, "web", daemon.authToken)
    expect(await call("device.issueCode", { targetClient })).toHaveProperty("result.code")
  })

  it("still pairs a web credential from a bearer declared as web", async () => {
    const { daemon } = await fixture()
    const call = await hello(daemon, "web", daemon.authToken)
    expect(await call("device.pair", { label: "Browser", client: "web" })).toMatchObject({
      result: { device: { binding: { kind: "client", client: "web" } } },
    })
  })
})
