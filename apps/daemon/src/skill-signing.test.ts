import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  addTrustedSkillKey,
  exportSkillPublicKey,
  generateSkillSigningKey,
  importSkillPublicKey,
  loadTrustedSkillKeys,
  signSkillDigest,
  skillContentDigest,
  skillKeyId,
  skillTrustPath,
  verifySkillSignature,
} from "./skill-signing.js"
import { removeScratchDirectories } from "./test-scratch.js"

const scratchDirectories: string[] = []

afterEach(async () => {
  await removeScratchDirectories(scratchDirectories.splice(0))
})

async function scratchTrustPath(): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "domovoi-skill-trust-"))
  scratchDirectories.push(scratch)
  return join(scratch, ".domovoi", "skill-trusted-keys.json")
}

describe("skill signatures", () => {
  it("signs the content digest and verifies only with the signing key", () => {
    const signer = generateSkillSigningKey()
    const other = generateSkillSigningKey()
    const contentDigest = skillContentDigest("---\nname: plain\n---\n")
    const value = signSkillDigest(contentDigest, signer.privateKey)

    expect(value).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    expect(verifySkillSignature(contentDigest, value, signer.publicKey)).toBe(true)
    expect(verifySkillSignature(contentDigest, value, other.publicKey)).toBe(false)
    expect(verifySkillSignature(skillContentDigest("changed"), value, signer.publicKey)).toBe(false)
    expect(verifySkillSignature(contentDigest, "bm90IGEgc2lnbmF0dXJl", signer.publicKey)).toBe(false)
  })

  it("derives the key id from the public key and round-trips the encoding", () => {
    const { publicKey } = generateSkillSigningKey()
    const encoded = exportSkillPublicKey(publicKey)

    expect(skillKeyId(publicKey)).toMatch(/^ed25519:[a-f0-9]{16}$/)
    expect(skillKeyId(importSkillPublicKey(encoded))).toBe(skillKeyId(publicKey))
    expect(() => importSkillPublicKey("not a key")).toThrow("public key")
  })

  it("places the trust file under the daemon state directory", () => {
    expect(skillTrustPath("/home/dev")).toBe(join("/home/dev", ".domovoi", "skill-trusted-keys.json"))
  })
})

describe("trusted skill keys", () => {
  it("treats an absent trust file as no trusted keys without creating it", async () => {
    const path = await scratchTrustPath()

    const trust = await loadTrustedSkillKeys(path)

    expect(trust.keys.size).toBe(0)
    expect(trust.path).toBe(path)
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("creates the trust file owner-only and records each key once", async () => {
    const path = await scratchTrustPath()
    const { publicKey } = generateSkillSigningKey()
    const encoded = exportSkillPublicKey(publicKey)

    await expect(addTrustedSkillKey(path, encoded)).resolves.toEqual({
      keyId: skillKeyId(publicKey),
      added: true,
    })
    await expect(addTrustedSkillKey(path, encoded)).resolves.toEqual({
      keyId: skillKeyId(publicKey),
      added: false,
    })

    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      keys: [{ algorithm: "ed25519", keyId: skillKeyId(publicKey), publicKey: encoded }],
    })
    const trust = await loadTrustedSkillKeys(path)
    expect([...trust.keys.keys()]).toEqual([skillKeyId(publicKey)])
    expect(trust.loadedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it.skipIf(process.platform === "win32")("refuses a trust file other users can read", async () => {
    const path = await scratchTrustPath()
    const encoded = exportSkillPublicKey(generateSkillSigningKey().publicKey)
    await addTrustedSkillKey(path, encoded)

    for (const mode of [0o640, 0o604, 0o644]) {
      await chmod(path, mode)
      await expect(loadTrustedSkillKeys(path))
        .rejects.toThrow("Skill trust file must not be readable by other users")
      await expect(addTrustedSkillKey(path, encoded))
        .rejects.toThrow("Skill trust file must not be readable by other users")
    }
  })

  it("refuses a malformed trust file and a key id that does not match its key", async () => {
    const path = await scratchTrustPath()
    const { publicKey } = generateSkillSigningKey()
    await addTrustedSkillKey(path, exportSkillPublicKey(publicKey))
    const record = JSON.parse(await readFile(path, "utf8")) as { keys: { keyId: string }[] }
    record.keys[0]!.keyId = "ed25519:0000000000000000"
    await writeFile(path, JSON.stringify(record))

    await expect(loadTrustedSkillKeys(path)).rejects.toThrow("Skill trust file is malformed")

    await writeFile(path, "not json")
    await expect(loadTrustedSkillKeys(path)).rejects.toThrow("Skill trust file is malformed")
    await expect(addTrustedSkillKey(path, exportSkillPublicKey(publicKey)))
      .rejects.toThrow("Skill trust file is malformed")
  })
})
