import { generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { type Keyring } from "@getdomovoi/credential-store"
import { type RelaySuccessorStatement } from "@getdomovoi/protocol"
import { relaySuccessorSigningBytes } from "@getdomovoi/protocol/relay-admission"
import { afterEach, expect, it, vi } from "vitest"

import { claimProfile } from "./profile-lease.js"
import { adoptRelayProfileSuccessor, loadOrProvisionRelayChannel, prepareRelayProfileSuccessor, relayProvisioningDependencies, relayProvisioningPath } from "./relay-provisioning.js"
import { removeScratchDirectories } from "./test-scratch.js"

const roots: string[] = []
afterEach(async () => { await removeScratchDirectories(roots) })

async function fixture() {
  const homeDirectory = await mkdtemp(join(tmpdir(), "domovoi-relay-rotation-"))
  roots.push(homeDirectory)
  const signer = generateKeyPairSync("ed25519")
  const values = new Map<string, string>()
  const keyring: Keyring = {
    available: vi.fn(async () => true), get: vi.fn(async (account) => values.get(account)),
    set: vi.fn(async (account, value) => { values.set(account, value) }), delete: vi.fn(async (account) => { values.delete(account) }),
  }
  const dependencies = { ...relayProvisioningDependencies, keyring, generateKey: vi.fn(() => randomBytes(32)) }
  const options = { homeDirectory, warn: vi.fn() }
  const input = { ...options, machineId: "machine-" + "a".repeat(32), identityPublicKey: signer.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url") }
  const first = (await loadOrProvisionRelayChannel(input, dependencies))!
  const oldKey = Buffer.from(first.privateKey).toString("base64url")
  first.privateKey.fill(0)
  const envelope = (statement: RelaySuccessorStatement) => ({ statement, signature: sign(null, relaySuccessorSigningBytes(statement), signer.privateKey).toString("base64url") })
  return { options, input, dependencies, values, first: first.identity, oldKey, envelope }
}

it("stages once without changing the active pin, adopts only an external signature, and erases the retired key", async () => {
  const f = await fixture()
  const statement = await prepareRelayProfileSuccessor(f.options, f.dependencies)
  expect(await prepareRelayProfileSuccessor(f.options, f.dependencies)).toEqual(statement)
  expect(f.dependencies.generateKey).toHaveBeenCalledTimes(2)
  expect(statement).toMatchObject({ generation: 2, previousChannelPublicKey: f.first.channel.responderPublicKey })
  const before = (await loadOrProvisionRelayChannel(f.input, f.dependencies))!
  expect(before.identity).toEqual(f.first)
  before.privateKey.fill(0)
  const signed = f.envelope(statement)
  const adopted = await adoptRelayProfileSuccessor(f.options, signed, f.dependencies)
  expect(adopted).toEqual({ ...f.first, generation: 2, channel: statement.channel })
  expect([...f.values.values()].join().includes(f.oldKey)).toBe(false)
  expect(await adoptRelayProfileSuccessor(f.options, signed, f.dependencies)).toEqual(adopted)
  const after = (await loadOrProvisionRelayChannel(f.input, f.dependencies))!
  expect(after.identity).toEqual(adopted)
  after.privateKey.fill(0)
  const record = JSON.parse(await readFile(relayProvisioningPath(f.options.homeDirectory), "utf8"))
  expect(record).toEqual({ version: 1, identity: adopted, custody: { kind: "keyring" }, successor: signed })
  expect(record).not.toHaveProperty("privateKey")
  const next = await prepareRelayProfileSuccessor(f.options, f.dependencies)
  expect(next).toMatchObject({ generation: 3, previousChannelPublicKey: statement.channel.responderPublicKey })
  await expect(adoptRelayProfileSuccessor(f.options, signed, f.dependencies)).resolves.toEqual(adopted)
  expect(await prepareRelayProfileSuccessor(f.options, f.dependencies)).toEqual(next)
})

it("recovers a missing warm credential through the saved public anchor without the old private key", async () => {
  const f = await fixture()
  f.values.clear()
  const statement = await prepareRelayProfileSuccessor(f.options, f.dependencies)
  await expect(loadOrProvisionRelayChannel(f.input, f.dependencies).then((channel) => { channel?.privateKey.fill(0); return "loaded" })).rejects.toThrow("pinned public key")
  await adoptRelayProfileSuccessor(f.options, f.envelope(statement), f.dependencies)
  const recovered = (await loadOrProvisionRelayChannel(f.input, f.dependencies))!
  expect(recovered.identity.generation).toBe(2)
  recovered.privateKey.fill(0)
})

it("refuses locked custody and real profile ownership before generating or adopting a key", async () => {
  const f = await fixture()
  const lease = claimProfile(f.options.homeDirectory)
  try { await expect(prepareRelayProfileSuccessor(f.options, f.dependencies)).rejects.toThrow("already owned") } finally { lease.release() }
  vi.mocked(f.dependencies.keyring.available).mockResolvedValue(false)
  await expect(prepareRelayProfileSuccessor(f.options, f.dependencies)).rejects.toThrow("OS keychain")
  expect(f.dependencies.generateKey).toHaveBeenCalledOnce()
  expect(f.dependencies.keyring.set).toHaveBeenCalledOnce()
})

it("does not publish a new pin for an invalid signature or a signed key absent from custody", async () => {
  const f = await fixture()
  const statement = await prepareRelayProfileSuccessor(f.options, f.dependencies)
  const before = await readFile(relayProvisioningPath(f.options.homeDirectory), "utf8")
  const valid = f.envelope(statement)
  const signature = Buffer.from(valid.signature, "base64url")
  signature[0] = signature[0]! ^ 1
  await expect(adoptRelayProfileSuccessor(f.options, { ...valid, signature: signature.toString("base64url") }, f.dependencies)).rejects.toThrow("Relay identity successor rejected")
  await expect(adoptRelayProfileSuccessor(f.options, f.envelope({ ...statement, machineId: "machine-" + "b".repeat(32) }), f.dependencies)).rejects.toThrow("Relay identity successor rejected")
  f.values.clear()
  await expect(adoptRelayProfileSuccessor(f.options, f.envelope(statement), f.dependencies)).rejects.toThrow("prepared")
  expect(await readFile(relayProvisioningPath(f.options.homeDirectory), "utf8")).toBe(before)
})

it("keeps the old pin usable when publication fails before rename and retries the same staged key", async () => {
  const f = await fixture()
  const statement = await prepareRelayProfileSuccessor(f.options, f.dependencies)
  const signed = f.envelope(statement)
  await expect(adoptRelayProfileSuccessor(f.options, signed, { ...f.dependencies, publishRecord: async () => { throw new Error("before rename") } })).rejects.toThrow("before rename")
  const old = (await loadOrProvisionRelayChannel(f.input, f.dependencies))!
  expect(old.identity).toEqual(f.first)
  old.privateKey.fill(0)
  expect(await prepareRelayProfileSuccessor(f.options, f.dependencies)).toEqual(statement)
  expect((await adoptRelayProfileSuccessor(f.options, signed, f.dependencies)).generation).toBe(2)
})

it("recovers the new pin after a post-rename failure and removes the old key on startup", async () => {
  const f = await fixture()
  const statement = await prepareRelayProfileSuccessor(f.options, f.dependencies)
  await expect(adoptRelayProfileSuccessor(f.options, f.envelope(statement), {
    ...f.dependencies, publishRecord: async (...args) => { await f.dependencies.publishRecord(...args); throw new Error("after rename") },
  })).rejects.toThrow("after rename")
  expect([...f.values.values()].join().includes(f.oldKey)).toBe(true)
  await expect(loadOrProvisionRelayChannel(f.input, {
    ...f.dependencies, publishRecord: async () => { throw new Error("pin flush denied") },
  }).then((channel) => { channel?.privateKey.fill(0); return "loaded" })).rejects.toThrow("pin flush denied")
  expect([...f.values.values()].join().includes(f.oldKey)).toBe(true)
  const recovered = (await loadOrProvisionRelayChannel(f.input, f.dependencies))!
  expect(recovered.identity.channel).toEqual(statement.channel)
  recovered.privateKey.fill(0)
  expect([...f.values.values()].join().includes(f.oldKey)).toBe(false)
})

it("retains the lease through pending custody writes and refuses read-back mismatch before publication", async () => {
  const f = await fixture()
  const originalSet = f.dependencies.keyring.set
  let release!: () => void, entered!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  f.dependencies.keyring.set = async (account, value) => { entered(); await waiting; await originalSet(account, value) }
  const preparing = prepareRelayProfileSuccessor(f.options, f.dependencies)
  await started
  try { expect(() => claimProfile(f.options.homeDirectory)).toThrow("already owned") } finally { release() }
  const statement = await preparing
  const lease = claimProfile(f.options.homeDirectory)
  lease.release()
  f.dependencies.keyring.set = async () => { f.values.clear() }
  await expect(adoptRelayProfileSuccessor(f.options, f.envelope(statement), f.dependencies)).rejects.toThrow("read-back")
  expect(JSON.parse(await readFile(relayProvisioningPath(f.options.homeDirectory), "utf8")).identity).toEqual(f.first)
})

it("states adoption already committed when retirement fails, then retries without generating another key", async () => {
  const f = await fixture()
  const statement = await prepareRelayProfileSuccessor(f.options, f.dependencies)
  const signed = f.envelope(statement)
  const set = f.dependencies.keyring.set
  f.dependencies.keyring.set = async (account, value) => {
    if ((JSON.parse(value) as { version: number }).version === 1) throw new Error("cleanup denied")
    await set(account, value)
  }
  await expect(adoptRelayProfileSuccessor(f.options, signed, f.dependencies)).rejects.toThrow("was adopted, but retired-key cleanup failed")
  expect(JSON.parse(await readFile(relayProvisioningPath(f.options.homeDirectory), "utf8")).identity.generation).toBe(2)
  expect([...f.values.values()].join().includes(f.oldKey)).toBe(true)
  f.dependencies.keyring.set = set
  expect((await adoptRelayProfileSuccessor(f.options, signed, f.dependencies)).generation).toBe(2)
  expect([...f.values.values()].join().includes(f.oldKey)).toBe(false)
  expect(f.dependencies.generateKey).toHaveBeenCalledTimes(2)
})

it("refuses exhausted generations and malformed pending records without replacing any key", async () => {
  const f = await fixture()
  const path = relayProvisioningPath(f.options.homeDirectory)
  const text = await readFile(path, "utf8")
  const record = JSON.parse(text)
  await writeFile(path, JSON.stringify({ ...record, identity: { ...record.identity, generation: Number.MAX_SAFE_INTEGER } }))
  await expect(prepareRelayProfileSuccessor(f.options, f.dependencies)).rejects.toThrow("generation is exhausted")
  expect(f.dependencies.generateKey).toHaveBeenCalledOnce()
  await writeFile(path, text)
  await prepareRelayProfileSuccessor(f.options, f.dependencies)
  const [account, value] = [...f.values][0]!
  const secret = JSON.parse(value)
  f.values.set(account, JSON.stringify({ ...secret, pending: { ...secret.pending, generation: 3 } }))
  await expect(prepareRelayProfileSuccessor(f.options, f.dependencies)).rejects.toThrow("does not match the saved pin")
  f.values.set(account, JSON.stringify({ ...secret, identityPrivateKey: "forbidden" }))
  await expect(prepareRelayProfileSuccessor(f.options, f.dependencies)).rejects.toThrow("Invalid relay channel credential")
  expect(f.dependencies.generateKey).toHaveBeenCalledTimes(2)
})
