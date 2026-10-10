import { randomBytes } from "node:crypto"
import { once } from "node:events"
import { existsSync, readdirSync, renameSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { protocolVersion } from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { OperationDeadline } from "./operation-deadline.js"
import { CliProviderProbe } from "./providers.js"
import { verifyLocalOwnerProof } from "./local-owner-proof.js"
import { removeScratchDirectories } from "./test-scratch.js"
import {
  localOwnerRecordPath, localOwnerSecretPath, maximumLocalOwnerRecordBytes,
  readLocalOwnerRecord, readLocalOwnerSecret, writeLocalOwnerRecord, type OwnerRecordReplacement,
} from "./local-owner-record.js"
import {
  createProductionDaemon, type ProductionDaemonHandle,
} from "./production-daemon.js"

const homes: string[] = []
const handles: ProductionDaemonHandle[] = []
// Keep production assembly and real sockets, not discovery of whichever SDK
// executables happen to be installed on the test runner.
beforeEach(() => { vi.spyOn(CliProviderProbe.prototype, "inspect").mockResolvedValue([]) })
afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.stop()))
  await removeScratchDirectories(homes)
  vi.restoreAllMocks()
})
async function owner() {
  const homeDirectory = await mkdtemp(join(tmpdir(), "domovoi-local-owner-"))
  homes.push(homeDirectory)
  const handle = await createProductionDaemon({ homeDirectory, environment: { DOMOVOI_PORT: "0" } })
  handles.push(handle)
  return { handle, homeDirectory }
}

it("publishes owner-only lifecycle records without either secret", async () => {
  const { handle, homeDirectory } = await owner()
  expect(readLocalOwnerRecord(homeDirectory)).toMatchObject({ state: "starting", owner: "daemon", protocolVersion })
  const endpoint = await handle.start()
  expect(endpoint.port).toBeGreaterThan(0)
  const record = readLocalOwnerRecord(homeDirectory)
  expect(record).toMatchObject({ state: "ready", url: endpoint.url })
  const secret = readLocalOwnerSecret(homeDirectory)
  expect(secret).not.toBe(handle.authToken)
  const contents = await readFile(localOwnerRecordPath(homeDirectory), "utf8")
  expect(contents).not.toContain(secret)
  expect(contents).not.toContain(handle.authToken)
  for (const path of [localOwnerRecordPath(homeDirectory), localOwnerSecretPath(homeDirectory)]) {
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600)
  }
  await handle.stop()
  expect(readLocalOwnerRecord(homeDirectory)).toEqual({ version: 1, state: "none" })
})

it("proves the instance on the same socket before ordinary authenticated hello", async () => {
  const { handle, homeDirectory } = await owner()
  const endpoint = await handle.start()
  const record = readLocalOwnerRecord(homeDirectory)
  expect(record?.state).toBe("ready")
  if (record?.state !== "ready") throw new Error("Owner did not publish its endpoint")
  const secret = readLocalOwnerSecret(homeDirectory)
  const deadline = OperationDeadline.start(3_000)
  const nonce = randomBytes(32).toString("base64url")
  const socket = new WebSocket(endpoint.url, { headers: { "x-domovoi-owner-nonce": nonce } })
  const abort = () => socket.terminate()
  deadline.signal.addEventListener("abort", abort, { once: true })
  try {
    const [response] = await once(socket, "upgrade", { signal: deadline.signal })
    expect(verifyLocalOwnerProof(secret, record, nonce, response.headers["x-domovoi-owner-proof"])).toBe(true)
    if (socket.readyState !== WebSocket.OPEN) await once(socket, "open", { signal: deadline.signal })
    const answer = once(socket, "message", { signal: deadline.signal })
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "system.hello", params: {
      client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: handle.authToken,
    } }))
    const [raw] = await answer
    const reply = JSON.parse(raw.toString())
    expect(reply.error).toBeUndefined()
    expect(reply.result).toMatchObject({ machine: { id: record.machineId }, protocolVersion })
  } finally {
    deadline.signal.removeEventListener("abort", abort)
    socket.terminate()
    deadline.clear()
  }
})

it("refuses oversized, malformed and non-private records without echoing their contents", async () => {
  const { handle, homeDirectory } = await owner()
  await handle.stop()
  const path = localOwnerRecordPath(homeDirectory)
  for (const contents of ["private-data", " ".repeat(maximumLocalOwnerRecordBytes + 1)]) {
    await writeFile(path, contents, { mode: 0o600 })
    expect(() => readLocalOwnerRecord(homeDirectory)).toThrow("owner record is invalid or inaccessible")
  }
  await writeFile(path, JSON.stringify({ version: 1, state: "none" }))
  if (process.platform !== "win32") {
    await chmod(path, 0o644)
    expect(() => readLocalOwnerRecord(homeDirectory)).toThrow("owner record is invalid or inaccessible")
  }
})

// Windows MoveFileEx refuses to replace a file another process holds open. A
// supervised daemon died at startup on CI when a status poll held this record.
async function replacement(platform: NodeJS.Platform, refusals: string[], held = false) {
  const homeDirectory = await mkdtemp(join(tmpdir(), "domovoi-local-owner-"))
  homes.push(homeDirectory)
  await mkdir(join(homeDirectory, ".domovoi"))
  let clock = 0
  const pauses: number[] = []
  const refused = [...refusals]
  const effects: OwnerRecordReplacement = {
    platform,
    now: () => clock,
    pause: (ms) => { pauses.push(ms); clock += ms },
    rename: (from, to) => {
      const code = held ? refusals[0] : refused.shift()
      if (code) throw Object.assign(new Error(`${code}: rename refused`), { code, syscall: "rename" })
      renameSync(from, to)
    },
  }
  const staged = () => readdirSync(join(homeDirectory, ".domovoi")).filter((name) => name.endsWith(".partial"))
  return { homeDirectory, effects, pauses, staged }
}

it.each(["EPERM", "EACCES", "EBUSY"])("retries a Windows %s sharing refusal and replaces the owner record", async (code) => {
  const { homeDirectory, effects, pauses, staged } = await replacement("win32", [code, code])
  writeLocalOwnerRecord(homeDirectory, { version: 1, state: "none" }, effects)
  expect(readLocalOwnerRecord(homeDirectory)).toEqual({ version: 1, state: "none" })
  expect(pauses).toEqual([5, 10])
  expect(staged()).toEqual([])
})

it("gives up a held Windows owner record after five seconds and names the sharing failure", async () => {
  // The file stays held for the whole budget.
  const { homeDirectory, effects, pauses, staged } = await replacement("win32", ["EPERM"], true)
  expect(() => writeLocalOwnerRecord(homeDirectory, { version: 1, state: "none" }, effects))
    .toThrow(/local-owner\.json.*held open by another process.*5 s/)
  expect(pauses.reduce((total, ms) => total + ms, 0)).toBe(5_000)
  expect(Math.max(...pauses)).toBe(250)
  expect(existsSync(localOwnerRecordPath(homeDirectory))).toBe(false)
  expect(staged()).toEqual([])
})

it("does not retry a refusal outside Windows sharing", async () => {
  for (const [platform, code] of [["linux", "EPERM"], ["darwin", "EBUSY"], ["win32", "ENOENT"]] as const) {
    const { homeDirectory, effects, pauses, staged } = await replacement(platform, [code])
    expect(() => writeLocalOwnerRecord(homeDirectory, { version: 1, state: "none" }, effects)).toThrow(`${code}: rename refused`)
    expect(pauses).toEqual([])
    expect(staged()).toEqual([])
  }
})
