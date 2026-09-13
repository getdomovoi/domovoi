import { createHash, randomBytes } from "node:crypto"
import { isAbsolute, join, resolve } from "node:path"

import { nativeKeyring, openCredentialBackend, readPrivateFile, writePrivateFile, type Keyring } from "@getdomovoi/credential-store"
import { machineIdSchema, relayBytes32Schema, relayIdentityPinSchema, relayPublicKeySchema, type RelayIdentityPin } from "@getdomovoi/protocol"
import { relayIdentityPublicKeyIsValid, relayPublicKeyFromPrivateKey, verifyRelayChannelSuccessor } from "@getdomovoi/protocol/relay-admission"
import { z } from "zod"

import type { OperationDeadline } from "./operation-deadline.js"

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
}).strict()
const secretSchema = z.object({
  version: z.literal(1), machineId: machineIdSchema,
  identityPublicKey: relayPublicKeySchema, privateKey: relayBytes32Schema,
}).strict()

export type ProvisionedRelayChannel = { privateKey: Uint8Array; identity: RelayIdentityPin }
type Options = {
  homeDirectory: string
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

export const relayProvisioningPath = (homeDirectory: string) => join(homeDirectory, ".domovoi", "relay-identity.json")
const fileWarning = (path: string) => `The relay channel key is kept in ${path}, not in an OS keychain. The file is mode 0600 and holds the X25519 private key. Anyone who can read it can impersonate this daemon until paired clients accept an identity-signed successor. The identity private key must be kept off this machine.`
const unavailable = (cause?: Error) => (cause
  ? `The OS keychain did not answer (${cause.message}), so this daemon's relay channel key cannot be kept there. Unlock it and run this again, or`
  : "No OS keychain is available here, so there is nowhere safe to keep this daemon's relay channel key.")
  + " Set DOMOVOI_RELAY_CREDENTIAL_FILE to an explicit path to keep it in a file you own (mode 0600), and treat that file as the daemon identity it can impersonate."

function parseRecord(text: string) {
  try {
    const record = recordSchema.parse(JSON.parse(text))
    if (!relayIdentityPublicKeyIsValid(record.identity.identityPublicKey)) throw new Error("identity")
    return record
  } catch { throw new Error("Invalid relay provisioning record. Restore its public record; no key was replaced.") }
}

function parseSecret(text: string) {
  try {
    if (Buffer.byteLength(text, "utf8") > maximumCredentialBytes) throw new Error("oversized")
    return secretSchema.parse(JSON.parse(text))
  } catch { throw new Error("Invalid relay channel credential. No key was replaced.") }
}

// Read-only verification still works after the warm credential is lost. It
// neither adopts the successor nor proves that a recipient persisted its pin.
export async function verifyRelayProfileSuccessor(homeDirectory: string, envelope: unknown): Promise<RelayIdentityPin> {
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
  const store = await openCredentialBackend({
    keyring: dependencies.keyring, ...(credentialFile !== undefined ? { credentialFile } : {}),
    warn: options.warn, fileWarning, unavailable, maximumBytes: maximumCredentialBytes,
  })
  check()
  const account = createHash("sha256").update("domovoi.relay-profile.v1\0").update(resolve(options.homeDirectory)).update("\0").update(options.machineId).digest("hex")
  const read = () => store.where === "file" ? store.read() : store.keyring.get(account)
  const write = (value: string) => store.where === "file" ? store.write(value) : store.keyring.set(account, value)
  let stored = await read()
  check()
  if (stored === undefined && record) throw new Error("The provisioned relay channel key is missing. Restore its credential; automatic replacement is refused.")
  // A recovered file may be visible after a rename whose directory flush
  // failed. Republish the same bytes before committing their first public pin.
  const needsPublication = stored === undefined || (!record && store.where === "file")
  let privateKey: Uint8Array | undefined
  try {
    if (stored === undefined) {
      privateKey = dependencies.generateKey()
      if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) throw new Error("Invalid generated relay channel key")
      stored = JSON.stringify({ version: 1, machineId: options.machineId, identityPublicKey, privateKey: Buffer.from(privateKey).toString("base64url") })
    } else {
      const secret = parseSecret(stored)
      if (secret.machineId !== options.machineId || secret.identityPublicKey !== identityPublicKey) throw new Error("Relay channel credential does not match this machine and identity anchor")
      privateKey = Buffer.from(secret.privateKey, "base64url")
    }
    if (needsPublication) {
      check()
      await write(stored)
      check()
      if (await read() !== stored) throw new Error("Relay channel credential read-back did not match. The public anchor was not published.")
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
        custody: store.where === "file" ? { kind: "file", path: store.path } : { kind: "keyring" },
      }) + "\n", { maximumBytes: maximumRecordBytes })
    }
    check()
    return { privateKey: new Uint8Array(privateKey), identity }
  } finally { privateKey?.fill(0) }
}
