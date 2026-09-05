import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto"
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"

import { skillDeclaredSignatureSchema } from "@getdomovoi/protocol"
import { z } from "zod"

export const skillSignatureVersion = 1
export const skillTrustFileName = "skill-trusted-keys.json"
const maxTrustFileBytes = 64 * 1_024
const maxTrustedKeys = 64
const rawPublicKeyBytes = 32
const keyIdHexLength = 16

const encodedPublicKeySchema = z.string().regex(/^[A-Za-z0-9+/]{43}=$/)

const trustedSkillKeySchema = z.object({
  algorithm: z.literal("ed25519"),
  keyId: skillDeclaredSignatureSchema.shape.keyId,
  publicKey: encodedPublicKeySchema,
}).strict()

const trustedSkillKeysFileSchema = z.object({
  version: z.literal(1),
  keys: z.array(trustedSkillKeySchema).max(maxTrustedKeys),
}).strict()

type TrustedSkillKeysFile = z.infer<typeof trustedSkillKeysFileSchema>

export type TrustedSkillKeys = {
  path: string | undefined
  loadedAt: string
  keys: ReadonlyMap<string, KeyObject>
}

export class SkillTrustFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SkillTrustFileError"
  }
}

export function skillTrustPath(home: string): string {
  return join(home, ".domovoi", skillTrustFileName)
}

export function skillContentDigest(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`
}

export function skillSignatureMessage(contentDigest: string): Buffer {
  return Buffer.from(`domovoi-skill-signature-v${skillSignatureVersion}:${contentDigest}`, "utf8")
}

function rawPublicKey(publicKey: KeyObject): Buffer {
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Skill signing public key must be an Ed25519 key")
  }
  return Buffer.from(String(publicKey.export({ format: "jwk" }).x), "base64url")
}

export function skillKeyId(publicKey: KeyObject): string {
  const fingerprint = createHash("sha256").update(rawPublicKey(publicKey)).digest("hex")
  return `ed25519:${fingerprint.slice(0, keyIdHexLength)}`
}

export function exportSkillPublicKey(publicKey: KeyObject): string {
  return rawPublicKey(publicKey).toString("base64")
}

export function importSkillPublicKey(encoded: string): KeyObject {
  const raw = Buffer.from(encoded, "base64")
  if (!encodedPublicKeySchema.safeParse(encoded).success || raw.byteLength !== rawPublicKeyBytes) {
    throw new Error("Skill signing public key must be the base64 encoding of 32 Ed25519 key bytes")
  }
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  })
}

export function generateSkillSigningKey(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync("ed25519")
}

export function signSkillDigest(contentDigest: string, privateKey: KeyObject): string {
  return sign(null, skillSignatureMessage(contentDigest), privateKey).toString("base64")
}

export function verifySkillSignature(
  contentDigest: string,
  value: string,
  publicKey: KeyObject,
): boolean {
  try {
    return verify(null, skillSignatureMessage(contentDigest), publicKey, Buffer.from(value, "base64"))
  } catch {
    return false
  }
}

type ReadTrustFile = {
  record: TrustedSkillKeysFile
  keys: Map<string, KeyObject>
}

function malformedTrustFile(path: string): SkillTrustFileError {
  return new SkillTrustFileError(`Skill trust file is malformed: ${path}`)
}

async function readTrustFile(path: string): Promise<ReadTrustFile | undefined> {
  let file
  try {
    file = await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  if (!file.isFile() || file.size > maxTrustFileBytes) throw malformedTrustFile(path)
  if (process.platform !== "win32" && (file.mode & 0o077) !== 0) {
    throw new SkillTrustFileError(`Skill trust file must not be readable by other users: ${path}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, "utf8"))
  } catch {
    throw malformedTrustFile(path)
  }
  const record = trustedSkillKeysFileSchema.safeParse(parsed)
  if (!record.success) throw malformedTrustFile(path)
  const keys = new Map<string, KeyObject>()
  for (const entry of record.data.keys) {
    let publicKey: KeyObject
    try {
      publicKey = importSkillPublicKey(entry.publicKey)
    } catch {
      throw malformedTrustFile(path)
    }
    if (skillKeyId(publicKey) !== entry.keyId) throw malformedTrustFile(path)
    keys.set(entry.keyId, publicKey)
  }
  return { record: record.data, keys }
}

async function writeTrustFile(path: string, record: TrustedSkillKeysFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${randomBytes(8).toString("hex")}.tmp`
  try {
    const handle = await open(temporaryPath, "wx", 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

export async function loadTrustedSkillKeys(path: string): Promise<TrustedSkillKeys> {
  const loadedAt = new Date().toISOString()
  const file = await readTrustFile(path)
  return { path, loadedAt, keys: file?.keys ?? new Map() }
}

export async function addTrustedSkillKey(
  path: string,
  encodedPublicKey: string,
): Promise<{ keyId: string; added: boolean }> {
  const publicKey = importSkillPublicKey(encodedPublicKey)
  const keyId = skillKeyId(publicKey)
  const existing = await readTrustFile(path)
  if (existing?.keys.has(keyId)) return { keyId, added: false }
  await writeTrustFile(path, {
    version: 1,
    keys: [
      ...(existing?.record.keys ?? []),
      { algorithm: "ed25519", keyId, publicKey: exportSkillPublicKey(publicKey) },
    ],
  })
  return { keyId, added: true }
}
