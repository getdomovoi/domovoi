import { createServer, type Server } from "node:net"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { acquireLocalDaemon, type LocalDaemonHandle } from "./local-daemon.js"
import { StoredMachineIdentityMismatchError } from "./machine-identity.js"
import { readLocalOwnerRecord, writeLocalOwnerRecord } from "./local-owner-record.js"
import { productionDaemonDependencies } from "./production-daemon.js"
import { claimProfile } from "./profile-lease.js"
import { CliProviderProbe } from "./providers.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { waitForDaemon } from "./test-wait-for.js"

const homes: string[] = []
const handles: LocalDaemonHandle[] = []
const servers: Server[] = []
beforeEach(() => { vi.spyOn(CliProviderProbe.prototype, "inspect").mockResolvedValue([]) })
afterEach(async () => {
  // Restore first: a failed cleanup below must not leave a throwing daemon
  // factory in place for the next test.
  vi.restoreAllMocks()
  await Promise.all(handles.splice(0).map(async (handle) => {
    if (handle.kind === "owned") await handle.stop()
    else if (handle.kind === "attached") handle.detach()
  }))
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
  await removeScratchDirectories(homes)
})

// A refused start stops the runtime it built without waiting for it, and that
// runtime holds the profile lease until it has stopped. Windows cannot remove
// a lease file that is still open, so the test waits for the lease itself.
async function leaseReleased(homeDirectory: string): Promise<void> {
  await waitForDaemon(() => claimProfile(homeDirectory).release())
}

async function home() {
  const directory = await mkdtemp(join(tmpdir(), "domovoi-local-refusal-"))
  homes.push(directory)
  return directory
}

const budgetMs = process.platform === "win32" ? 20_000 : 5_000

async function acquire(homeDirectory: string, environment: Record<string, string> = { DOMOVOI_PORT: "0" }, errorSink = vi.fn()) {
  const handle = await acquireLocalDaemon({ homeDirectory, environment, timeoutMs: budgetMs, mode: "start-or-attach", errorSink })
  handles.push(handle)
  return { handle, errorSink }
}

it("names a port another program holds instead of calling the profile invalid", { timeout: budgetMs * 2 }, async () => {
  const blocker = createServer()
  servers.push(blocker)
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve))
  const port = (blocker.address() as { port: number }).port
  const homeDirectory = await home()
  const { handle, errorSink } = await acquire(homeDirectory, { DOMOVOI_PORT: String(port) })
  await leaseReleased(homeDirectory)
  expect(handle).toMatchObject({ kind: "refused", reason: "port-in-use" })
  expect(errorSink).toHaveBeenCalledWith(expect.objectContaining({
    context: "Domovoi could not start its local daemon",
    detail: expect.stringContaining("EADDRINUSE"),
  }))
})

it.each([
  ["busy (5)", "database is locked", 5],
  ["locked (6)", "database table is locked", 6],
])("names a state database another process holds: SQLite %s", async (_name, text, errcode) => {
  vi.spyOn(productionDaemonDependencies, "createDaemon").mockImplementation(() => {
    throw Object.assign(new Error(text), { code: "ERR_SQLITE_ERROR", errcode })
  })
  const { handle, errorSink } = await acquire(await home())
  expect(handle).toMatchObject({ kind: "refused", reason: "state-locked" })
  expect(errorSink).toHaveBeenCalled()
})

it("names a stored workspace that belongs to another machine identity", async () => {
  vi.spyOn(productionDaemonDependencies, "createDaemon").mockImplementation(() => {
    throw new StoredMachineIdentityMismatchError()
  })
  const { handle } = await acquire(await home())
  expect(handle).toMatchObject({ kind: "refused", reason: "identity-mismatch" })
})

it("does not take an error that only quotes the identity message for a mismatch", async () => {
  vi.spyOn(productionDaemonDependencies, "createDaemon").mockImplementation(() => {
    throw new Error("Stored workspace machine identity does not match this daemon; quoted by another component")
  })
  const { handle } = await acquire(await home())
  expect(handle).toMatchObject({ kind: "refused", reason: "profile-invalid" })
})

it("still calls an unreadable owner record an invalid profile, and logs the cause", async () => {
  const homeDirectory = await home()
  const first = await acquire(homeDirectory)
  expect(first.handle.kind).toBe("owned")
  if (first.handle.kind === "owned") await first.handle.stop()
  handles.splice(0)
  vi.spyOn(productionDaemonDependencies, "createDaemon").mockImplementation(() => {
    throw new Error("an unexpected startup failure")
  })
  const { handle, errorSink } = await acquire(homeDirectory)
  expect(handle).toMatchObject({ kind: "refused", reason: "profile-invalid" })
  expect(errorSink).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining("an unexpected startup failure") }))
})

it("starts over a Desktop owner record left stopping when this launch holds the lease", async () => {
  const homeDirectory = await home()
  const first = await acquire(homeDirectory)
  expect(first.handle.kind).toBe("owned")
  const ready = readLocalOwnerRecord(homeDirectory)
  if (ready?.state !== "ready" || first.handle.kind !== "owned") throw new Error("Expected a ready Desktop owner")
  await first.handle.stop()
  handles.splice(0)
  // Desktop quit while the daemon was still stopping: the process is gone and
  // the record it left says stopping.
  const { url: _url, ...owner } = ready
  const lease = claimProfile(homeDirectory)
  writeLocalOwnerRecord(homeDirectory, { ...owner, state: "stopping" })
  lease.release()

  const { handle } = await acquire(homeDirectory)
  expect(handle.kind).toBe("owned")
})
