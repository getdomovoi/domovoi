import { describe, expect, it } from "vitest"

import type { CredentialStore, PairedDaemon } from "./credentials.js"
import { createPrivateKey, createPublicKey } from "node:crypto"

import { encodePairingPayload, protocolVersion } from "@getdomovoi/protocol"

import { pairWithDaemon, PairingError, readPairingCode, redeemPairingCode } from "./pair.js"
import { DaemonRefusedError, DaemonUnreachableError } from "./rpc.js"

const token = "t".repeat(43)
const machineId = `machine-${"d".repeat(32)}`
const deviceId = `device-${"1".repeat(32)}`
const code = "hearth-quiet-ember-42"
const payload = encodePairingPayload({ v: 1, url: "ws://127.0.0.1:47831/rpc", code })

// Real keys, because the protocol validates the identity as an Ed25519 point
// and the channel key as canonical X25519 before it will read a pin.
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
function encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, result = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 6) { bits -= 6; result += alphabet[(value >>> bits) & 63] }
  }
  if (bits > 0) result += alphabet[(value << (6 - bits)) & 63]
  return result
}
function publicKey(algorithm: "ed25519" | "x25519", fill: number): string {
  const oid = algorithm === "ed25519" ? "06032b6570" : "06032b656e"
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from(`302e0201003005${oid}04220420`, "hex"), Buffer.alloc(32, fill)]), format: "der", type: "pkcs8" })
  const der = createPublicKey(key).export({ format: "der", type: "spki" })
  return encode(new Uint8Array(der.subarray(der.length - 32)))
}
const identityPublicKey = publicKey("ed25519", 3)
const channelKey = (fill: number) => publicKey("x25519", fill)

function memoryStore(failSave = false): CredentialStore & { saved: PairedDaemon[] } {
  const saved: PairedDaemon[] = []
  return {
    where: "keyring",
    saved,
    load: async (endpoint) => saved.find((record) => record.endpoint === endpoint),
    save: async (record) => { if (failSave) throw new Error("disk full"); saved.push(record) },
    forget: async () => {},
    update: async (endpoint, change) => {
      if (failSave) throw new Error("disk full")
      const index = saved.findIndex((record) => record.endpoint === endpoint)
      const next = change(saved[index])
      if (next === undefined) return false
      if (index === -1) saved.push(next); else saved[index] = next
      return true
    },
  }
}

function fakeDaemon(options: { helloRejects?: string | Error; current?: unknown; recovery?: unknown; recoveryThrows?: Error } = {}) {
  const calls: string[] = []
  let closed = 0
  const connect = async (authToken: string) => {
    calls.push(`hello ${authToken === token ? "ok" : "bad"}`)
    if (options.helloRejects instanceof Error) throw options.helloRejects
    if (options.helloRejects) throw new Error(options.helloRejects)
    return {
      call: async (method: string) => {
        calls.push(method)
        if (method === "device.current") return options.current ?? { kind: "client", machineId, deviceId, client: "cli" }
        if (method === "relay.recovery") {
          if (options.recoveryThrows) throw options.recoveryThrows
          if (options.recovery === undefined) throw new DaemonRefusedError("Relay recovery is unavailable", -32602)
          return options.recovery
        }
        throw new Error(`unexpected ${method}`)
      },
      close: () => { closed += 1 },
    }
  }
  return { calls, connect, closed: () => closed }
}

describe("readPairingCode", () => {
  it("reads the payload domovoid pair prints, with the address it carries", () => {
    expect(readPairingCode(`${payload}\n`)).toEqual({ code, url: "ws://127.0.0.1:47831/rpc" })
    expect(readPairingCode(`Cannot scan it? Paste this on the device:\n${payload}\n`)).toEqual({ code, url: "ws://127.0.0.1:47831/rpc" })
  })

  it("reads a bare code, or the line domovoid pair prints it on", () => {
    expect(readPairingCode(`${code}\n`)).toEqual({ code })
    expect(readPairingCode(`Pairing code: ${code}`)).toEqual({ code })
  })

  it("refuses a credential, an empty line, and a payload that cannot be read", () => {
    expect(() => readPairingCode(token)).toThrow(PairingError)
    expect(() => readPairingCode("")).toThrow(PairingError)
    expect(() => readPairingCode("domovoi-pair:1:!!!")).toThrow(PairingError)
  })
})

function fakeRedeemer(options: { result?: unknown; refuse?: Error; openFails?: Error } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  let closed = 0
  const open = async () => {
    if (options.openFails) throw options.openFails
    return {
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params })
        if (options.refuse) throw options.refuse
        return options.result ?? {
          device: { id: deviceId, label: "my shell", pairedAt: "2026-10-03T10:00:00Z", binding: { kind: "client", client: "cli" } },
          token,
        }
      },
      close: () => { closed += 1 },
    }
  }
  return { calls, open, closed: () => closed }
}

describe("redeemPairingCode", () => {
  it("spends the code on an unauthenticated socket and returns the credential the daemon minted", async () => {
    const daemon = fakeRedeemer()
    const redeemed = await redeemPairingCode({ endpoint: "ws://127.0.0.1:47831/rpc", code, label: "my shell", open: daemon.open })
    expect(daemon.calls).toEqual([{ method: "device.redeemCode", params: { code, label: "my shell", protocolVersion } }])
    expect(redeemed).toEqual({ token, device: { id: deviceId, label: "my shell" } })
    expect(daemon.closed()).toBe(1)
  })

  it("keeps nothing the daemon issued for another kind of client", async () => {
    const daemon = fakeRedeemer({ result: {
      device: { id: deviceId, label: "my shell", pairedAt: "2026-10-03T10:00:00Z", binding: { kind: "client", client: "phone" } },
      token,
    } })
    await expect(redeemPairingCode({ endpoint: "ws://127.0.0.1:47831/rpc", code, label: "my shell", open: daemon.open }))
      .rejects.toThrow(/issued for a phone/)
    expect(daemon.closed()).toBe(1)
  })

  it("passes the daemon's refusal on as a pairing error, and an unreachable daemon as itself", async () => {
    const daemon = fakeRedeemer({ refuse: new DaemonRefusedError("Pairing was refused", -32001) })
    await expect(redeemPairingCode({ endpoint: "ws://127.0.0.1:47831/rpc", code, label: "my shell", open: daemon.open }))
      .rejects.toThrow(new PairingError("Pairing was refused"))
    expect(daemon.closed()).toBe(1)
    const unreachable = fakeRedeemer({ openFails: new DaemonUnreachableError("Could not reach ws://127.0.0.1:47831/rpc") })
    await expect(redeemPairingCode({ endpoint: "ws://127.0.0.1:47831/rpc", code, label: "my shell", open: unreachable.open }))
      .rejects.toThrow(DaemonUnreachableError)
  })
})

describe("pair", () => {
  it("proves the credential with an authenticated hello, then stores it with the device it names", async () => {
    const store = memoryStore()
    const daemon = fakeDaemon()
    const result = await pairWithDaemon({ endpoint: "ws://127.0.0.1:47831/rpc", credential: token, label: "my shell", store, connect: daemon.connect })
    expect(daemon.calls).toEqual(["hello ok", "device.current", "relay.recovery"])
    expect(store.saved).toEqual([{ endpoint: "ws://127.0.0.1:47831/rpc", deviceId, machineId, token, label: "my shell" }])
    expect(result).toEqual({ deviceId, machineId, relayPin: "unavailable" })
    expect(daemon.closed()).toBe(1)
  })

  it("enrols the daemon's relay identity as the trusted pin when it publishes one", async () => {
    const store = memoryStore()
    const identity = {
      version: 1, machineId, generation: 1, identityPublicKey,
      channel: { suite: "Noise_IK_25519_ChaChaPoly_SHA256", responderPublicKey: channelKey(7) },
    }
    const daemon = fakeDaemon({ recovery: { identity } })
    const result = await pairWithDaemon({ endpoint: "ws://127.0.0.1:47831/rpc", credential: token, store, connect: daemon.connect })
    expect(result.relayPin).toBe("enrolled")
    expect(store.saved[0]?.relayPin).toEqual({ version: 1, identity, state: "trusted" })
  })

  it("keeps the pairing when the published relay identity cannot be enrolled, and says so", async () => {
    const store = memoryStore()
    const daemon = fakeDaemon({ recovery: { identity: { version: 1, machineId: `machine-${"9".repeat(32)}`, generation: 1,
      identityPublicKey, channel: { suite: "Noise_IK_25519_ChaChaPoly_SHA256", responderPublicKey: channelKey(7) } } } })
    await expect(pairWithDaemon({ endpoint: "ws://127.0.0.1:47831/rpc", credential: token, store, connect: daemon.connect }))
      .rejects.toThrow(/paired, but its relay identity was not enrolled.*another machine/)
    expect(store.saved).toHaveLength(1)
    expect(store.saved[0]?.relayPin).toBeUndefined()
  })

  it("stores nothing when the daemon refuses the credential, and never quotes it", async () => {
    const store = memoryStore()
    const daemon = fakeDaemon({ helloRejects: `refused ${token}` })
    await expect(pairWithDaemon({ endpoint: "ws://127.0.0.1:47831/rpc", credential: token, store, connect: daemon.connect }))
      .rejects.toThrow(/^The daemon refused this credential$/)
    expect(store.saved).toEqual([])
  })

  it("passes a daemon lost before the proving hello through as unreachable, not as a refusal", async () => {
    const store = memoryStore()
    const daemon = fakeDaemon({ helloRejects: new DaemonUnreachableError("Could not reach ws://127.0.0.1:47831/rpc: connect ECONNREFUSED") })
    await expect(pairWithDaemon({ endpoint: "ws://127.0.0.1:47831/rpc", credential: token, store, connect: daemon.connect }))
      .rejects.toThrow(DaemonUnreachableError)
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

  it("keeps a same-machine pin that needs recovery when pairing again, and recovers rather than re-enrols", async () => {
    const store = memoryStore()
    const identity = {
      version: 1 as const, machineId, generation: 1, identityPublicKey,
      channel: { suite: "Noise_IK_25519_ChaChaPoly_SHA256" as const, responderPublicKey: channelKey(7) },
    }
    store.saved.push({ endpoint: "ws://127.0.0.1:47831/rpc", deviceId, machineId, token: "old",
      relayPin: { version: 1, identity, state: "recovery-required" } })
    // A daemon publishing a fresh identity with no successor is the stolen-profile shape.
    const foreign = { ...identity, channel: { ...identity.channel, responderPublicKey: channelKey(8) } }
    const daemon = fakeDaemon({ recovery: { identity: foreign } })
    await expect(pairWithDaemon({ endpoint: "ws://127.0.0.1:47831/rpc", credential: token, store, connect: daemon.connect }))
      .rejects.toThrow(/not enrolled.*No relay successor/)
    expect(store.saved[0]?.token).toBe(token)
    expect(store.saved[0]?.relayPin).toEqual({ version: 1, identity, state: "recovery-required" })
  })

  it("drops a pin that belongs to a different machine at the same address", async () => {
    const store = memoryStore()
    const otherIdentity = {
      version: 1 as const, machineId: `machine-${"9".repeat(32)}`, generation: 1, identityPublicKey,
      channel: { suite: "Noise_IK_25519_ChaChaPoly_SHA256" as const, responderPublicKey: channelKey(7) },
    }
    store.saved.push({ endpoint: "ws://127.0.0.1:47831/rpc", deviceId, machineId: otherIdentity.machineId, token: "old",
      relayPin: { version: 1, identity: otherIdentity, state: "trusted" } })
    const daemon = fakeDaemon()
    const result = await pairWithDaemon({ endpoint: "ws://127.0.0.1:47831/rpc", credential: token, store, connect: daemon.connect })
    expect(result.relayPin).toBe("unavailable")
    expect(store.saved).toHaveLength(1)
    expect(store.saved[0]?.relayPin).toBeUndefined()
  })

  it.each([
    ["a timeout", new DaemonUnreachableError("The daemon did not answer relay.recovery within 100 ms"), /did not answer/],
    ["a socket error passed through raw", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), /ECONNRESET/],
    ["a send that threw", new TypeError("socket.send is not a function"), /socket\.send/],
  ])("does not read %s as the daemon being unprovisioned", async (_name, failure, expected) => {
    const store = memoryStore()
    const daemon = fakeDaemon({ recoveryThrows: failure })
    await expect(pairWithDaemon({ endpoint: "ws://127.0.0.1:47831/rpc", credential: token, store, connect: daemon.connect }))
      .rejects.toThrow(expected)
    expect(store.saved).toHaveLength(1)
  })
})
