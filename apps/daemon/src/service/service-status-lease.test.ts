import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdtempSync, readdirSync, statSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, describe, expect, it, vi } from "vitest"

import { removeScratchDirectory } from "../test-scratch.js"
import { nodeServiceEffects, serviceStatus } from "./install.js"
import { claimServiceOperation, ServiceOperationBusyError } from "./operation-lease.js"

const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await removeScratchDirectory(home)
})

function fixture(existing = true) {
  const home = mkdtempSync(join(tmpdir(), "domovoi-status-lease-"))
  homes.push(home)
  if (existing) claimServiceOperation(home).release()
  const profile = join(home, ".domovoi")
  const path = join(profile, "service-operation-lease.sqlite")
  const effects = {
    ...nodeServiceEffects({ userHomeDirectory: home }),
    capture: vi.fn(async () => ({ code: 0, stdout: "active" })),
    exists: vi.fn(async () => existing),
    supervisorStatus: vi.fn(async () => undefined),
  }
  return { home, profile, path, effects, target: { platform: "linux", home } }
}

function metadata(path: string) {
  const { ctimeNs, mtimeNs, ino, size } = statSync(path, { bigint: true })
  return { ctimeNs, mtimeNs, ino, size }
}

function latch() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe("read-only service status leases", () => {
  it("leaves the existing profile and lease unchanged through serviceStatus", async () => {
    const f = fixture()
    const old = new Date("2000-01-01T00:00:00Z")
    utimesSync(f.profile, old, old)
    const before = { directory: metadata(f.profile), lease: metadata(f.path), entries: readdirSync(f.profile) }
    await delay(30)
    await expect(serviceStatus(f.target, f.effects)).resolves.toMatchObject({ installed: true, running: true })
    expect(f.effects.capture).toHaveBeenCalledOnce()
    expect({ directory: metadata(f.profile), lease: metadata(f.path), entries: readdirSync(f.profile) }).toEqual(before)
  })

  it("creates nothing when the native user's profile is absent", async () => {
    const f = fixture(false)
    await expect(serviceStatus(f.target, f.effects)).resolves.toMatchObject({ installed: false })
    expect(existsSync(f.profile)).toBe(false)
    expect(readdirSync(f.home)).toEqual([])
  })

  it("refuses status before manager reads while an exclusive claim is held", async () => {
    const f = fixture()
    const writer = claimServiceOperation(f.home)
    try {
      await expect(serviceStatus(f.target, f.effects)).rejects.toBeInstanceOf(ServiceOperationBusyError)
      expect(f.effects.capture).not.toHaveBeenCalled()
      expect(f.effects.exists).not.toHaveBeenCalled()
      expect(f.effects.supervisorStatus).not.toHaveBeenCalled()
    } finally { writer.release() }
  })

  it("refuses a mutation until the status read settles and releases its claim", async () => {
    const f = fixture()
    const entered = latch(), resume = latch()
    const pending = serviceStatus(f.target, { ...f.effects, capture: async () => {
      entered.resolve()
      await resume.promise
      return { code: 0, stdout: "active" }
    } })
    try {
      await entered.promise
      expect(() => claimServiceOperation(f.home)).toThrow(ServiceOperationBusyError)
    } finally {
      resume.resolve()
      await pending
    }
    claimServiceOperation(f.home).release()
  })

  it("allows two concurrent status reads", async () => {
    const f = fixture()
    const entered = latch(), resume = latch()
    const pending = serviceStatus(f.target, { ...f.effects, capture: async () => {
      entered.resolve()
      await resume.promise
      return { code: 0, stdout: "active" }
    } })
    try {
      await entered.promise
      await expect(serviceStatus(f.target, f.effects)).resolves.toMatchObject({ running: true })
    } finally {
      resume.resolve()
      await pending
    }
  })

  it.skipIf(process.platform === "win32")("preserves a killed writer's journal beside a zero-byte lease", async () => {
    const f = fixture()
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from 'node:sqlite';
      const database = new DatabaseSync(process.argv[1]);
      database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
      process.stdout.write('held');
      setInterval(() => {}, 1000);
    `, f.path], { env: { ...process.env, HOME: f.home, USERPROFILE: f.home }, stdio: ["ignore", "pipe", "pipe"] })
    const closed = once(child, "close")
    try {
      const [output] = await once(child.stdout, "data", { signal: AbortSignal.timeout(3_000) })
      expect(String(output)).toBe("held")
      child.kill("SIGKILL")
      await closed
      const journal = `${f.path}-journal`
      expect(statSync(f.path).size).toBe(0)
      expect(statSync(journal).size).toBeGreaterThan(0)
      const before = { journal: metadata(journal), lease: metadata(f.path), directory: metadata(f.profile), entries: readdirSync(f.profile) }
      await delay(30)
      await expect(serviceStatus(f.target, f.effects)).resolves.toMatchObject({ running: true })
      expect({ journal: metadata(journal), lease: metadata(f.path), directory: metadata(f.profile), entries: readdirSync(f.profile) }).toEqual(before)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await closed
    }
  })
})
