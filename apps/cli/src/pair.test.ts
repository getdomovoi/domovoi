import { describe, expect, it } from "vitest"

import type { CredentialStore, PairedDaemon } from "./credentials.js"
import { pairWithDaemon, PairingError, readCredential } from "./pair.js"

const token = "t".repeat(43)
const machineId = `machine-${"d".repeat(32)}`
const deviceId = `device-${"1".repeat(32)}`

function memoryStore(failSave = false): CredentialStore & { saved: PairedDaemon[] } {
  const saved: PairedDaemon[] = []
  return {
    where: "keyring",
    saved,
    load: async (endpoint) => saved.find((record) => record.endpoint === endpoint),
    save: async (record) => { if (failSave) throw new Error("disk full"); saved.push(record) },
    forget: async () => {},
  }
}

function fakeDaemon(options: { helloRejects?: string; current?: unknown } = {}) {
  const calls: string[] = []
  let closed = 0
  const connect = async (authToken: string) => {
    calls.push(`hello ${authToken === token ? "ok" : "bad"}`)
    if (options.helloRejects) throw new Error(options.helloRejects)
    return {
      call: async (method: string) => {
        calls.push(method)
        if (method === "device.current") return options.current ?? { kind: "client", machineId, deviceId, client: "cli" }
        throw new Error(`unexpected ${method}`)
      },
      close: () => { closed += 1 },
    }
  }
  return { calls, connect, closed: () => closed }
}

describe("readCredential", () => {
  it("accepts the bare credential or the whole printed line", () => {
    expect(readCredential(`${token}\n`)).toBe(token)
    expect(readCredential(`Client credential: ${token}`)).toBe(token)
  })

  it("refuses anything that is not a credential", () => {
    expect(() => readCredential("hearth-quiet-ember-42")).toThrow(PairingError)
    expect(() => readCredential("")).toThrow(PairingError)
  })
})

describe("pair", () => {
  it("proves the credential with an authenticated hello, then stores it with the device it names", async () => {
    const store = memoryStore()
    const daemon = fakeDaemon()
    const result = await pairWithDaemon({ endpoint: "ws://127.0.0.1:47831/rpc", credential: token, store, connect: daemon.connect })
    expect(daemon.calls).toEqual(["hello ok", "device.current"])
    expect(store.saved).toEqual([{ endpoint: "ws://127.0.0.1:47831/rpc", deviceId, machineId, token }])
    expect(result).toEqual({ deviceId, machineId })
    expect(daemon.closed()).toBe(1)
  })

  it("stores nothing when the daemon refuses the credential, and never quotes it", async () => {
    const store = memoryStore()
    const daemon = fakeDaemon({ helloRejects: `refused ${token}` })
    await expect(pairWithDaemon({ endpoint: "ws://127.0.0.1:47831/rpc", credential: token, store, connect: daemon.connect }))
      .rejects.toThrow(/^The daemon refused this credential$/)
    expect(store.saved).toEqual([])
  })

  it("refuses a daemon credential even though it authenticates", async () => {
    const store = memoryStore()
    const daemon = fakeDaemon({ current: { kind: "daemon", machineId } })
    await expect(pairWithDaemon({ endpoint: "ws://127.0.0.1:47831/rpc", credential: token, store, connect: daemon.connect }))
      .rejects.toThrow(/belongs to a daemon/)
    expect(store.saved).toEqual([])
    expect(daemon.closed()).toBe(1)
  })

  it("says when the credential worked but could not be kept", async () => {
    const daemon = fakeDaemon()
    await expect(pairWithDaemon({ endpoint: "ws://127.0.0.1:47831/rpc", credential: token, store: memoryStore(true), connect: daemon.connect }))
      .rejects.toThrow(/could not be stored/)
  })
})
