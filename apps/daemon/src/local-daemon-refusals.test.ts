import { createServer, type Server } from "node:net"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { acquireLocalDaemon, type LocalDaemonHandle } from "./local-daemon.js"
import { readLocalOwnerRecord, writeLocalOwnerRecord } from "./local-owner-record.js"
import { productionDaemonDependencies } from "./production-daemon.js"
import { claimProfile } from "./profile-lease.js"
import { CliProviderProbe } from "./providers.js"
import { removeScratchDirectories } from "./test-scratch.js"

const homes: string[] = []
const handles: LocalDaemonHandle[] = []
const servers: Server[] = []
beforeEach(() => { vi.spyOn(CliProviderProbe.prototype, "inspect").mockResolvedValue([]) })
afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => {
    if (handle.kind === "owned") await handle.stop()
    else if (handle.kind === "attached") handle.detach()
  }))
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
  await removeScratchDirectories(homes)
  vi.restoreAllMocks()
})

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
  const { handle, errorSink } = await acquire(await home(), { DOMOVOI_PORT: String(port) })
  expect(handle).toMatchObject({ kind: "refused", reason: "port-in-use" })
  expect(errorSink).toHaveBeenCalledWith(expect.objectContaining({
    context: "Domovoi could not start its local daemon",
    detail: expect.stringContaining("EADDRINUSE"),
  }))
})

it("names a state database another process holds", async () => {
  vi.spyOn(productionDaemonDependencies, "createDaemon").mockImplementation(() => {
    throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 })
  })
  const { handle, errorSink } = await acquire(await home())
  expect(handle).toMatchObject({ kind: "refused", reason: "state-locked" })
  expect(errorSink).toHaveBeenCalled()
})

it("names a stored workspace that belongs to another machine identity", async () => {
  vi.spyOn(productionDaemonDependencies, "createDaemon").mockImplementation(() => {
    throw new Error("Stored workspace machine identity does not match this daemon; restore the matching identity and state before restarting")
  })
  const { handle } = await acquire(await home())
  expect(handle).toMatchObject({ kind: "refused", reason: "identity-mismatch" })
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
