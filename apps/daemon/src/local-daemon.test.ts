import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { acquireLocalDaemon, type LocalDaemonHandle } from "./local-daemon.js"
import { readLocalOwnerRecord, writeLocalOwnerRecord } from "./local-owner-record.js"
import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"
import { createProductionDaemon, type ProductionDaemonHandle } from "./production-daemon.js"
import { claimProfile } from "./profile-lease.js"
import { CliProviderProbe } from "./providers.js"

vi.mock("./local-owner-record.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./local-owner-record.js")>()
  return { ...actual, readLocalOwnerRecord: vi.fn(actual.readLocalOwnerRecord) }
})

const homes: string[] = []
const handles: Array<ProductionDaemonHandle | LocalDaemonHandle> = []
beforeEach(() => { vi.spyOn(CliProviderProbe.prototype, "inspect").mockResolvedValue([]) })
afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => {
    if ("stop" in handle) await handle.stop()
    else if (handle.kind === "attached") handle.detach()
  }))
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
  vi.restoreAllMocks()
})
async function home() {
  const directory = await mkdtemp(join(tmpdir(), "domovoi-local-attachment-"))
  homes.push(directory)
  return directory
}
const defaults = { environment: { DOMOVOI_PORT: "0" }, timeoutMs: 3_000, mode: "start-or-attach" as const }
async function acquire(homeDirectory: string, mode = defaults.mode as "start-or-attach" | "attach-only") {
  const handle = await acquireLocalDaemon({ ...defaults, homeDirectory, mode })
  handles.push(handle)
  return handle
}

it("owns a free profile but gives a second Desktop attachment no stop capability", async () => {
  const homeDirectory = await home()
  const first = await acquire(homeDirectory)
  expect(first.kind).toBe("owned")
  const second = await acquire(homeDirectory)
  expect(second).toMatchObject({ kind: "attached", owner: "desktop" })
  expect(second).not.toHaveProperty("stop")
  if (second.kind !== "attached" || first.kind !== "owned") throw new Error("Missing attachment")
  expect(second.endpoint).toEqual(first.endpoint)
  second.detach()
  expect((await acquire(homeDirectory, "attach-only")).kind).toBe("attached")
})

it("attaches to a daemon owner and rediscovers its current endpoint after restart", async () => {
  const homeDirectory = await home()
  const first = await createProductionDaemon({ homeDirectory, environment: defaults.environment })
  handles.push(first)
  await first.start()
  const before = readLocalOwnerRecord(homeDirectory)
  const attached = await acquire(homeDirectory)
  expect(attached).toMatchObject({ kind: "attached", owner: "daemon" })
  if (attached.kind !== "attached") throw new Error("Missing attachment")
  expect(attached.closed).toBeInstanceOf(Promise)
  await first.stop()
  const closedDeadline = OperationDeadline.start(3_000)
  try { await expect(beforeDeadline(attached.closed, closedDeadline)).resolves.toBeUndefined() } finally { closedDeadline.clear() }
  expect(await acquire(homeDirectory, "attach-only")).toMatchObject({ kind: "refused", reason: "owner-unreachable" })
  const restarted = await createProductionDaemon({ homeDirectory, environment: defaults.environment })
  handles.push(restarted)
  const endpoint = await restarted.start()
  const after = readLocalOwnerRecord(homeDirectory)
  expect(after).not.toEqual(before)
  expect(await acquire(homeDirectory, "attach-only")).toMatchObject({
    kind: "attached", owner: "daemon", endpoint: { url: endpoint.url, token: restarted.authToken },
  })
})

it("never creates a Desktop fallback from a stale owner record or an installed service", async () => {
  const homeDirectory = await home()
  const daemon = await createProductionDaemon({ homeDirectory, environment: defaults.environment })
  handles.push(daemon)
  await daemon.start()
  const ready = readLocalOwnerRecord(homeDirectory)!
  await daemon.stop()
  const lease = claimProfile(homeDirectory)
  writeLocalOwnerRecord(homeDirectory, ready)
  lease.release()
  expect(await acquire(homeDirectory)).toMatchObject({ kind: "refused", reason: "owner-unreachable" })
  expect(readLocalOwnerRecord(homeDirectory)).toEqual(ready)
  const nextLease = claimProfile(homeDirectory)
  writeLocalOwnerRecord(homeDirectory, { version: 1, state: "none" })
  nextLease.release()
  await writeFile(join(homeDirectory, ".domovoi", "service.json"), "{}", { mode: 0o600 })
  expect(await acquire(homeDirectory)).toMatchObject({ kind: "refused", reason: "owner-unreachable" })
  expect(readLocalOwnerRecord(homeDirectory)).toEqual({ version: 1, state: "none" })
})

it("refuses busy startup and invalid records without changing the owner", async () => {
  const homeDirectory = await home()
  const daemon = await createProductionDaemon({ homeDirectory, environment: defaults.environment })
  handles.push(daemon)
  const record = readLocalOwnerRecord(homeDirectory)
  expect(await acquire(homeDirectory)).toMatchObject({ kind: "refused", reason: "owner-unreachable" })
  expect(readLocalOwnerRecord(homeDirectory)).toEqual(record)
  await writeFile(join(homeDirectory, ".domovoi", "local-owner.json"), "malformed-private-value")
  expect(await acquire(homeDirectory)).toMatchObject({ kind: "refused", reason: "profile-invalid" })
})

it("refuses as unreachable when the deadline expires after a good final verification", async () => {
  const homeDirectory = await home()
  const daemon = await createProductionDaemon({ homeDirectory, environment: defaults.environment })
  handles.push(daemon)
  await daemon.start()
  const actual = vi.mocked(readLocalOwnerRecord).getMockImplementation()!
  const realNow = performance.now.bind(performance)
  const reads = vi.mocked(readLocalOwnerRecord).mock.calls.length
  // Discovery reads the record once, then verifies it again at settlement.
  // The clock passes the deadline inside that final read; no timer fires.
  vi.mocked(readLocalOwnerRecord).mockImplementationOnce(actual).mockImplementationOnce((directory) => {
    const record = actual(directory)
    expect(record?.state).toBe("ready")
    vi.spyOn(performance, "now").mockImplementation(() => realNow() + 10_000)
    return record
  })
  try {
    expect(await acquire(homeDirectory, "attach-only")).toMatchObject({ kind: "refused", reason: "owner-unreachable" })
  } finally {
    vi.mocked(performance.now).mockRestore()
  }
  expect(vi.mocked(readLocalOwnerRecord).mock.calls.length - reads).toBe(2)
})
