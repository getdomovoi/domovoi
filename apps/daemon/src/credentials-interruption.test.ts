import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { expect, it, vi } from "vitest"

import { MachineCredentialStore } from "./machine-credentials.js"
import { OperationDeadline } from "./operation-deadline.js"
import { createProductionDaemonWithDependencies, productionDaemonDependencies, type ProductionDaemonHandle } from "./production-daemon.js"
import { withinServiceDeadline } from "./service/deadline.js"
import { asyncTestCredentials } from "./test-machine-credentials.js"

for (const file of ["daemon.token", "local-owner.key"]) {
  it(`starts a real daemon after a killed first writer of ${file}`, async () => {
    const deadline = OperationDeadline.start(40_000)
    let home: string | undefined
    let child: ReturnType<typeof spawn> | undefined
    let exited: Promise<unknown> | undefined
    let daemon: ProductionDaemonHandle | undefined
    try {
      home = await withinServiceDeadline(deadline, () => mkdtemp(join(tmpdir(), "domovoi-token-crash-")))
      const path = join(home, ".domovoi", file)
      deadline.throwIfExpired()
      child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"),
        fileURLToPath(new URL("../test-fixtures/interrupted-credential.mjs", import.meta.url)), path], {
        stdio: ["ignore", "pipe", "pipe"], signal: deadline.signal, killSignal: "SIGKILL",
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      })
      exited = once(child, "exit")
      void exited.catch(() => {})
      let stdout = ""
      let stderr = ""
      child.stdout!.on("data", (bytes: Buffer) => { stdout += bytes.toString() })
      child.stderr!.on("data", (bytes: Buffer) => { stderr += bytes.toString() })
      await withinServiceDeadline(deadline, () => vi.waitFor(() => {
        expect(child!.exitCode, stderr).toBeNull()
        expect(stdout).toContain("DOMOVOI_CREDENTIAL_WRITE_HELD\n")
      }, { timeout: 10_000 }))
      expect(child.kill("SIGKILL")).toBe(true)
      await withinServiceDeadline(deadline, () => exited!)
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" })
      // Native keychain boundary only. Token loading, profile ownership,
      // persistence and listener construction are the production assembly.
      daemon = await withinServiceDeadline(deadline, () => createProductionDaemonWithDependencies({
        homeDirectory: home!, environment: { DOMOVOI_PORT: "0" },
      }, {
        ...productionDaemonDependencies,
        createProviderProbe: () => ({ inspect: async () => [] }),
        createMachineCredentials: () => asyncTestCredentials(new MachineCredentialStore({
          get: () => undefined, set: () => {}, delete: () => {},
        })),
      }))
      const address = await withinServiceDeadline(deadline, () => daemon!.start())
      expect(address.port).toBeGreaterThan(0)
      expect(daemon.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect((await readFile(path, "utf8")).trim()).toMatch(/^[A-Za-z0-9_-]{43}$/)
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      deadline.clear()
      const cleanup = OperationDeadline.start(10_000)
      try {
        if (exited) await withinServiceDeadline(cleanup, () => exited!)
        if (daemon) await withinServiceDeadline(cleanup, () => daemon!.stop())
        if (home) await withinServiceDeadline(cleanup, () => rm(home!, { recursive: true, force: true }))
      } finally { cleanup.clear() }
    }
  }, 51_000)
}
