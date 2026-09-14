import { createPrivateKey, createPublicKey } from "node:crypto"

import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createRelayPinStore, relayPinKey, type RelayPinStorage } from "./relay-pin"
import { WorkspaceShell } from "./workspace-shell"
import {
  completeHandshake,
  fail,
  installFakeWebSocket,
  respond,
  sentRequests,
  workspaceSnapshot,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness
beforeEach(() => { harness = installFakeWebSocket() })
afterEach(() => { cleanup(); harness.uninstall() })

const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() })

function memoryStorage(): RelayPinStorage & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return { items, async read(key) { return items.get(key) }, async write(key, value) { items.set(key, value) } }
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
function encode(bytes: Uint8Array): string {
  let bits = ""
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0")
  let out = ""
  for (let index = 0; index < bits.length; index += 6) out += alphabet[Number.parseInt(bits.slice(index, index + 6).padEnd(6, "0"), 2)]
  return out
}
function publicKey(algorithm: "ed25519" | "x25519", seed: number): string {
  const oid = algorithm === "ed25519" ? "06032b6570" : "06032b656e"
  const key = createPrivateKey({ key: Buffer.from(`302e0201003005${oid}04220420${Buffer.from(new Uint8Array(32).fill(seed)).toString("hex")}`, "hex"), format: "der", type: "pkcs8" })
  const der = createPublicKey(key).export({ format: "der", type: "spki" })
  return encode(new Uint8Array(der.subarray(der.length - 32)))
}

// The hello is the moment pairing has been proved on this connection, and it
// is the only moment the shell pins the daemon's relay identity: a pre-hello
// snapshot proves nothing, a refused relay.recovery leaves no pin, and a shell
// given no storage asks for nothing.
describe("relay pin on hello", () => {
  it("enrols the daemon's published identity after the hello, once", async () => {
    const storage = memoryStorage()
    render(<WorkspaceShell relayPinStorage={storage} />)
    const socket = harness.socket(0)
    const snapshot = workspaceSnapshot()
    await act(async () => { completeHandshake(socket, snapshot) })
    await settle()
    expect(sentRequests(socket, "relay.recovery")).toHaveLength(1)
    const identity = {
      version: 1 as const, machineId: snapshot.machine.id, identityPublicKey: publicKey("ed25519", 3), generation: 1,
      channel: { suite: "Noise_IK_25519_ChaChaPoly_SHA256" as const, responderPublicKey: publicKey("x25519", 7) },
    }
    await act(async () => { respond(socket, "relay.recovery", { identity }) })
    await settle()
    const saved = await createRelayPinStore(storage, snapshot.machine.id).read()
    expect(saved).toEqual({ version: 1, state: "trusted", identity })
    expect(storage.items.has(relayPinKey(snapshot.machine.id))).toBe(true)
  })

  it("keeps no pin when the daemon refuses relay recovery", async () => {
    const storage = memoryStorage()
    render(<WorkspaceShell relayPinStorage={storage} />)
    const socket = harness.socket(0)
    await act(async () => { completeHandshake(socket, workspaceSnapshot()) })
    await settle()
    await act(async () => { fail(socket, "relay.recovery", { code: -32602, message: "Relay recovery is unavailable" }) })
    await settle()
    expect(storage.items.size).toBe(0)
  })

  it("asks for nothing when the shell has no pin storage", async () => {
    render(<WorkspaceShell />)
    const socket = harness.socket(0)
    await act(async () => { completeHandshake(socket, workspaceSnapshot()) })
    await settle()
    expect(sentRequests(socket, "relay.recovery")).toHaveLength(0)
  })
})
