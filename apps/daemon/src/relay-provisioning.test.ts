import { createPrivateKey, createPublicKey, sign } from "node:crypto"
import { chmod, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { type Keyring } from "@getdomovoi/credential-store"
import { relayPublicKeyFromPrivateKey, relaySuccessorSigningBytes } from "@getdomovoi/protocol/relay-admission"
import { afterEach, describe, expect, it, vi } from "vitest"

import { parseDaemonEnvironment } from "./config.js"
import { loadOrProvisionRelayChannel, relayProvisioningDependencies, relayProvisioningPath, verifyRelayProfileSuccessor } from "./relay-provisioning.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { createServiceConfiguration, parseServiceConfiguration, serializeServiceConfiguration, serviceEnvironment } from "./service/configuration.js"

const publicIdentity = createPublicKey(createPrivateKey({
  key: Buffer.from("302e020100300506032b657004220420" + "42".repeat(32), "hex"), format: "der", type: "pkcs8",
})).export({ format: "der", type: "spki" }).subarray(-32).toString("base64url")
const roots: string[] = []
afterEach(async () => { await removeScratchDirectories(roots) })
async function fixture() {
  const homeDirectory = await mkdtemp(join(tmpdir(), "domovoi-relay-custody-"))
  roots.push(homeDirectory)
  const values = new Map<string, string>()
  const keyring: Keyring = {
    available: vi.fn(async () => true), get: vi.fn(async (account) => values.get(account)),
    set: vi.fn(async (account, value) => { values.set(account, value) }), delete: vi.fn(async (account) => { values.delete(account) }),
  }
  const generateKey = vi.fn(() => new Uint8Array(32).fill(7))
  return {
    input: { homeDirectory, machineId: "machine-" + "a".repeat(32), identityPublicKey: publicIdentity, warn: vi.fn() },
    dependencies: { ...relayProvisioningDependencies, keyring, generateKey }, values,
  }
}

describe("relay channel provisioning", () => {
  it("leaves an unconfigured profile direct-only without probing the keychain", async () => {
    const { input, dependencies } = await fixture()
    const { identityPublicKey: _key, ...unconfigured } = input
    expect(await loadOrProvisionRelayChannel(unconfigured, dependencies)).toBeUndefined()
    expect(dependencies.keyring.available).not.toHaveBeenCalled()
    expect(dependencies.generateKey).not.toHaveBeenCalled()
  })

  it("persists only the public identity anchor in the profile and reuses the channel secret on restart", async () => {
    const { input, dependencies, values } = await fixture()
    const first = await loadOrProvisionRelayChannel(input, dependencies)
    expect(first).toBeDefined()
    expect(first!.identity.channel.responderPublicKey).toBe(relayPublicKeyFromPrivateKey(first!.privateKey))
    expect(first!.identity).toMatchObject({ identityPublicKey: publicIdentity, machineId: input.machineId, generation: 1 })
    const record = JSON.parse(await readFile(relayProvisioningPath(input.homeDirectory), "utf8")) as Record<string, unknown>
    expect(record).toEqual({ version: 1, identity: first!.identity, custody: { kind: "keyring" } })
    expect(JSON.stringify(record)).not.toContain(Buffer.from(first!.privateKey).toString("base64url"))
    expect(values.size).toBe(1)
    const secret = JSON.parse([...values.values()][0]!) as Record<string, unknown>
    expect(Object.keys(secret).sort()).toEqual(["identityPublicKey", "machineId", "privateKey", "version"])
    const { identityPublicKey: _key, ...restart } = input
    expect(await loadOrProvisionRelayChannel(restart, dependencies)).toEqual(first)
    expect(dependencies.generateKey).toHaveBeenCalledTimes(1)
    expect(dependencies.keyring.set).toHaveBeenCalledTimes(1)
    first!.privateKey.fill(0)
  })

  it("refuses a locked keychain, including after provisioning, without generating or writing a file", async () => {
    const { input, dependencies } = await fixture()
    vi.mocked(dependencies.keyring.available).mockResolvedValue(false)
    dependencies.keyring.cause = () => new Error("locked")
    await expect(loadOrProvisionRelayChannel(input, dependencies)).rejects.toThrow("Unlock it and run this again")
    expect(dependencies.generateKey).not.toHaveBeenCalled()
    await expect(readFile(relayProvisioningPath(input.homeDirectory))).rejects.toMatchObject({ code: "ENOENT" })
    vi.mocked(dependencies.keyring.available).mockResolvedValue(true)
    const provisioned = await loadOrProvisionRelayChannel(input, dependencies)
    provisioned!.privateKey.fill(0)
    vi.mocked(dependencies.keyring.available).mockResolvedValue(false)
    await expect(loadOrProvisionRelayChannel(input, dependencies)).rejects.toThrow("locked")
    expect(dependencies.generateKey).toHaveBeenCalledTimes(1)
  })

  it("requires an explicit file, warns about impersonation, and refuses unreadable modes", async () => {
    const { input, dependencies } = await fixture()
    const credentialFile = join(input.homeDirectory, ".domovoi", "relay-channel.key")
    const first = await loadOrProvisionRelayChannel({ ...input, credentialFile }, dependencies)
    expect(input.warn).toHaveBeenCalledWith(expect.stringContaining("impersonate this daemon"))
    expect(dependencies.keyring.available).not.toHaveBeenCalled()
    const { identityPublicKey: _key, ...restart } = input
    expect(await loadOrProvisionRelayChannel(restart, dependencies)).toEqual(first)
    if (process.platform !== "win32") {
      await chmod(credentialFile, 0o644)
      await expect(loadOrProvisionRelayChannel(restart, dependencies)).rejects.toThrow("mode 0600")
    }
    first!.privateKey.fill(0)
  })

  it("refuses key loss, tampering, machine changes and custody changes without replacing the pin", async () => {
    const { input, dependencies, values } = await fixture()
    const first = await loadOrProvisionRelayChannel(input, dependencies)
    first!.privateKey.fill(0)
    const record = await readFile(relayProvisioningPath(input.homeDirectory), "utf8")
    const [account, value] = [...values][0]!
    values.delete(account)
    await expect(loadOrProvisionRelayChannel(input, dependencies)).rejects.toThrow("missing")
    values.set(account, JSON.stringify({ ...JSON.parse(value), privateKey: Buffer.alloc(32, 8).toString("base64url") }))
    await expect(loadOrProvisionRelayChannel(input, dependencies)).rejects.toThrow("does not match")
    values.set(account, value)
    await expect(loadOrProvisionRelayChannel({ ...input, machineId: "machine-" + "b".repeat(32) }, dependencies)).rejects.toThrow("machine")
    await expect(loadOrProvisionRelayChannel({ ...input, credentialFile: join(input.homeDirectory, "other.key") }, dependencies)).rejects.toThrow("custody")
    expect(dependencies.generateKey).toHaveBeenCalledTimes(1)
    expect(await readFile(relayProvisioningPath(input.homeDirectory), "utf8")).toBe(record)
  })

  it("verifies a successor from the saved public anchor after warm-key loss without modifying the profile", async () => {
    const { input, dependencies, values } = await fixture()
    const first = await loadOrProvisionRelayChannel(input, dependencies)
    first!.privateKey.fill(0)
    const before = await readFile(relayProvisioningPath(input.homeDirectory), "utf8")
    values.clear()
    const statement = {
      version: 1, machineId: input.machineId, identityPublicKey: publicIdentity, generation: 2,
      previousChannelPublicKey: first!.identity.channel.responderPublicKey,
      channel: { ...first!.identity.channel, responderPublicKey: relayPublicKeyFromPrivateKey(new Uint8Array(32).fill(8)) },
    }
    const externalSigner = createPrivateKey({ key: Buffer.from("302e020100300506032b657004220420" + "42".repeat(32), "hex"), format: "der", type: "pkcs8" })
    const signature = sign(null, relaySuccessorSigningBytes(statement), externalSigner).toString("base64url")
    const successor = await verifyRelayProfileSuccessor(input.homeDirectory, { statement, signature })
    expect(successor).toEqual({ ...first!.identity, generation: 2, channel: statement.channel })
    await expect(verifyRelayProfileSuccessor(input.homeDirectory, { statement: { ...statement, generation: 3 }, signature })).rejects.toThrow("Relay identity successor rejected")
    expect(await readFile(relayProvisioningPath(input.homeDirectory), "utf8")).toBe(before)
    await unlink(relayProvisioningPath(input.homeDirectory))
    await expect(verifyRelayProfileSuccessor(input.homeDirectory, { statement, signature })).rejects.toThrow("not provisioned")
  })

  it("reuses a durably stored key after interrupted public-record publication", async () => {
    const { input, dependencies } = await fixture()
    const publishRecord = vi.fn(relayProvisioningDependencies.publishRecord)
    publishRecord.mockRejectedValueOnce(new Error("record publication failed"))
    await expect(loadOrProvisionRelayChannel(input, { ...dependencies, publishRecord })).rejects.toThrow("record publication failed")
    const recovered = await loadOrProvisionRelayChannel(input, { ...dependencies, publishRecord })
    expect(recovered!.privateKey).toEqual(new Uint8Array(32).fill(7))
    expect(dependencies.generateKey).toHaveBeenCalledTimes(1)
    recovered!.privateKey.fill(0)
  })

  it("does not publish an anchor when key storage fails or returns different bytes", async () => {
    const { input, dependencies } = await fixture()
    vi.mocked(dependencies.keyring.set).mockRejectedValueOnce(new Error("storage denied"))
    await expect(loadOrProvisionRelayChannel(input, dependencies)).rejects.toThrow("storage denied")
    await expect(readFile(relayProvisioningPath(input.homeDirectory))).rejects.toMatchObject({ code: "ENOENT" })
    vi.mocked(dependencies.keyring.get).mockResolvedValue(undefined)
    await expect(loadOrProvisionRelayChannel(input, dependencies)).rejects.toThrow("read-back")
    await expect(readFile(relayProvisioningPath(input.homeDirectory))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects private identity fields, malformed metadata and public-record/secret-path collision", async () => {
    const { input, dependencies } = await fixture()
    await expect(loadOrProvisionRelayChannel({ ...input, credentialFile: relayProvisioningPath(input.homeDirectory) }, dependencies)).rejects.toThrow("public record")
    const first = await loadOrProvisionRelayChannel(input, dependencies)
    first!.privateKey.fill(0)
    const path = relayProvisioningPath(input.homeDirectory)
    const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    await writeFile(path, JSON.stringify({ ...record, identityPrivateKey: "forbidden" }))
    await expect(loadOrProvisionRelayChannel(input, dependencies)).rejects.toThrow("Invalid relay provisioning record")
    await writeFile(path, "{")
    await expect(loadOrProvisionRelayChannel(input, dependencies)).rejects.toThrow("Invalid relay provisioning record")
    await unlink(path)
  })

  it("validates opt-in public settings and preserves them across service serialization", async () => {
    const { input } = await fixture()
    const credentialFile = join(input.homeDirectory, ".domovoi", "relay.key")
    const environment = { DOMOVOI_RELAY_IDENTITY_PUBLIC_KEY: publicIdentity, DOMOVOI_RELAY_CREDENTIAL_FILE: credentialFile }
    expect(parseDaemonEnvironment(environment, input.homeDirectory)).toMatchObject({ relayIdentityPublicKey: publicIdentity, relayCredentialFile: credentialFile })
    const config = createServiceConfiguration(environment, { homeDirectory: input.homeDirectory, workingDirectory: input.homeDirectory, platform: process.platform })
    const restored = parseServiceConfiguration(serializeServiceConfiguration(config))
    expect(serviceEnvironment(restored)).toMatchObject(environment)
    for (const invalid of [
      { DOMOVOI_RELAY_IDENTITY_PUBLIC_KEY: "A".repeat(43) },
      { DOMOVOI_RELAY_CREDENTIAL_FILE: "relative/key" },
      { DOMOVOI_RELAY_CREDENTIAL_FILE: "" },
    ]) expect(() => parseDaemonEnvironment(invalid, input.homeDirectory)).toThrow(/DOMOVOI_RELAY_/)
  })
})
