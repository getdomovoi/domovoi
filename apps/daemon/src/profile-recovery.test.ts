import { execFile, spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { acquireLocalDaemon, type LocalDaemonHandle } from "./local-daemon.js"
import { readLocalOwnerRecord, type ReadyLocalOwner } from "./local-owner-record.js"
import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"
import { CliProviderProbe } from "./providers.js"
import { createServiceConfiguration, serializeServiceConfiguration, serviceConfigurationPath } from "./service/configuration.js"
import { waitForDaemon } from "./test-wait-for.js"

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
    DOMOVOI_MACHINE_IDENTITY_PATH: join(home, ".domovoi", "machine-identity.json"),
    DOMOVOI_TLS_CERT_PATH: undefined, DOMOVOI_TLS_KEY_PATH: undefined,
    DOMOVOI_ADVERTISE_HOST: undefined, DOMOVOI_ALLOWED_ORIGINS: undefined,
    DOMOVOI_ALLOW_REMOTE_TRANSPORT: "0",
  }
}

async function startOwner(home: string, deadline: OperationDeadline) {
  deadline.throwIfExpired()
  // The test process is the fake supervisor. It starts the actual CLI with no
  // canonical service configuration, as any custom supervisor can do.
  const child = spawn(process.execPath, [cli], {
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
