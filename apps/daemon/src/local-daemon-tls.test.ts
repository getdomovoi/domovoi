import { execFile } from "node:child_process"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { acquireLocalDaemon, type LocalDaemonHandle } from "./local-daemon.js"
import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"
import { createProductionDaemon, type ProductionDaemonHandle } from "./production-daemon.js"
import { CliProviderProbe } from "./providers.js"

const run = promisify(execFile)
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
    await beforeDeadline(run("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost",
    ], { signal: deadline.signal, timeout: Math.ceil(deadline.remainingMs()) }), deadline)
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
