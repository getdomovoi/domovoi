import { execFileSync } from "node:child_process"
import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { removeScratchDirectories } from "./test-scratch.js"
import { loadTlsMaterial } from "./tls-material.js"

const scratchDirectories: string[] = []

afterEach(async () => {
  await removeScratchDirectories(scratchDirectories.splice(0))
})

function opensslAvailable(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

async function selfSignedMaterial(): Promise<{ certPath: string; keyPath: string }> {
  const scratch = await mkdtemp(join(tmpdir(), "domovoi-tls-"))
  scratchDirectories.push(scratch)
  const certPath = join(scratch, "cert.pem")
  const keyPath = join(scratch, "key.pem")
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath,
    "-days", "1", "-subj", "/CN=localhost",
  ], { stdio: "ignore" })
  await chmod(keyPath, 0o600)
  return { certPath, keyPath }
}

describe.skipIf(!opensslAvailable())("loadTlsMaterial", () => {
  it("reads a certificate and its private key", async () => {
    const { certPath, keyPath } = await selfSignedMaterial()

    const material = await loadTlsMaterial({ certPath, keyPath })

    expect(material.cert.toString()).toContain("BEGIN CERTIFICATE")
    expect(material.key.toString()).toContain("PRIVATE KEY")
  })

  it.skipIf(process.platform === "win32")("refuses a private key others can read", async () => {
    const { certPath, keyPath } = await selfSignedMaterial()
    await chmod(keyPath, 0o644)

    await expect(loadTlsMaterial({ certPath, keyPath }))
      .rejects.toThrow("TLS private key must not be readable by other users")
  })

  it.skipIf(process.platform === "win32")("refuses a private key the group can read", async () => {
    const { certPath, keyPath } = await selfSignedMaterial()
    await chmod(keyPath, 0o640)

    await expect(loadTlsMaterial({ certPath, keyPath }))
      .rejects.toThrow("TLS private key must not be readable by other users")
  })

  it("names the file it could not read", async () => {
    const { certPath } = await selfSignedMaterial()
    const missing = join(tmpdir(), "domovoi-tls-missing-key.pem")

    await expect(loadTlsMaterial({ certPath, keyPath: missing }))
      .rejects.toThrow(missing)
  })

  it("refuses a certificate file that holds no certificate", async () => {
    const { keyPath } = await selfSignedMaterial()
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-tls-"))
    scratchDirectories.push(scratch)
    const certPath = join(scratch, "cert.pem")
    await writeFile(certPath, "not a certificate\n")

    await expect(loadTlsMaterial({ certPath, keyPath }))
      .rejects.toThrow("TLS certificate is not PEM encoded")
  })

  it("never puts key bytes in an error", async () => {
    const { certPath, keyPath } = await selfSignedMaterial()
    await chmod(keyPath, 0o644)

    const failure = await loadTlsMaterial({ certPath, keyPath }).catch((error: Error) => error)

    expect(String(failure)).not.toContain("PRIVATE KEY")
  })
})
