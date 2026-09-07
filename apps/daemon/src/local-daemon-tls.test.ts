import { randomUUID } from "node:crypto"
import { chmod, copyFile, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { acquireLocalDaemon, type LocalDaemonHandle } from "./local-daemon.js"
import { readLocalOwnerRecord, writeLocalOwnerRecord } from "./local-owner-record.js"
import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"
import { createProductionDaemon, type ProductionDaemonHandle } from "./production-daemon.js"
import { CliProviderProbe } from "./providers.js"
import { removeScratchDirectory } from "./test-scratch.js"

// This boundary proof must also run on hosts without external certificate tools.
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>()
  return {
    ...original,
    execFile(...args: Parameters<typeof original.execFile>) {
      if (args[0] === "openssl") throw Object.assign(new Error("OpenSSL is unavailable in this test"), { code: "ENOENT" })
      return original.execFile(...args)
    },
  }
})

const budget = process.platform === "win32" ? 20_000 : 5_000
beforeEach(() => { vi.spyOn(CliProviderProbe.prototype, "inspect").mockResolvedValue([]) })
afterEach(() => vi.restoreAllMocks())

it.each([
  { certificate: "localhost-cert.pem", advertiseHost: "localhost", attached: true },
  { certificate: "localhost-cert.pem", advertiseHost: "127.0.0.1", attached: false },
  { certificate: "localhost-chain.pem", advertiseHost: "localhost", attached: true },
  { certificate: "localhost-chain.pem", advertiseHost: "127.0.0.1", attached: false },
  { certificate: "expired-chain.pem", advertiseHost: "localhost", attached: false },
  { certificate: "localhost-chain.pem", advertiseHost: "localhost", attached: false, wrongTrust: true },
  { certificate: "localhost-chain.pem", advertiseHost: "localhost", attached: false, wrongProof: true },
])("discovers $certificate at $advertiseHost only with valid TLS and owner proof (attached: $attached, wrong trust: $wrongTrust, wrong proof: $wrongProof)", async ({ certificate, advertiseHost, attached, wrongTrust, wrongProof }) => {
  const deadline = OperationDeadline.start(budget)
  const homeDirectory = await beforeDeadline(mkdtemp(join(tmpdir(), "domovoi-owner-tls-")), deadline)
  let owner: ProductionDaemonHandle | undefined
  let attachment: LocalDaemonHandle | undefined
  try {
    const certPath = join(homeDirectory, "cert.pem")
    const keyPath = join(homeDirectory, "key.pem")
    await beforeDeadline(Promise.all([
      copyFile(new URL(`../test-fixtures/local-owner-tls/${certificate}`, import.meta.url), certPath),
      copyFile(new URL("../test-fixtures/local-owner-tls/localhost-key.pem", import.meta.url), keyPath),
    ]), deadline)
    await beforeDeadline(chmod(keyPath, 0o600), deadline)
    owner = await beforeDeadline(createProductionDaemon({ homeDirectory, environment: {
      DOMOVOI_PORT: "0", DOMOVOI_TLS_CERT_PATH: certPath, DOMOVOI_TLS_KEY_PATH: keyPath,
      DOMOVOI_ADVERTISE_HOST: advertiseHost,
    } }), deadline)
    const endpoint = await beforeDeadline(owner.start(), deadline)
    const advertised = new URL(endpoint.url)
    expect(advertised.protocol).toBe("wss:")
    expect(endpoint.port).toBeGreaterThan(0)
    expect(advertised.port).toBe(String(endpoint.port))
    expect(readLocalOwnerRecord(homeDirectory)).toMatchObject({ state: "ready", owner: "daemon", url: endpoint.url })
    if (wrongTrust) {
      const record = readLocalOwnerRecord(homeDirectory)
      if (record?.state !== "ready") throw new Error("Owner did not publish a ready record")
      const unrelatedCertPath = join(homeDirectory, "unrelated-cert.pem")
      await beforeDeadline(copyFile(new URL("../test-fixtures/local-owner-tls/localhost-cert.pem", import.meta.url), unrelatedCertPath), deadline)
      writeLocalOwnerRecord(homeDirectory, { ...record, certificatePath: unrelatedCertPath })
    }
    if (wrongProof) {
      const record = readLocalOwnerRecord(homeDirectory)
      if (record?.state !== "ready") throw new Error("Owner did not publish a ready record")
      // TLS succeeds, but this listener cannot prove the advertised instance.
      writeLocalOwnerRecord(homeDirectory, { ...record, instanceId: randomUUID() })
    }
    attachment = await acquireLocalDaemon({ homeDirectory, environment: {}, mode: "attach-only", timeoutMs: deadline.remainingMs() })
    if (attached) expect(attachment).toMatchObject({ kind: "attached", endpoint: { url: endpoint.url, token: owner.authToken } })
    else expect(attachment).toMatchObject({ kind: "refused", reason: wrongProof ? "owner-unverified" : "owner-unreachable" })
  } finally {
    if (attachment?.kind === "attached") attachment.detach()
    deadline.clear()
    const closing = OperationDeadline.start(budget)
    try {
      if (owner) await beforeDeadline(owner.stop(), closing)
    } finally { closing.clear() }
    // Removal never shares the budget the stop may have spent, and it retries
    // a home the stopping daemon still holds.
    await removeScratchDirectory(homeDirectory)
  }
}, budget * 2 + 1_000)
