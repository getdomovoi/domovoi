import { execFile, spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { fsyncSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { acquireLocalDaemon, type LocalDaemonHandle } from "./local-daemon.js"
import { readLocalOwnerRecord, type ReadyLocalOwner } from "./local-owner-record.js"
import { writeLocalOwnerRemovalReceipt } from "./local-owner-removal.js"
import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"
import { CliProviderProbe } from "./providers.js"
import { claimProfile } from "./profile-lease.js"
import { createServiceConfiguration, serializeServiceConfiguration, serviceConfigurationPath } from "./service/configuration.js"
import { installService, nodeServiceEffects, removeService } from "./service/install.js"
import { waitForDaemon } from "./test-wait-for.js"

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) }
})

const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url))
const run = promisify(execFile)
const operationBudget = process.platform === "win32" ? 30_000 : 15_000
const cleanupBudget = 10_000
const homes: string[] = []
const children: Array<{ child: ChildProcess; exited: Promise<unknown> }> = []
const handles: LocalDaemonHandle[] = []

beforeEach(() => { vi.spyOn(CliProviderProbe.prototype, "inspect").mockResolvedValue([]) })
afterEach(async () => {
  const deadline = OperationDeadline.start(cleanupBudget)
  try {
    for (const handle of handles.splice(0)) {
      if (handle.kind === "owned") await beforeDeadline(handle.stop(), deadline)
      else if (handle.kind === "attached") handle.detach()
    }
    for (const { child, exited } of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await beforeDeadline(exited, deadline)
    }
    for (const home of homes.splice(0)) await beforeDeadline(rm(home, { recursive: true, force: true }), deadline)
  } finally {
    deadline.clear()
    vi.restoreAllMocks()
  }
})

function environment(home: string) {
  return {
    ...process.env, HOME: home, USERPROFILE: home, NODE_NO_WARNINGS: "1",
    DOMOVOI_HOST: "127.0.0.1", DOMOVOI_PORT: "0", DOMOVOI_AUTH_TOKEN: undefined,
    DOMOVOI_CREDENTIAL_PATH: join(home, ".domovoi", "daemon.token"),
    DOMOVOI_MACHINE_IDENTITY_PATH: join(home, ".domovoi", "machine.json"),
    DOMOVOI_TLS_CERT_PATH: undefined, DOMOVOI_TLS_KEY_PATH: undefined,
    DOMOVOI_ADVERTISE_HOST: undefined, DOMOVOI_ALLOWED_ORIGINS: undefined,
    DOMOVOI_ALLOW_REMOTE_TRANSPORT: "0",
  }
}

async function startOwner(home: string, deadline: OperationDeadline, service = false) {
  deadline.throwIfExpired()
  // The test process is the fake supervisor. It starts the actual CLI with no
  // canonical service configuration, as any custom supervisor can do.
  const child = spawn(process.execPath, [cli, ...(service ? ["--service-config", serviceConfigurationPath(home, process.platform)] : [])], {
    env: environment(home), signal: deadline.signal, killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
  })
  const exited = once(child, "exit")
  void exited.catch(() => {})
  children.push({ child, exited })
  let output = ""
  child.stdout?.on("data", (bytes: Buffer) => { output += bytes.toString() })
  child.stderr?.on("data", (bytes: Buffer) => { output += bytes.toString() })
  await beforeDeadline(waitForDaemon(() => {
    expect(output).toContain("domovoid listening on")
    expect(readLocalOwnerRecord(home)?.state).toBe("ready")
  }), deadline)
  const record = readLocalOwnerRecord(home)
  if (record?.state !== "ready") throw new Error(`Missing ready owner: ${output}`)
  return { record, kill: async () => { child.kill("SIGKILL"); await beforeDeadline(exited, deadline) } }
}

function serviceTarget(home: string) {
  const user = userInfo()
  return {
    platform: process.platform, home, uid: user.uid, user: user.username,
    execPath: cli, runtime: process.execPath,
    configuration: createServiceConfiguration({ DOMOVOI_PORT: "0" }, { homeDirectory: home, workingDirectory: home, platform: process.platform }),
  }
}

it("assigns a fresh registration on every install and invalidates an earlier recovery receipt", async () => {
  const deadline = OperationDeadline.start(operationBudget)
  try {
    const home = await setup(deadline)
    const effects = { ...nodeServiceEffects(), run: vi.fn(async () => {}) }
    const target = serviceTarget(home)
    await beforeDeadline(installService(target, effects), deadline)
    const first = JSON.parse(await readFile(serviceConfigurationPath(home, process.platform), "utf8")) as { registrationId?: string }
    expect(first.registrationId).toMatch(/^[0-9a-f-]{36}$/)
    await writeFile(receiptPath(home), "old receipt", { mode: 0o600 })
    await beforeDeadline(installService(target, effects), deadline)
    const second = JSON.parse(await readFile(serviceConfigurationPath(home, process.platform), "utf8")) as { registrationId?: string }
    expect(second.registrationId).toMatch(/^[0-9a-f-]{36}$/)
    expect(second.registrationId).not.toBe(first.registrationId)
    await expect(stat(receiptPath(home))).rejects.toMatchObject({ code: "ENOENT" })
  } finally { deadline.clear() }
}, operationBudget + 1_000)

it("receipts the installed owner's exact instance only after stopping its supervisor", async () => {
  const deadline = OperationDeadline.start(operationBudget)
  try {
    const home = await setup(deadline)
    const node = nodeServiceEffects()
    const target = serviceTarget(home)
    await beforeDeadline(installService(target, { ...node, run: async () => {} }), deadline)
    const saved = JSON.parse(await readFile(serviceConfigurationPath(home, process.platform), "utf8")) as { registrationId?: string }
    expect(saved.registrationId).toMatch(/^[0-9a-f-]{36}$/)
    const owner = await startOwner(home, deadline, true)
    expect(owner.record).toHaveProperty("serviceRegistrationId", saved.registrationId)
    const stop = async () => {
      await expect(stat(receiptPath(home))).rejects.toMatchObject({ code: "ENOENT" })
      await owner.kill()
      expect(readLocalOwnerRecord(home)).toEqual(owner.record)
    }
    await beforeDeadline(removeService(target, {
      ...node,
      run: async (_command, args) => { if (args.includes("disable") || args.includes("bootout")) await stop() },
      capture: async (_command, args) => {
        const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le")
        if (script.includes("$task.Stop(0)")) await stop()
        return { code: 0, stdout: script.includes("$folder.DeleteTask(") ? "domovoi-task:deleted" : "domovoi-task:1" }
      },
      remove: async (path, budget) => {
        // The manager stopped, but configuration deletion must not expose a
        // free profile before the receipt has been committed.
        let contender: ReturnType<typeof claimProfile> | undefined
        try {
          expect(() => { contender = claimProfile(home) }).toThrow(/already owned/)
        } finally { contender?.release() }
        await expect(stat(receiptPath(home))).rejects.toMatchObject({ code: "ENOENT" })
        await node.remove(path, budget)
      },
    }), deadline)
    const savedReceipt = JSON.parse(await readFile(receiptPath(home), "utf8")) as object
    expect(savedReceipt).toMatchObject({
      instanceId: owner.record.instanceId, machineId: owner.record.machineId,
      authorization: { kind: "service-removal", registrationId: saved.registrationId },
    })
    expect(readLocalOwnerRecord(home)).toEqual(owner.record)
    expect((await acquire(home, deadline)).kind).toBe("owned")
  } finally { deadline.clear() }
}, operationBudget + 1_000)

async function setup(deadline: OperationDeadline) {
  const home = await beforeDeadline(mkdtemp(join(tmpdir(), "domovoi-profile-recovery-")), deadline)
  homes.push(home)
  return home
}

async function acquire(homeDirectory: string, deadline: OperationDeadline) {
  const handle = await acquireLocalDaemon({
    homeDirectory, mode: "start-or-attach", environment: { DOMOVOI_PORT: "0" },
    timeoutMs: deadline.remainingMs(),
  })
  handles.push(handle)
  return handle
}

function receiptPath(home: string) { return join(home, ".domovoi", "local-owner-removal.json") }
function receipt(record: ReadyLocalOwner) {
  return {
    version: 1, instanceId: record.instanceId, machineId: record.machineId,
    completedAt: "2026-09-05T12:00:00.000Z",
    authorization: { kind: "operator", confirmation: "no-supervisor-will-restart", username: "test-operator" },
  }
}
async function recover(home: string, deadline: OperationDeadline, confirmed = true) {
  deadline.throwIfExpired()
  return beforeDeadline(run(process.execPath, [cli, "profile", "recover", ...(confirmed ? ["--confirm-no-supervisor"] : [])], {
    env: environment(home), signal: deadline.signal, timeout: Math.ceil(deadline.remainingMs()),
  }).then((result) => ({ ...result, code: 0 }), (error: unknown) => {
    const result = error as { code: number; stdout: string; stderr: string }
    return { code: result.code, stdout: result.stdout, stderr: result.stderr }
  }), deadline)
}

it("refuses a killed custom-supervised CLI without a receipt, then honors the explicit claim", async () => {
  const deadline = OperationDeadline.start(operationBudget)
  try {
    const home = await setup(deadline)
    const owner = await startOwner(home, deadline)
    await expect(stat(serviceConfigurationPath(home, process.platform))).rejects.toMatchObject({ code: "ENOENT" })
    await owner.kill()
    expect(await acquire(home, deadline)).toMatchObject({ kind: "refused", reason: "owner-unreachable" })
    expect(readLocalOwnerRecord(home)).toEqual(owner.record)

    expect(await recover(home, deadline)).toMatchObject({ code: 0, stdout: expect.stringContaining(owner.record.instanceId) })
    const saved = JSON.parse(await readFile(receiptPath(home), "utf8")) as object
    expect(saved).toMatchObject({
      instanceId: owner.record.instanceId, machineId: owner.record.machineId,
      authorization: { kind: "operator", confirmation: "no-supervisor-will-restart" },
    })
    if (process.platform !== "win32") expect((await stat(receiptPath(home))).mode & 0o777).toBe(0o600)
    expect(readLocalOwnerRecord(home)).toEqual(owner.record)
    expect((await acquire(home, deadline)).kind).toBe("owned")
    expect(readLocalOwnerRecord(home)).not.toMatchObject({ instanceId: owner.record.instanceId })
  } finally { deadline.clear() }
}, operationBudget + 1_000)

it("does not treat a deleted service configuration as permission to retire a killed owner", async () => {
  const deadline = OperationDeadline.start(operationBudget)
  try {
    const home = await setup(deadline)
    const owner = await startOwner(home, deadline)
    const path = serviceConfigurationPath(home, process.platform)
    const config = createServiceConfiguration({ DOMOVOI_PORT: "0" }, { homeDirectory: home, workingDirectory: home, platform: process.platform })
    await writeFile(path, serializeServiceConfiguration(config), { mode: 0o600 })
    await owner.kill()
    expect(await acquire(home, deadline)).toMatchObject({ kind: "refused", reason: "owner-unreachable" })
    await rm(path)
    expect(await acquire(home, deadline)).toMatchObject({ kind: "refused", reason: "owner-unreachable" })
    expect(readLocalOwnerRecord(home)).toEqual(owner.record)
  } finally { deadline.clear() }
}, operationBudget + 1_000)

it("retires only the exact receipt-bound instance, never a successor or a live owner", async () => {
  const deadline = OperationDeadline.start(operationBudget)
  try {
    const home = await setup(deadline)
    const owner = await startOwner(home, deadline)
    await writeFile(receiptPath(home), JSON.stringify(receipt(owner.record)), { mode: 0o600 })
    expect(await recover(home, deadline)).toMatchObject({ code: 1, stderr: expect.stringMatching(/profile.*already.*owned/i) })
    expect(await acquire(home, deadline)).toMatchObject({ kind: "attached", owner: "daemon" })
    expect(readLocalOwnerRecord(home)).toEqual(owner.record)
    await owner.kill()

    await writeFile(receiptPath(home), JSON.stringify({ ...receipt(owner.record), instanceId: randomUUID() }), { mode: 0o600 })
    expect(await acquire(home, deadline)).toMatchObject({ kind: "refused", reason: "owner-unreachable" })
    expect(readLocalOwnerRecord(home)).toEqual(owner.record)
    await writeFile(receiptPath(home), JSON.stringify(receipt(owner.record)), { mode: 0o600 })
    const first = await acquire(home, deadline)
    expect(first.kind).toBe("owned")
    expect(readLocalOwnerRecord(home)).not.toMatchObject({ instanceId: owner.record.instanceId })
  } finally { deadline.clear() }
}, operationBudget + 1_000)

it("requires the literal confirmation before opening a profile or writing a receipt", async () => {
  const deadline = OperationDeadline.start(operationBudget)
  try {
    const home = await setup(deadline)
    expect(await recover(home, deadline, false)).toMatchObject({ code: 1, stderr: expect.stringContaining("--confirm-no-supervisor") })
    await expect(stat(join(home, ".domovoi"))).rejects.toMatchObject({ code: "ENOENT" })
  } finally { deadline.clear() }
}, operationBudget + 1_000)

it.skipIf(process.platform === "win32")("reports a published receipt when only the directory flush after rename fails", async () => {
  const deadline = OperationDeadline.start(operationBudget)
  const home = await setup(deadline)
  await mkdir(join(home, ".domovoi"), { mode: 0o700 })
  const lease = claimProfile(home)
  try {
    const record: ReadyLocalOwner = {
      version: 1, state: "ready", instanceId: randomUUID(), machineId: `machine-${"a".repeat(32)}`,
      protocolVersion: "0.4.0", owner: "daemon", credential: { source: "environment" }, url: "ws://127.0.0.1:47831/rpc",
    }
    const actual = vi.mocked(fsyncSync).getMockImplementation()!
    vi.mocked(fsyncSync).mockImplementationOnce(actual).mockImplementationOnce(() => {
      throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" })
    })
    expect(() => writeLocalOwnerRemovalReceipt(home, lease, receipt(record), deadline)).toThrow(
      expect.objectContaining({ message: expect.stringMatching(/receipt is published at .*local-owner-removal\.json.*after publication.*EIO/s) }),
    )
    expect(() => writeLocalOwnerRemovalReceipt(home, lease, receipt(record), deadline)).not.toThrow()
    expect(JSON.parse(await readFile(receiptPath(home), "utf8"))).toMatchObject({ instanceId: record.instanceId })
    expect((await readdir(join(home, ".domovoi"))).filter((name) => name.endsWith(".partial"))).toEqual([])
  } finally {
    lease.release()
    deadline.clear()
  }
}, operationBudget + 1_000)
