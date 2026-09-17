import { profileDirectory, type ProfileLocation } from "./profile-directory.js"
import { createHash, randomBytes } from "node:crypto"
import { isAbsolute, join, resolve } from "node:path"

import { nativeKeyring, openCredentialBackend, readPrivateFile, writePrivateFile, type Keyring } from "@getdomovoi/credential-store"
import { machineIdSchema, relayBytes32Schema, relayIdentityPinSchema, relayPublicKeySchema, relaySignedSuccessorSchema, relaySuccessorStatementSchema, type RelayIdentityPin, type RelaySignedSuccessor, type RelaySuccessorStatement } from "@getdomovoi/protocol"
import { relayIdentityPublicKeyIsValid, relayPublicKeyFromPrivateKey, verifyRelayChannelSuccessor } from "@getdomovoi/protocol/relay-admission"
import { z } from "zod"

import type { OperationDeadline } from "./operation-deadline.js"
import { claimProfile } from "./profile-lease.js"

const maximumCredentialBytes = 1_024
const maximumRecordBytes = 8_192
const absolutePath = z.string().min(1).max(4_096).refine((path) => isAbsolute(path) && !/[\0\r\n]/u.test(path))
const recordSchema = z.object({
  version: z.literal(1),
  identity: relayIdentityPinSchema,
  custody: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("keyring") }).strict(),
    z.object({ kind: z.literal("file"), path: absolutePath }).strict(),
  ]),
  successor: relaySignedSuccessorSchema.optional(),
}).strict()
const initialSecretSchema = z.object({
  version: z.literal(1), machineId: machineIdSchema,
  identityPublicKey: relayPublicKeySchema, privateKey: relayBytes32Schema,
}).strict()
const stagedSecretSchema = z.object({
  version: z.literal(2), machineId: machineIdSchema, identityPublicKey: relayPublicKeySchema,
  keys: z.array(relayBytes32Schema).min(1).max(2), pending: relaySuccessorStatementSchema,
}).strict()
const secretSchema = z.discriminatedUnion("version", [initialSecretSchema, stagedSecretSchema])
type ChannelSecret = { machineId: string; identityPublicKey: string; keys: string[]; pending?: RelaySuccessorStatement }
type ProvisioningRecord = z.infer<typeof recordSchema>

export type ProvisionedRelayChannel = { privateKey: Uint8Array; identity: RelayIdentityPin; successor?: RelaySignedSuccessor }
type Options = {
  homeDirectory: ProfileLocation
  machineId: string
  identityPublicKey?: string
  credentialFile?: string
  warn(message: string): void
  deadline?: OperationDeadline
}
type Dependencies = {
  keyring: Keyring
  generateKey(): Uint8Array
  publishRecord: typeof writePrivateFile
}
export const relayProvisioningDependencies: Dependencies = {
  keyring: nativeKeyring({ service: "domovoi-relay", probeAccount: "domovoi-relay-probe" }),
  generateKey: () => randomBytes(32),
  publishRecord: writePrivateFile,
}

export const relayProvisioningPath = (homeDirectory: ProfileLocation) => join(profileDirectory(homeDirectory), "relay-identity.json")
const fileWarning = (path: string) => `The relay channel key is kept in ${path}, not in an OS keychain. The file is mode 0600 and holds the X25519 private key. Anyone who can read it can impersonate this daemon until paired clients accept an identity-signed successor. The identity private key must be kept off this machine.`
const unavailable = (cause?: Error) => (cause
  ? `The OS keychain did not answer (${cause.message}), so this daemon's relay channel key cannot be kept there. Unlock it and run this again, or`
  : "No OS keychain is available here, so there is nowhere safe to keep this daemon's relay channel key.")
  + " Set DOMOVOI_RELAY_CREDENTIAL_FILE to an explicit path to keep it in a file you own (mode 0600), and treat that file as the daemon identity it can impersonate."

function parseRecord(text: string) {
  try {
    const record = recordSchema.parse(JSON.parse(text))
    if (!relayIdentityPublicKeyIsValid(record.identity.identityPublicKey)) throw new Error("identity")
    if (record.successor) {
      const prior = { ...record.identity, generation: record.identity.generation - 1, channel: { ...record.identity.channel, responderPublicKey: record.successor.statement.previousChannelPublicKey } }
      const accepted = verifyRelayChannelSuccessor(prior, record.successor)
      if (accepted.channel.responderPublicKey !== record.identity.channel.responderPublicKey) throw new Error("successor")
    }
    return record
  } catch { throw new Error("Invalid relay provisioning record. Restore its public record; no key was replaced.") }
}

function parseSecret(text: string): ChannelSecret {
  try {
    if (Buffer.byteLength(text, "utf8") > maximumCredentialBytes) throw new Error("oversized")
    const parsed = secretSchema.parse(JSON.parse(text))
    return parsed.version === 1
      ? { machineId: parsed.machineId, identityPublicKey: parsed.identityPublicKey, keys: [parsed.privateKey] }
      : parsed
  } catch { throw new Error("Invalid relay channel credential. No key was replaced.") }
}

function encodedKeyForPin(secret: ChannelSecret, identity: RelayIdentityPin): string | undefined {
  if (secret.machineId !== identity.machineId || secret.identityPublicKey !== identity.identityPublicKey) throw new Error("Relay channel credential does not match this machine and identity anchor")
  let found: string | undefined
  for (const encoded of secret.keys) {
    const key = Buffer.from(encoded, "base64url")
    try {
      if (relayPublicKeyFromPrivateKey(key) !== identity.channel.responderPublicKey) continue
      if (found !== undefined) throw new Error("Relay channel credential contains duplicate keys")
      found = encoded
    } finally { key.fill(0) }
  }
  return found
}

function activeSecret(identity: RelayIdentityPin, privateKey: string): string {
  return JSON.stringify({ version: 1, machineId: identity.machineId, identityPublicKey: identity.identityPublicKey, privateKey })
}

async function openCustody(homeDirectory: ProfileLocation, machineId: string, credentialFile: string | undefined, warn: Options["warn"], dependencies: Dependencies) {
  const store = await openCredentialBackend({
    keyring: dependencies.keyring, ...(credentialFile !== undefined ? { credentialFile } : {}),
    warn, fileWarning, unavailable, maximumBytes: maximumCredentialBytes,
  })
  const account = createHash("sha256").update("domovoi.relay-profile.v1\0").update(resolve(typeof homeDirectory === "string" ? homeDirectory : profileDirectory(homeDirectory))).update("\0").update(machineId).digest("hex")
  const read = () => store.where === "file" ? store.read() : store.keyring.get(account)
  const write = (value: string) => store.where === "file" ? store.write(value) : store.keyring.set(account, value)
  const publish = async (value: string) => {
    if (Buffer.byteLength(value, "utf8") > maximumCredentialBytes) throw new Error("Relay channel credential exceeds its byte limit")
    await write(value)
    if (await read() !== value) throw new Error("Relay channel credential read-back did not match. The public anchor was not published.")
  }
  return { read, write, publish, custody: store.where === "file" ? { kind: "file" as const, path: store.path } : { kind: "keyring" as const } }
}

// Read-only verification still works after the warm credential is lost. It
// neither adopts the successor nor proves that a recipient persisted its pin.
export async function verifyRelayProfileSuccessor(homeDirectory: ProfileLocation, envelope: unknown): Promise<RelayIdentityPin> {
  const text = await readPrivateFile(relayProvisioningPath(homeDirectory), { maximumBytes: maximumRecordBytes })
  if (text === undefined) throw new Error("Relay identity is not provisioned")
  return verifyRelayChannelSuccessor(parseRecord(text).identity, envelope)
}

// The production factory holds the profile lease across this operation. No
// private Ed25519 identity enters this API; it accepts only an external anchor.
export async function loadOrProvisionRelayChannel(options: Options, dependencies = relayProvisioningDependencies): Promise<ProvisionedRelayChannel | undefined> {
  const check = () => options.deadline?.throwIfExpired()
  check()
  const path = relayProvisioningPath(options.homeDirectory)
  const text = await readPrivateFile(path, { maximumBytes: maximumRecordBytes })
  check()
  const record = text === undefined ? undefined : parseRecord(text)
  if (!record && options.identityPublicKey === undefined) {
    if (options.credentialFile !== undefined) throw new Error("Initial relay provisioning requires DOMOVOI_RELAY_IDENTITY_PUBLIC_KEY from an off-machine identity signer")
    return undefined
  }
  const identityPublicKey = options.identityPublicKey ?? record!.identity.identityPublicKey
  if (!relayIdentityPublicKeyIsValid(identityPublicKey)) throw new Error("Invalid relay identity public key")
  machineIdSchema.parse(options.machineId)
  if (record && record.identity.machineId !== options.machineId) throw new Error("Relay provisioning belongs to another machine. No key was replaced.")
  if (record && record.identity.identityPublicKey !== identityPublicKey) throw new Error("Relay identity anchor does not match the profile. No key was replaced.")
  if (record && options.credentialFile !== undefined && (record.custody.kind !== "file" || resolve(record.custody.path) !== resolve(options.credentialFile))) {
    throw new Error("Relay credential custody does not match the profile. No key was moved.")
  }
  const credentialFile = record?.custody.kind === "file" ? record.custody.path : options.credentialFile
  if (credentialFile !== undefined) {
    absolutePath.parse(credentialFile)
    if (resolve(credentialFile) === resolve(path)) throw new Error("The relay secret cannot use its public record path")
  }
  const store = await openCustody(options.homeDirectory, options.machineId, credentialFile, options.warn, dependencies)
  check()
  let stored = await store.read()
  check()
  if (stored === undefined && record) throw new Error("The provisioned relay channel key is missing. Restore its credential; automatic replacement is refused.")
  // A recovered file may be visible after a rename whose directory flush
  // failed. Republish the same bytes before committing their first public pin.
  let needsPublication = stored === undefined || (!record && store.custody.kind === "file")
  let privateKey: Uint8Array | undefined
  try {
    if (stored === undefined) {
      privateKey = dependencies.generateKey()
      if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) throw new Error("Invalid generated relay channel key")
      stored = JSON.stringify({ version: 1, machineId: options.machineId, identityPublicKey, privateKey: Buffer.from(privateKey).toString("base64url") })
    } else {
      const secret = parseSecret(stored)
      if (secret.machineId !== options.machineId || secret.identityPublicKey !== identityPublicKey) throw new Error("Relay channel credential does not match this machine and identity anchor")
      if (!record && secret.pending) throw new Error("A staged relay successor requires its saved public record")
      const encoded = record ? encodedKeyForPin(secret, record.identity) : secret.keys[0]
      if (!encoded) throw new Error("Relay channel credential does not match the pinned public key")
      privateKey = Buffer.from(encoded, "base64url")
      if (record && secret.pending?.channel.responderPublicKey === record.identity.channel.responderPublicKey) {
        // The pin rename committed but retirement may have been interrupted.
        // Make its directory entry durable before erasing the fallback key.
        check()
        await dependencies.publishRecord(path, JSON.stringify(record) + "\n", { maximumBytes: maximumRecordBytes })
        check()
        stored = activeSecret(record.identity, encoded)
        needsPublication = true
      }
    }
    if (needsPublication) {
      check()
      await store.write(stored)
      check()
      if (await store.read() !== stored) throw new Error("Relay channel credential read-back did not match. The public anchor was not published.")
      check()
    }
    const responderPublicKey = relayPublicKeyFromPrivateKey(privateKey)
    if (record && record.identity.channel.responderPublicKey !== responderPublicKey) throw new Error("Relay channel credential does not match the pinned public key")
    const identity = record?.identity ?? relayIdentityPinSchema.parse({
      version: 1, machineId: options.machineId, identityPublicKey, generation: 1,
      channel: { suite: "Noise_IK_25519_ChaChaPoly_SHA256", responderPublicKey },
    })
    if (!record) {
      check()
      await dependencies.publishRecord(path, JSON.stringify({
        version: 1, identity,
        custody: store.custody,
      }) + "\n", { maximumBytes: maximumRecordBytes })
    }
    check()
    return { privateKey: new Uint8Array(privateKey), identity, ...(record?.successor ? { successor: record.successor } : {}) }
  } finally { privateKey?.fill(0) }
}

export type RelayProfileRecoveryOptions = { homeDirectory: ProfileLocation; warn(message: string): void }

async function recoveryRecord(options: RelayProfileRecoveryOptions): Promise<ProvisioningRecord> {
  const text = await readPrivateFile(relayProvisioningPath(options.homeDirectory), { maximumBytes: maximumRecordBytes })
  if (text === undefined) throw new Error("Relay identity is not provisioned. Restore its authentic public record before recovery.")
  const record = parseRecord(text)
  if (record.custody.kind === "file" && resolve(record.custody.path) === resolve(relayProvisioningPath(options.homeDirectory))) throw new Error("The relay secret cannot use its public record path")
  return record
}

function pendingMatches(secret: ChannelSecret, pin: RelayIdentityPin): RelaySuccessorStatement | undefined {
  const pending = secret.pending
  if (!pending) return undefined
  if (pending.machineId !== pin.machineId || pending.identityPublicKey !== pin.identityPublicKey) throw new Error("Prepared relay successor belongs to another identity")
  if (pending.generation === pin.generation && pending.channel.responderPublicKey === pin.channel.responderPublicKey) return undefined
  if (pending.generation !== pin.generation + 1 || pending.previousChannelPublicKey !== pin.channel.responderPublicKey
    || pending.channel.responderPublicKey === pin.channel.responderPublicKey
    || !encodedKeyForPin(secret, { ...pin, generation: pending.generation, channel: pending.channel })) throw new Error("Prepared relay successor does not match the saved pin")
  return pending
}

// Stop the daemon first. The lease spans every awaited custody operation and
// is released only when it settles; signing happens elsewhere, between calls.
export async function prepareRelayProfileSuccessor(options: RelayProfileRecoveryOptions, dependencies = relayProvisioningDependencies): Promise<RelaySuccessorStatement> {
  const lease = claimProfile(options.homeDirectory)
  try {
    const record = await recoveryRecord(options)
    if (record.identity.generation === Number.MAX_SAFE_INTEGER) throw new Error("Relay identity generation is exhausted")
    const store = await openCustody(options.homeDirectory, record.identity.machineId, record.custody.kind === "file" ? record.custody.path : undefined, options.warn, dependencies)
    const stored = await store.read()
    const secret = stored === undefined ? undefined : parseSecret(stored)
    const currentKey = secret && encodedKeyForPin(secret, record.identity)
    const pending = secret && pendingMatches(secret, record.identity)
    if (pending) {
      // A prior rename may have become visible without completing its flush.
      await store.publish(stored!)
      return pending
    }
    if (secret && !currentKey) throw new Error("Relay channel credential does not match the pinned public key")
    if (secret?.pending) await dependencies.publishRecord(relayProvisioningPath(options.homeDirectory), JSON.stringify(record) + "\n", { maximumBytes: maximumRecordBytes })
    const key = dependencies.generateKey()
    try {
      if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error("Invalid generated relay channel key")
      const statement = relaySuccessorStatementSchema.parse({
        version: 1, machineId: record.identity.machineId, identityPublicKey: record.identity.identityPublicKey,
        generation: record.identity.generation + 1, previousChannelPublicKey: record.identity.channel.responderPublicKey,
        channel: { ...record.identity.channel, responderPublicKey: relayPublicKeyFromPrivateKey(key) },
      })
      if (statement.channel.responderPublicKey === record.identity.channel.responderPublicKey) throw new Error("Generated relay successor repeats the current key")
      await store.publish(JSON.stringify({
        version: 2, machineId: record.identity.machineId, identityPublicKey: record.identity.identityPublicKey,
        keys: [...(currentKey ? [currentKey] : []), Buffer.from(key).toString("base64url")], pending: statement,
      }))
      return statement
    } finally { if (key instanceof Uint8Array) key.fill(0) }
  } finally { lease.release() }
}

export async function adoptRelayProfileSuccessor(options: RelayProfileRecoveryOptions, envelope: unknown, dependencies = relayProvisioningDependencies): Promise<RelayIdentityPin> {
  const lease = claimProfile(options.homeDirectory)
  try {
    const record = await recoveryRecord(options)
    const signed = relaySignedSuccessorSchema.parse(envelope)
    const alreadyAdopted = record.successor !== undefined && JSON.stringify(record.successor) === JSON.stringify(signed)
    const identity = alreadyAdopted ? record.identity : verifyRelayChannelSuccessor(record.identity, signed)
    const store = await openCustody(options.homeDirectory, record.identity.machineId, record.custody.kind === "file" ? record.custody.path : undefined, options.warn, dependencies)
    const stored = await store.read()
    const secret = stored === undefined ? undefined : parseSecret(stored)
    const encoded = secret && encodedKeyForPin(secret, identity)
    if (!secret || !encoded) throw new Error("The signed relay successor has no prepared key in this profile")
    if (alreadyAdopted) {
      // Retrying an acknowledged adoption must not erase a later preparation.
      if (!pendingMatches(secret, identity)) {
        await dependencies.publishRecord(relayProvisioningPath(options.homeDirectory), JSON.stringify(record) + "\n", { maximumBytes: maximumRecordBytes })
        await store.publish(activeSecret(identity, encoded))
      }
      return identity
    }
    if (JSON.stringify(pendingMatches(secret, record.identity)) !== JSON.stringify(signed.statement)) throw new Error("The signed relay successor does not match the prepared key")
    // Preserve both keys until the public pin commits. If publication throws
    // after rename, startup follows the new pin and completes key retirement.
    await store.publish(stored!)
    await dependencies.publishRecord(relayProvisioningPath(options.homeDirectory), JSON.stringify({ ...record, identity, successor: signed }) + "\n", { maximumBytes: maximumRecordBytes })
    try { await store.publish(activeSecret(identity, encoded)) }
    catch (cause) { throw new Error("Relay successor was adopted, but retired-key cleanup failed. Retry adoption before starting the daemon.", { cause }) }
    return identity
  } finally { lease.release() }
}
