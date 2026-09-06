import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { WebSocket } from "ws"

import { acquireLocalDaemon, type LocalDaemonHandle } from "./local-daemon.js"
import { readLocalOwnerRecord, writeLocalOwnerRecord } from "./local-owner-record.js"
import { beforeDeadline, OperationDeadline, OperationDeadlineExceededError } from "./operation-deadline.js"
import {
  createProductionDaemon, productionDaemonDependencies, type ProductionDaemonHandle,
} from "./production-daemon.js"
import { claimProfile } from "./profile-lease.js"
import { CliProviderProbe } from "./providers.js"
import { removeScratchDirectories } from "./test-scratch.js"

vi.mock("@getdomovoi/protocol", async (importOriginal) => ({
  ...await importOriginal<typeof import("@getdomovoi/protocol")>(),
  buildVersion: "9.8.7-test",
}))

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
  await removeScratchDirectories(homes)
  vi.restoreAllMocks()
})
async function home() {
  const directory = await mkdtemp(join(tmpdir(), "domovoi-local-attachment-"))
  homes.push(directory)
  return directory
}
// The budget every acquisition here gets, matching the sibling TLS discovery
// suite that waits on the same runner. An expired budget is reported as a
// refusal, so a fixed 3 second window turned a cold Windows start into
// "expected 'refused' to be 'owned'". Measured across the 160 CI runs since
// this file landed, the heaviest test here costs a median of 717 ms on Windows
// against a 99th percentile of 4064 ms, a worst passing run of 5845 ms, and two
// failures at 4754 and 6900 ms; Ubuntu never passed 1344 ms and macOS 583 ms.
// Twenty seconds absorbs a stall twice the largest one measured on these
// runners in the same window and stays under the 30 second budget a production
// daemon start gives the same work.
const budgetMs = process.platform === "win32" ? 20_000 : 5_000
const defaults = { environment: { DOMOVOI_PORT: "0" }, timeoutMs: budgetMs, mode: "start-or-attach" as const }
const waited = new WeakMap<LocalDaemonHandle, number>()
async function acquire(homeDirectory: string, mode = defaults.mode as "start-or-attach" | "attach-only") {
  const started = performance.now()
  const handle = await acquireLocalDaemon({ ...defaults, homeDirectory, mode })
  waited.set(handle, Math.round(performance.now() - started))
  handles.push(handle)
  return handle
}
// A refusal this test's own budget produced reads exactly like one the daemon
// meant, and a failed object match prints neither the reason nor a clock, so
// every acquisition is asserted as a sentence, and a refusal that outlasted the
// budget names what it waited and what it waited against.
function outcome(handle: LocalDaemonHandle): string {
  if (handle.kind === "owned") return "owned"
  if (handle.kind === "attached") return `attached to ${handle.owner}`
  const observed = waited.get(handle)
  return observed !== undefined && observed >= budgetMs
    ? `refused ${handle.reason} after ${observed}ms of its ${budgetMs}ms budget`
    : `refused ${handle.reason}`
}

it("owns a free profile but gives a second Desktop attachment no stop capability", async () => {
  const sent = vi.spyOn(WebSocket.prototype, "send")
  const homeDirectory = await home()
  const first = await acquire(homeDirectory)
  expect(outcome(first)).toBe("owned")
  const second = await acquire(homeDirectory)
  expect(outcome(second)).toBe("attached to desktop")
  expect(second).not.toHaveProperty("stop")
  if (second.kind !== "attached" || first.kind !== "owned") throw new Error("Missing attachment")
  expect(second.endpoint).toEqual(first.endpoint)
  // Assert only public build identity, so a failing assertion never prints the bearer.
  expect(sent.mock.calls.flatMap(([payload]) => {
    if (typeof payload !== "string") return []
    const message = JSON.parse(payload) as { method?: string; params?: { clientVersion?: string } }
    return message.method === "system.hello" ? [message.params?.clientVersion] : []
  })).toContain("9.8.7-test")
  second.detach()
  expect(outcome(await acquire(homeDirectory, "attach-only"))).toBe("attached to desktop")
})

it("attaches to a daemon owner and rediscovers its current endpoint after restart", async () => {
  const homeDirectory = await home()
  const first = await createProductionDaemon({ homeDirectory, environment: defaults.environment })
  handles.push(first)
  await first.start()
  const before = readLocalOwnerRecord(homeDirectory)
  const attached = await acquire(homeDirectory)
  expect(outcome(attached)).toBe("attached to daemon")
  if (attached.kind !== "attached") throw new Error("Missing attachment")
  expect(attached.closed).toBeInstanceOf(Promise)
  await first.stop()
  const closedDeadline = OperationDeadline.start(budgetMs)
  try { await expect(beforeDeadline(attached.closed, closedDeadline)).resolves.toBeUndefined() } finally { closedDeadline.clear() }
  expect(outcome(await acquire(homeDirectory, "attach-only"))).toBe("refused owner-unreachable")
  const restarted = await createProductionDaemon({ homeDirectory, environment: defaults.environment })
  handles.push(restarted)
  const endpoint = await restarted.start()
  const after = readLocalOwnerRecord(homeDirectory)
  expect(after).not.toEqual(before)
  const rediscovered = await acquire(homeDirectory, "attach-only")
  expect(outcome(rediscovered)).toBe("attached to daemon")
  expect(rediscovered).toMatchObject({ endpoint: { url: endpoint.url, token: restarted.authToken } })
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
  expect(outcome(await acquire(homeDirectory))).toBe("refused owner-unreachable")
  expect(readLocalOwnerRecord(homeDirectory)).toEqual(ready)
  const nextLease = claimProfile(homeDirectory)
  writeLocalOwnerRecord(homeDirectory, { version: 1, state: "none" })
  nextLease.release()
  await writeFile(join(homeDirectory, ".domovoi", "service.json"), "{}", { mode: 0o600 })
  expect(outcome(await acquire(homeDirectory))).toBe("refused owner-unreachable")
  expect(readLocalOwnerRecord(homeDirectory)).toEqual({ version: 1, state: "none" })
})

it("refuses busy startup and invalid records without changing the owner", async () => {
  const homeDirectory = await home()
  const daemon = await createProductionDaemon({ homeDirectory, environment: defaults.environment })
  handles.push(daemon)
  const record = readLocalOwnerRecord(homeDirectory)
  expect(outcome(await acquire(homeDirectory))).toBe("refused owner-unreachable")
  expect(readLocalOwnerRecord(homeDirectory)).toEqual(record)
  await writeFile(join(homeDirectory, ".domovoi", "local-owner.json"), "malformed-private-value")
  expect(outcome(await acquire(homeDirectory))).toBe("refused profile-invalid")
})

it("classifies a startup step that timed out as unreachable, not an invalid profile", async () => {
  const homeDirectory = await home()
  // Credential initialization reports its own expiry, so the deadline arrives
  // as the cause rather than as the thrown error. A slow machine is not a
  // damaged profile, and telling its owner to inspect their private key is a
  // wrong answer that outlives the stall that produced it.
  vi.spyOn(productionDaemonDependencies, "loadOrCreateToken").mockRejectedValue(new Error(
    "Daemon credential initialization timed out at daemon.token. No publication was started.",
    { cause: new OperationDeadlineExceededError() },
  ))
  expect(outcome(await acquire(homeDirectory))).toBe("refused owner-unreachable")
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
    vi.spyOn(performance, "now").mockImplementation(() => realNow() + budgetMs + 1)
    return record
  })
  try {
    expect(outcome(await acquire(homeDirectory, "attach-only")))
      .toMatch(new RegExp(`^refused owner-unreachable after \\d+ms of its ${budgetMs}ms budget$`))
  } finally {
    vi.mocked(performance.now).mockRestore()
  }
  expect(vi.mocked(readLocalOwnerRecord).mock.calls.length - reads).toBe(2)
})
