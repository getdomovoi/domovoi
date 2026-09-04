import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { protocolVersion } from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createProductionDaemon,
  createProductionDaemonWithDependencies,
  productionDaemonDependencies,
  type ProductionDaemonHandle,
  type ProductionDaemonRuntime,
} from "./production-daemon.js"
import { MachineCredentialStore, type MachineKeyring } from "./machine-credentials.js"
import { DomovoiDaemon, type DaemonServerOptions } from "./server.js"

const roots: string[] = []
const running: ProductionDaemonHandle[] = []

afterEach(async () => {
  await Promise.allSettled(running.splice(0).map((daemon) => daemon.stop()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

function testToken(label: string): string {
  return createHash("sha256").update(label).digest("base64url")
}

function fakeRuntime(
  options: DaemonServerOptions,
  address = { host: "127.0.0.1", port: 49_200 },
): ProductionDaemonRuntime {
  return {
    host: options.host ?? "127.0.0.1",
    requestedPort: options.port ?? 47_831,
    authToken: options.authToken!,
    start: async () => address,
    stop: async () => {},
  }
}

async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "domovoi-production-factory-"))
  roots.push(root)
  return root
}

async function openRpc(handle: ProductionDaemonHandle) {
  const endpoint = await handle.start()
  const socket = new WebSocket(endpoint.url, {
    headers: { authorization: `Bearer ${handle.authToken}` },
  })
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve)
    socket.once("error", reject)
  })

  const call = (id: number, method: string, params: Record<string, unknown>) => {
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const settle = (finish: () => void) => {
        socket.off("message", receive)
        socket.off("close", closed)
        socket.off("error", fail)
        finish()
      }
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id !== id) return
        settle(() => resolve(message as Record<string, unknown>))
      }
      const closed = () => settle(() => reject(
        new Error(`Daemon closed before answering ${method}`),
      ))
      const fail = (error: Error) => settle(() => reject(error))
      socket.on("message", receive)
      socket.once("close", closed)
      socket.once("error", fail)
    })
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    return response
  }

  return { socket, call }
}

describe("createProductionDaemon", () => {
  it("assembles every mandatory production dependency", async () => {
    const homeDirectory = join("", "home", "tester")
    const authToken = testToken("production-factory")
    const machineIdentity = { id: `machine-${"a".repeat(32)}`, label: "studio" }
    const providerProbe = { inspect: async () => [] }
    const machineCredentials = new MachineCredentialStore({
      get: () => undefined,
      set: () => {},
      delete: () => {},
    })
    let daemonOptions: DaemonServerOptions | undefined
    const handle = await createProductionDaemonWithDependencies({
      environment: {},
      homeDirectory,
      machineLabel: "studio",
    }, {
      ...productionDaemonDependencies,
      parseEnvironment: () => ({
        host: "127.0.0.1",
        port: 47_831,
        credentialPath: join(homeDirectory, ".domovoi", "daemon.token"),
        machineIdentityPath: join(homeDirectory, ".domovoi", "machine.json"),
        allowRemoteTransport: false,
      }),
      loadOrCreateToken: async () => authToken,
      loadOrCreateIdentity: async () => machineIdentity,
      createProviderProbe: () => providerProbe,
      createMachineCredentials: () => machineCredentials,
      createDaemon: (options) => {
        daemonOptions = options
        return fakeRuntime(options)
      },
    })

    expect(daemonOptions).toMatchObject({
      host: "127.0.0.1",
      port: 47_831,
      authToken,
      machineIdentity,
      providerProbe,
      machineCredentials,
      statePath: join(homeDirectory, ".domovoi", "state.sqlite"),
      worktreeRoot: join(homeDirectory, ".domovoi", "worktrees"),
      manageStateDirectoryPermissions: true,
    })
    expect(handle).toMatchObject({
      host: "127.0.0.1",
      requestedPort: 47_831,
      authToken,
      secureTransport: false,
      credential: {
        source: "file",
        path: join(homeDirectory, ".domovoi", "daemon.token"),
      },
    })
    await expect(handle.start()).resolves.toEqual({
      host: "127.0.0.1",
      port: 49_200,
      url: "ws://127.0.0.1:49200/rpc",
    })
  })

  it("refuses a plaintext non-loopback listener before constructing it", async () => {
    const createDaemon = vi.fn((options: DaemonServerOptions) => fakeRuntime(options))

    await expect(createProductionDaemonWithDependencies({
      environment: {
        DOMOVOI_HOST: "0.0.0.0",
        DOMOVOI_ALLOW_REMOTE_TRANSPORT: "1",
      },
      homeDirectory: join("", "home", "tester"),
      machineLabel: "studio",
    }, {
      ...productionDaemonDependencies,
      createDaemon,
    })).rejects.toThrow("Non-loopback DOMOVOI_HOST requires TLS for 0.0.0.0")

    expect(createDaemon).not.toHaveBeenCalled()
  })

  it("reuses its root credential and machine identity", async () => {
    const homeDirectory = await temporaryHome()
    const first = await createProductionDaemon({
      environment: {},
      homeDirectory,
      machineLabel: "studio",
    })
    running.push(first)
    const firstIdentity = await readFile(join(homeDirectory, ".domovoi", "machine.json"), "utf8")
    await first.stop()

    const second = await createProductionDaemon({
      environment: {},
      homeDirectory,
      machineLabel: "renamed-host",
    })
    running.push(second)

    expect(second.authToken).toBe(first.authToken)
    await expect(readFile(join(homeDirectory, ".domovoi", "machine.json"), "utf8"))
      .resolves.toBe(firstIdentity)
  })

  it("keeps a peer credential and identity through a real daemon restart", async () => {
    const homeDirectory = await temporaryHome()
    const values = new Map<string, string>()
    const keyring: MachineKeyring = {
      get: (account) => values.get(account),
      set: (account, secret) => values.set(account, secret),
      delete: (account) => values.delete(account),
    }
    const credentialStores: MachineCredentialStore[] = []
    const dependencies = {
      ...productionDaemonDependencies,
      createProviderProbe: () => ({ inspect: async () => [] }),
      createMachineCredentials: () => {
        const store = new MachineCredentialStore(keyring)
        credentialStores.push(store)
        return store
      },
      createDaemon: (options: DaemonServerOptions) => new DomovoiDaemon({
        ...options,
        port: 0,
      }),
    }
    const options = { environment: {}, homeDirectory, machineLabel: "studio" }
    const peerMachineId = `machine-${"b".repeat(32)}`
    const peerCredential = testToken("peer-machine")

    const first = await createProductionDaemonWithDependencies(options, dependencies)
    running.push(first)
    const firstRpc = await openRpc(first)
    const firstHello = await firstRpc.call(1, "system.hello", {
      client: "cli",
      clientVersion: "0.0.1",
      protocolVersion,
    })
    await expect(firstRpc.call(2, "device.saveCredential", {
      machineId: peerMachineId,
      credential: peerCredential,
    })).resolves.toMatchObject({ result: { saved: true } })
    firstRpc.socket.close()
    await first.stop()

    const second = await createProductionDaemonWithDependencies(options, dependencies)
    running.push(second)
    const secondRpc = await openRpc(second)
    const secondHello = await secondRpc.call(1, "system.hello", {
      client: "cli",
      clientVersion: "0.0.1",
      protocolVersion,
    })

    expect(secondHello).toMatchObject({
      result: { machine: { id: (firstHello.result as { machine: { id: string } }).machine.id } },
    })
    expect(credentialStores).toHaveLength(2)
    expect(credentialStores[1]!.forMachine(peerMachineId)).toBe(peerCredential)
    secondRpc.socket.close()
  })
})
