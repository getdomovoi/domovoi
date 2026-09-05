import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { acquireLocalDaemon, type LocalDaemonHandle } from "./local-daemon.js"
import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"
import { createProductionDaemon, type ProductionDaemonHandle } from "./production-daemon.js"
import { CliProviderProbe } from "./providers.js"

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

it.each(["localhost", "127.0.0.1"])("keeps TLS certificate and hostname checks when discovering %s", async (advertiseHost) => {
  const deadline = OperationDeadline.start(budget)
  const homeDirectory = await beforeDeadline(mkdtemp(join(tmpdir(), "domovoi-owner-tls-")), deadline)
  let owner: ProductionDaemonHandle | undefined
  let attachment: LocalDaemonHandle | undefined
  try {
    const certPath = join(homeDirectory, "cert.pem")
    const keyPath = join(homeDirectory, "key.pem")
    await beforeDeadline(Promise.all([
      copyFile(new URL("../test-fixtures/local-owner-tls/localhost-cert.pem", import.meta.url), certPath),
      copyFile(new URL("../test-fixtures/local-owner-tls/localhost-key.pem", import.meta.url), keyPath),
    ]), deadline)
    await beforeDeadline(chmod(keyPath, 0o600), deadline)
    owner = await beforeDeadline(createProductionDaemon({ homeDirectory, environment: {
      DOMOVOI_PORT: "0", DOMOVOI_TLS_CERT_PATH: certPath, DOMOVOI_TLS_KEY_PATH: keyPath,
      DOMOVOI_ADVERTISE_HOST: advertiseHost,
    } }), deadline)
    const endpoint = await beforeDeadline(owner.start(), deadline)
    attachment = await acquireLocalDaemon({ homeDirectory, environment: {}, mode: "attach-only", timeoutMs: deadline.remainingMs() })
    if (advertiseHost === "localhost") expect(attachment).toMatchObject({ kind: "attached", endpoint: { url: endpoint.url, token: owner.authToken } })
    else expect(attachment.kind).toBe("refused")
  } finally {
    if (attachment?.kind === "attached") attachment.detach()
    deadline.clear()
    const closing = OperationDeadline.start(budget)
    try {
      if (owner) await beforeDeadline(owner.stop(), closing)
      await beforeDeadline(rm(homeDirectory, { recursive: true, force: true }), closing)
    } finally { closing.clear() }
  }
}, budget * 2 + 1_000)
