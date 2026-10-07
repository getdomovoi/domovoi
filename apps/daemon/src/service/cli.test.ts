import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { on, once } from "node:events"
import { chmod, copyFile, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { protocolVersion } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"

import { OperationDeadline } from "../operation-deadline.js"
import { readLocalOwnerRecord } from "../local-owner-record.js"
import { waitForFixtureStartup } from "../test-wait-for.js"
import { parseServiceConfiguration, serviceConfigurationPath } from "./configuration.js"
import { withinServiceDeadline } from "./deadline.js"
import { removeScratchDirectory } from "../test-scratch.js"

const cliPath = fileURLToPath(new URL("../../dist/index.js", import.meta.url))
const managerShimSource = new URL("../../test-fixtures/service-manager.mjs", import.meta.url)
const run = promisify(execFile)
const budget = process.platform === "win32" ? 30_000 : 15_000
// A real process also drains provider probes on shutdown. That is not the
// idle observation budget used by waitForDaemon, and remains bounded here.
const cleanupBudget = 10_000
// A cleanup failure is reported here rather than thrown from the finally block
// that found it, so it never replaces the assertion that failed the test.
const cleanupFailures: unknown[] = []
afterEach(() => {
  const failures = cleanupFailures.splice(0)
  if (failures.length > 0) throw new AggregateError(failures, "Test cleanup failed")
})

describe("distributed service CLI", () => {
  it("installs saved settings and serves them with a changed supervisor environment", async () => {
    const deadline = OperationDeadline.start(budget)
    const within = <T>(operation: () => Promise<T>) => withinServiceDeadline(deadline, operation)
    const home = await within(() => mkdtemp(join(tmpdir(), "domovoi-service-home-")))
    let child: ReturnType<typeof spawn> | undefined
    let exited: Promise<unknown> | undefined
    let socket: WebSocket | undefined
    try {
      // A preload is an ESM specifier, not a filesystem argument. The reserved
      // character catches a bare-path regression on POSIX as well as Windows.
      const managerShimPath = join(home, "manager # shim.mjs")
      await within(() => copyFile(managerShimSource, managerShimPath))
      const managerShim = pathToFileURL(managerShimPath).href
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
        DOMOVOI_PROFILE_DIR: join(home, ".domovoi"),
        DOMOVOI_TEST_MANAGER_LOG: managerLog,
        DOMOVOI_HOST: "127.0.0.1", DOMOVOI_PORT: "0",
        DOMOVOI_AUTH_TOKEN: undefined,
        DOMOVOI_TLS_CERT_PATH: certPath, DOMOVOI_TLS_KEY_PATH: keyPath,
        DOMOVOI_CREDENTIAL_PATH: credentialPath, DOMOVOI_MACHINE_IDENTITY_PATH: identityPath,
        DOMOVOI_ALLOWED_ORIGINS: "https://service.example.com",
        DOMOVOI_ADVERTISE_HOST: "localhost", DOMOVOI_ALLOW_REMOTE_TRANSPORT: "0",
      }
      const configPath = serviceConfigurationPath(home, process.platform)
      await expect(within(() => run(process.execPath, ["--import", managerShim, cliPath, "service", "install"], {
        env: { ...environment, DOMOVOI_AUTH_TOKEN: "s".repeat(43) },
        signal: deadline.signal, timeout: Math.ceil(deadline.remainingMs()),
      }))).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Configure a private DOMOVOI_CREDENTIAL_PATH") })
      await expect(within(() => stat(configPath))).rejects.toMatchObject({ code: "ENOENT" })
      await expect(within(() => stat(managerLog))).rejects.toMatchObject({ code: "ENOENT" })
      await within(() => run(process.execPath, ["--import", managerShim, cliPath, "service", "install"], {
        env: environment, signal: deadline.signal, timeout: Math.ceil(deadline.remainingMs()),
      }))
      const saved = parseServiceConfiguration(await within(() => readFile(configPath, "utf8")))
      expect(saved).toMatchObject({ port: 0, tls: { certPath, keyPath }, credentialPath, machineIdentityPath: identityPath })
      expect(JSON.stringify(saved)).not.toContain(token)
      if (process.platform !== "win32") expect((await within(() => stat(configPath))).mode & 0o777).toBe(0o600)
      await expect(within(() => stat(identityPath))).rejects.toMatchObject({ code: "ENOENT" })
      await expect(within(() => stat(join(home, ".domovoi", "daemon.token")))).rejects.toMatchObject({ code: "ENOENT" })
      const commands = (await within(() => readFile(managerLog, "utf8"))).trim().split("\n")
        .map((line) => JSON.parse(line) as { command: string; args: string[] })
      // A Windows install first asks Task Scheduler whether a task of the same
      // name exists (security review round 3), so the launch command is the
      // /create call's, not the first manager call's.
      // schtasks is named by its path under SystemRoot (review F3).
      const create = commands.find(({ command, args }) => command.endsWith("\\System32\\schtasks.exe") && args[0] === "/create")
      const launch = process.platform === "win32"
        ? create!.args[create!.args.indexOf("/tr") + 1]!
        : await within(() => readFile(process.platform === "darwin"
          ? join(home, "Library", "LaunchAgents", "sh.domovoi.domovoid.plist")
          : join(home, ".config", "systemd", "user", "domovoid.service"), "utf8"))
      expect(launch).toContain(cliPath)
      expect(launch).toContain(process.execPath)
      expect(launch).toContain(process.platform === "win32" ? "--service-supervise" : "--service-config")
      expect(launch).toContain(configPath)
      // Decided 2026-09-17 (SHIP-PLAN S1.1): the Linux install turned the
      // shim's lingering on and recorded it. The shim answers loginctl.
      if (process.platform === "linux") {
        expect(commands).toContainEqual({ command: "loginctl", args: ["enable-linger", String(userInfo().uid)] })
        expect(saved.lingerEnabledByDomovoi).toBe(true)
      } else {
        expect(commands.some(({ command }) => command === "loginctl")).toBe(false)
      }

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
      // The hostile values above are refused by name when read, and the daemon
      // then exits. Either one ends the wait at once with what it printed. Any
      // other logged error is not a startup failure: the daemon handles and
      // retries some (a lifecycle write the OS refused, say), so readiness is
      // the only thing waited for.
      const hostileSetting = /\bDOMOVOI_(?:PORT|AUTH_TOKEN|TLS_KEY_PATH)\b/
      const serviceChild = child
      await within(() => waitForFixtureStartup("Distributed service daemon", () => {
        const owner = readLocalOwnerRecord(home)
        expect(owner?.state).toBe("ready")
        if (owner?.state !== "ready") throw new Error("Owner has not published its bound endpoint")
        expect(stdout).toContain(`domovoid listening on ${owner.url}`)
      }, {
        output: () => `stdout:\n${stdout}\nstderr:\n${stderr}`,
        stopped: () => {
          if (serviceChild.exitCode !== null) return `exited with code ${serviceChild.exitCode}`
          if (serviceChild.signalCode !== null) return `ended by ${serviceChild.signalCode}`
          return hostileSetting.test(stderr) ? "read a setting the saved configuration replaces" : undefined
        },
      }))
      expect(stderr).not.toMatch(hostileSetting)
      const owner = readLocalOwnerRecord(home)
      if (owner?.state !== "ready") throw new Error("Owner record disappeared after startup")
      const port = Number(new URL(owner.url).port)
      expect(port).toBeGreaterThan(0)
      for (const bearer of [undefined, "s".repeat(43)]) {
        deadline.throwIfExpired()
        const rejected = new WebSocket(`wss://127.0.0.1:${port}/rpc`, {
          rejectUnauthorized: false, origin: "https://service.example.com",
          ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}),
        })
        try {
          await once(rejected, "open", { signal: deadline.signal })
          const messages = on(rejected, "message", { signal: deadline.signal })
          rejected.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "system.hello", params: { client: "cli", clientVersion: "service-test", protocolVersion } }))
          for await (const [bytes] of messages) {
            const response = JSON.parse(String(bytes)) as { id?: number; result?: unknown; error?: unknown }
            if (response.id !== 1) continue
            expect(response.error).toMatchObject({ message: "Daemon authentication failed" })
            expect(response.result).toBeUndefined()
            break
          }
        } finally {
          rejected.terminate()
        }
      }
      deadline.throwIfExpired()
      const wrongOrigin = new WebSocket(`wss://127.0.0.1:${port}/rpc`, {
        rejectUnauthorized: false, origin: "https://unapproved.example.com",
        headers: { authorization: `Bearer ${token}` },
      })
      try {
        await expect(once(wrongOrigin, "open", { signal: deadline.signal })).rejects.toThrow("Unexpected server response: 401")
      } finally {
        wrongOrigin.terminate()
      }
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
      const failures: unknown[] = []
      try {
        if (exited) await withinServiceDeadline(cleanup, () => exited!)
      } catch (error) {
        failures.push(error)
      } finally {
        cleanup.clear()
      }
      // Removal is never skipped because waiting for the child spent the
      // budget, and it retries a home the exiting child still holds.
      try { await removeScratchDirectory(home) } catch (error) { failures.push(error) }
      cleanupFailures.push(...failures)
    }
  }, budget + cleanupBudget + 1_000)

  it.each([
    { configuration: "unparseable", prepare: (path: string) => writeFile(path, "{ not json\n") },
    { configuration: "missing", prepare: async () => {} },
  ])("refuses a $configuration service configuration without a stack trace", async ({ prepare }) => {
    const deadline = OperationDeadline.start(budget)
    const within = <T>(operation: () => Promise<T>) => withinServiceDeadline(deadline, operation)
    const home = await within(() => mkdtemp(join(tmpdir(), "domovoi-service-config-")))
    try {
      const configPath = join(home, "service.json")
      await within(() => prepare(configPath))
      const refusal = await within(() => run(process.execPath, [cliPath, "--service-config", configPath], {
        env: { ...process.env, HOME: home, USERPROFILE: home, DOMOVOI_PROFILE_DIR: join(home, ".domovoi"), NODE_NO_WARNINGS: "1" },
        signal: deadline.signal, timeout: Math.ceil(deadline.remainingMs()),
      })).catch((error: unknown) => error as { code?: unknown; stdout: string; stderr: string })
      expect(refusal).toMatchObject({
        code: 1,
        stdout: "",
        stderr: `Could not load service configuration at ${configPath}. Reinstall the service before restarting.\n`,
      })
      expect(refusal.stderr).not.toMatch(/^\s+at /m)
    } finally {
      deadline.clear()
      await removeScratchDirectory(home)
    }
  }, budget + cleanupBudget + 1_000)
})

describe("supervisor CLI dispatch", () => {
  // Exercise the source entry point with only the platform boundary mocked.
  // This does not depend on rebuilding dist or start any daemon/profile.
  it.each(["exhausted", "failed"] as const)("reports Windows %s loudly with exit 1", async (state) => {
    vi.resetModules()
    const windows = await import("./windows-job-supervisor.js")
    const guest = await import("./supervisor-command.js")
    const result = { state, crashes: 4, attempts: [{}, {}, {}, {}] }
    const runWindows = vi.spyOn(windows, "runWindowsSupervisor").mockResolvedValue(result as Awaited<ReturnType<typeof windows.runWindowsSupervisor>>)
    const runGuest = vi.spyOn(guest, "runGuestSupervisor").mockResolvedValue({ state: "stopped" } as Awaited<ReturnType<typeof guest.runGuestSupervisor>>)
    const stderr = vi.fn()
    const cliProcess = { ...process, platform: "win32", argv: [process.execPath, "daemon-entry.js", "--service-supervise", "service.json"],
      execArgv: [], stderr: { write: stderr }, exitCode: 0 }
    try {
      vi.stubGlobal("process", cliProcess)
      await import("../index.js")
      expect(runWindows).toHaveBeenCalledWith("service.json", { executable: cliProcess.execPath, args: ["daemon-entry.js", "--service-config", "service.json"] })
      expect(runGuest).not.toHaveBeenCalled()
      expect(cliProcess.exitCode).toBe(1)
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("windows-supervisor.json"))
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining(state === "exhausted" ? "4 crashes and 4 attempts" : "observation failure"))
    } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules() }
  })

  it.each(["win32", "linux"])("dispatches retirement on %s and prints its proof", async (platform) => {
    vi.resetModules()
    const windows = await import("./windows-job-supervisor.js")
    const guest = await import("./supervisor-command.js")
    const stopWindows = vi.spyOn(windows, "stopWindowsSupervisor").mockResolvedValue({ state: "stopped", platform: "win32" } as Awaited<ReturnType<typeof windows.stopWindowsSupervisor>>)
    const stopGuest = vi.spyOn(guest, "stopGuestSupervisor").mockResolvedValue({ state: "stopped" } as Awaited<ReturnType<typeof guest.stopGuestSupervisor>>)
    const stdout = vi.fn()
    try {
      vi.stubGlobal("process", { ...process, platform, argv: [process.execPath, "daemon-entry.js", "--service-supervisor-stop", "service.json"], stdout: { write: stdout } })
      await import("../index.js")
      expect(platform === "win32" ? stopWindows : stopGuest).toHaveBeenCalledWith("service.json", expect.objectContaining({ throwIfExpired: expect.any(Function) }))
      expect(platform === "win32" ? stopGuest : stopWindows).not.toHaveBeenCalled()
      expect(JSON.parse(stdout.mock.calls[0]![0] as string)).toMatchObject({ state: "stopped" })
    } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules() }
  })
})
