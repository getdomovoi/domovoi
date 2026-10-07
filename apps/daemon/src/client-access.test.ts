import { execFile } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { demoWorkspace, protocolVersion, rpcMethodAuthorizations, rpcMethods, type RpcMethod } from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AgentAdapter } from "./agents.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { removeScratchDirectory } from "./test-scratch.js"

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
const rpcDeadlineMs = 3_000

async function connect(daemon: DomovoiDaemon) {
  const address = daemon.address!
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
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

function errorMessage(reply: Record<string, unknown>) {
  return (reply.error as { message?: string } | undefined)?.message ?? ""
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

describe("watching client access", () => {
  it("refuses every control method before parsing parameters and permits every observe method", async () => {
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    daemons.push(daemon)
    await daemon.start()

    const owner = await connect(daemon)
    expect(await owner("system.hello", {
      client: "cli", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
    })).not.toHaveProperty("error")
    const minted = await owner("device.pair", {
      label: "Watching browser", client: "cli", targetClient: "web", clientAccess: "watching",
    })
    expect(minted).not.toHaveProperty("error")
    const { token, device } = minted.result as {
      token: string
      device: { id: string; binding: unknown }
    }
    expect(device.binding).toEqual({ kind: "client", client: "web", clientAccess: "watching" })

    const watching = await connect(daemon)
    const hello = await watching("system.hello", {
      client: "web", clientVersion: "0.0.1", protocolVersion, authToken: token,
    })
    expect(hello).toMatchObject({ result: { clientAccess: "watching" } })
    expect(await watching("device.current", {})).toMatchObject({
      result: { kind: "client", deviceId: device.id, client: "web", clientAccess: "watching" },
    })

    const refusal = /Watching-only credentials may only observe/
    const methods = Object.keys(rpcMethods) as RpcMethod[]
    for (const method of methods.filter((candidate) => rpcMethodAuthorizations[candidate] === "control")) {
      const reply = await watching(method, {})
      expect(errorMessage(reply), method).toMatch(refusal)
    }
    for (const method of methods.filter((candidate) => rpcMethodAuthorizations[candidate] === "observe")) {
      if (method === "system.hello" || method === "device.current") continue
      const reply = await watching(method, {})
      expect(errorMessage(reply), method).not.toMatch(refusal)
    }
  })

  it.each(["terminal.create", "terminal.claim", "terminal.input", "terminal.resize", "terminal.close"] as const)(
    "refuses %s despite its persistence-read-only classification",
    async (method) => {
      const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
      daemons.push(daemon)
      await daemon.start()
      const owner = await connect(daemon)
      await owner("system.hello", {
        client: "cli", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
      })
      const minted = await owner("device.pair", {
        label: "Watcher", client: "cli", targetClient: "desktop", clientAccess: "watching",
      })
      const token = (minted.result as { token: string }).token
      const watching = await connect(daemon)
      await watching("system.hello", {
        client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: token,
      })
      expect(errorMessage(await watching(method, {}))).toMatch(/Watching-only credentials may only observe/)
    },
  )

  it("answers model and usage reads from a watching credential without starting a provider", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.runtime = { ...session.runtime, provider: "codex", model: "gpt-5.6-sol" }
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => []),
      usageLimits: vi.fn(async () => undefined),
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
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", snapshot),
      agents: { codex: agent },
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    daemons.push(daemon)
    await daemon.start()
    const owner = await connect(daemon)
    await owner("system.hello", {
      client: "cli", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
    })
    const minted = await owner("device.pair", {
      label: "Watching phone", client: "cli", targetClient: "phone", clientAccess: "watching",
    })
    const token = (minted.result as { token: string }).token
    const watching = await connect(daemon)
    await watching("system.hello", {
      client: "phone", clientVersion: "0.0.1", protocolVersion, authToken: token,
    })

    const models = await watching("runtime.models", { provider: "codex", client: "phone" })
    expect(models, JSON.stringify(models)).not.toHaveProperty("error")
    expect(await watching("session.usage", { sessionId: session.id })).not.toHaveProperty("error")
    expect(agent.connect).not.toHaveBeenCalled()
    expect(agent.listModels).not.toHaveBeenCalled()
    expect(agent.usageLimits).not.toHaveBeenCalled()
  })

  it("keeps omitted access and local-owner credentials fully authorized", async () => {
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    daemons.push(daemon)
    await daemon.start()
    const owner = await connect(daemon)
    expect(await owner("system.hello", {
      client: "cli", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
    })).toMatchObject({ result: { clientAccess: "full" } })
    const minted = await owner("device.pair", { label: "Desktop", client: "cli", targetClient: "desktop" })
    expect(minted).toMatchObject({
      result: { device: { binding: { kind: "client", client: "desktop", clientAccess: "full" } } },
    })
    const token = (minted.result as { token: string }).token
    const full = await connect(daemon)
    expect(await full("system.hello", {
      client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: token,
    })).toMatchObject({ result: { clientAccess: "full" } })
    expect(errorMessage(await full("terminal.input", {}))).not.toMatch(/Watching-only credentials may only observe/)
  })
})

describe("daemon test profile isolation", () => {
  // Leave Windows time to start the nested runner, then allow cleanup to finish.
  const childTimeoutMs = process.platform === "win32" ? 90_000 : 30_000

  // Exercise the actual store-only test in a fresh worker. Its inherited HOME is
  // disposable even when the suite setup is absent, so the red phase is safe.
  it("isolates store-only startup from the inherited home and profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-profile-isolation-"))
    const home = join(root, "home")
    const profile = join(root, "profile")
    const runnerHome = join(root, "runner")
    try {
      await Promise.all([home, profile, runnerHome].map((path) => mkdir(path)))
      const { stdout } = await promisify(execFile)(process.execPath, [
        "--input-type=module", "--eval", `
          import { startVitest } from "vitest/node"
          await startVitest(["src/client-access.test.ts"], {
            run: true,
            reporters: ["dot"],
            testNamePattern: "answers model and usage reads from a watching credential without starting a provider",
            env: { HOME: process.argv[1], USERPROFILE: process.argv[1], DOMOVOI_PROFILE_DIR: process.argv[2] },
          })
        `, home, profile,
      ], {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        // Vitest creates its own API token before worker setup. Keep the runner's
        // data separate so the worker's inherited home can be asserted empty.
        env: {
          ...process.env, HOME: runnerHome, USERPROFILE: runnerHome, DOMOVOI_PROFILE_DIR: profile,
          XDG_DATA_HOME: join(runnerHome, "data"), LOCALAPPDATA: join(runnerHome, "data"),
          NO_COLOR: "1", FORCE_COLOR: undefined,
        },
        timeout: childTimeoutMs,
      })
      // A renamed target must fail this regression instead of silently skipping.
      expect(stdout).toMatch(/Tests\s+1 passed/u)
      expect(await readdir(home, { recursive: true }), "The inherited HOME must stay empty").toEqual([])
      expect(await readdir(profile), "The inherited profile must stay empty").toEqual([])
    } finally {
      await removeScratchDirectory(root)
    }
  }, childTimeoutMs + 10_000)
})
