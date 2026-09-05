import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { on, once } from "node:events"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { protocolVersion } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"
import { WebSocket } from "ws"

import { OperationDeadline } from "../operation-deadline.js"
import { waitForDaemon } from "../test-wait-for.js"
import { parseServiceConfiguration, serviceConfigurationPath } from "./configuration.js"
import { withinServiceDeadline } from "./deadline.js"

const cliPath = fileURLToPath(new URL("../../dist/index.js", import.meta.url))
const managerShim = fileURLToPath(new URL("../../test-fixtures/service-manager.mjs", import.meta.url))
const run = promisify(execFile)
const budget = process.platform === "win32" ? 30_000 : 15_000
// A real process also drains provider probes on shutdown. That is not the
// idle observation budget used by waitForDaemon, and remains bounded here.
const cleanupBudget = 10_000

async function unusedPort(deadline: OperationDeadline): Promise<number> {
  deadline.throwIfExpired()
  const server = createServer()
  try {
    server.listen({ host: "127.0.0.1", port: 0, signal: deadline.signal })
    await once(server, "listening", { signal: deadline.signal })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("No test listener")
    return address.port
  } finally {
    if (server.listening) await withinServiceDeadline(deadline, () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  }
}

describe("distributed service CLI", () => {
  it("installs saved settings and serves them with a changed supervisor environment", async () => {
    const deadline = OperationDeadline.start(budget)
    const within = <T>(operation: () => Promise<T>) => withinServiceDeadline(deadline, operation)
    const home = await within(() => mkdtemp(join(tmpdir(), "domovoi-service-home-")))
    let child: ReturnType<typeof spawn> | undefined
    let exited: Promise<unknown> | undefined
    let socket: WebSocket | undefined
    try {
      const port = await unusedPort(deadline)
      const certPath = join(home, "cert.pem")
      const keyPath = join(home, "private.key")
      await within(() => run("openssl", [
        "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
        "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost",
      ], { signal: deadline.signal, timeout: Math.ceil(deadline.remainingMs()) }))
      await within(() => chmod(keyPath, 0o600))
      const token = createHash("sha256").update("service-cli-file-credential").digest("base64url")
      const credentialPath = join(home, "saved.token")
      await within(() => writeFile(credentialPath, token, { mode: 0o600 }))
      const identityPath = join(home, "saved-machine.json")
      const managerLog = join(home, "manager.jsonl")
      const environment = {
        ...process.env,
        HOME: home, USERPROFILE: home, NODE_NO_WARNINGS: "1",
        DOMOVOI_TEST_MANAGER_LOG: managerLog,
        DOMOVOI_HOST: "127.0.0.1", DOMOVOI_PORT: String(port),
        DOMOVOI_AUTH_TOKEN: undefined,
        DOMOVOI_TLS_CERT_PATH: certPath, DOMOVOI_TLS_KEY_PATH: keyPath,
        DOMOVOI_CREDENTIAL_PATH: credentialPath, DOMOVOI_MACHINE_IDENTITY_PATH: identityPath,
        DOMOVOI_ALLOWED_ORIGINS: "https://service.example.com",
        DOMOVOI_ADVERTISE_HOST: "localhost", DOMOVOI_ALLOW_REMOTE_TRANSPORT: "0",
      }
      await within(() => run(process.execPath, ["--import", managerShim, cliPath, "service", "install"], {
        env: environment, signal: deadline.signal, timeout: Math.ceil(deadline.remainingMs()),
      }))
      const configPath = serviceConfigurationPath(home, process.platform)
      const saved = parseServiceConfiguration(await within(() => readFile(configPath, "utf8")))
      expect(saved).toMatchObject({ port, tls: { certPath, keyPath }, credentialPath, machineIdentityPath: identityPath })
      expect(JSON.stringify(saved)).not.toContain(token)
      if (process.platform !== "win32") expect((await within(() => stat(configPath))).mode & 0o777).toBe(0o600)
      await expect(within(() => stat(identityPath))).rejects.toMatchObject({ code: "ENOENT" })
      await expect(within(() => stat(join(home, ".domovoi", "daemon.token")))).rejects.toMatchObject({ code: "ENOENT" })
      const commands = (await within(() => readFile(managerLog, "utf8"))).trim().split("\n")
        .map((line) => JSON.parse(line) as { command: string; args: string[] })
      const launch = process.platform === "win32"
        ? commands[0]!.args[commands[0]!.args.indexOf("/tr") + 1]!
        : await within(() => readFile(process.platform === "darwin"
          ? join(home, "Library", "LaunchAgents", "sh.domovoi.domovoid.plist")
          : join(home, ".config", "systemd", "user", "domovoid.service"), "utf8"))
      expect(launch).toContain(cliPath)
      expect(launch).toContain(process.execPath)
      expect(launch).toContain("--service-config")
      expect(launch).toContain(configPath)

      // The manager has a different environment after reboot. It must not
      // override the saved listener, file credential, identity, or origins.
      child = spawn(process.execPath, [cliPath, "--service-config", configPath], {
        env: { ...environment, DOMOVOI_PORT: "invalid", DOMOVOI_AUTH_TOKEN: "invalid", DOMOVOI_TLS_KEY_PATH: "missing" },
        signal: deadline.signal, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"],
      })
      exited = once(child, "exit")
      void exited.catch(() => {})
      let stdout = ""
      let stderr = ""
      child.stdout!.on("data", (bytes: Buffer) => { stdout += bytes.toString() })
      child.stderr!.on("data", (bytes: Buffer) => { stderr += bytes.toString() })
      await within(() => waitForDaemon(() => {
        expect(stderr).not.toContain("Error:")
        expect(stdout).toContain(`domovoid listening on wss://localhost:${port}/rpc`)
      }))
      deadline.throwIfExpired()
      socket = new WebSocket(`wss://127.0.0.1:${port}/rpc`, {
        rejectUnauthorized: false, origin: "https://service.example.com",
        headers: { authorization: `Bearer ${token}` },
      })
      await once(socket, "open", { signal: deadline.signal })
      const messages = on(socket, "message", { signal: deadline.signal })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "system.hello", params: { client: "cli", clientVersion: "service-test", protocolVersion } }))
      for await (const [bytes] of messages) {
        const response = JSON.parse(String(bytes)) as { id?: number; error?: unknown; result?: unknown }
        if (response.id !== 1) continue
        expect(response.error).toBeUndefined()
        const identity = JSON.parse(await within(() => readFile(identityPath, "utf8"))) as { id: string }
        expect(response.result).toMatchObject({ machine: { id: identity.id } })
        break
      }
      expect(await within(() => readFile(credentialPath, "utf8"))).toBe(token)
      expect(JSON.parse(await within(() => readFile(identityPath, "utf8")))).toHaveProperty("id")
    } finally {
      socket?.terminate()
      child?.kill("SIGTERM")
      deadline.clear()
      const cleanup = OperationDeadline.start(cleanupBudget)
      try {
        if (exited) await withinServiceDeadline(cleanup, () => exited!)
        await withinServiceDeadline(cleanup, () => rm(home, { recursive: true, force: true }))
      } finally {
        cleanup.clear()
      }
    }
  }, budget + cleanupBudget + 1_000)
})
