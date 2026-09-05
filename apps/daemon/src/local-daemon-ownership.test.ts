import { fork } from "node:child_process"
import { on, once } from "node:events"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, it, vi } from "vitest"

import { OperationDeadline } from "./operation-deadline.js"
import {
  createProductionDaemon, createProductionDaemonWithDependencies, productionDaemonDependencies,
  type ProductionDaemonHandle,
} from "./production-daemon.js"

const homes: string[] = []
const handles: ProductionDaemonHandle[] = []

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.stop()))
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

describe("production profile ownership", () => {
  it("refuses a second profile owner before either listener starts", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "domovoi-profile-owner-"))
    homes.push(homeDirectory)
    const first = await createProductionDaemon({ environment: {}, homeDirectory })
    handles.push(first)

    // A different port must not turn the same session database into two
    // writable daemons. Both paths are the factory shipped to CLI and Desktop.
    const second = createProductionDaemon({
      environment: { DOMOVOI_PORT: "47832" }, homeDirectory,
    }).then((handle) => { handles.push(handle); return handle })

    await expect(second).rejects.toThrow(/profile.*already.*owned/i)
  })

  it("blocks the losing constructor and permits a new owner only after stop completes", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "domovoi-profile-owner-"))
    homes.push(homeDirectory)
    const first = await createProductionDaemon({ environment: {}, homeDirectory })
    handles.push(first)
    const constructor = vi.fn(productionDaemonDependencies.createDaemon)
    await expect(createProductionDaemonWithDependencies({ environment: {}, homeDirectory }, {
      ...productionDaemonDependencies, createDaemon: constructor,
    })).rejects.toThrow(/profile.*already.*owned/i)
    expect(constructor).not.toHaveBeenCalled()

    await first.stop()
    const second = await createProductionDaemon({ environment: {}, homeDirectory })
    handles.push(second)
    expect(second.authToken).toBe(first.authToken)
  })

  it("leaves the state store writable while holding a separate owner-only lease", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "domovoi-profile-owner-"))
    homes.push(homeDirectory)
    const first = await createProductionDaemon({ environment: {}, homeDirectory })
    handles.push(first)
    const database = new DatabaseSync(join(homeDirectory, ".domovoi", "state.sqlite"))
    try {
      expect(() => database.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK;")).not.toThrow()
    } finally {
      database.close()
    }
    const mode = (await stat(join(homeDirectory, ".domovoi", "profile-lease.sqlite"))).mode
    if (process.platform !== "win32") expect(mode & 0o777).toBe(0o600)
  })

  it("excludes a second process and releases ownership after an ungraceful exit", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "domovoi-profile-owner-"))
    homes.push(homeDirectory)
    const deadline = OperationDeadline.start(10_000)
    const child = fork(new URL("../test-fixtures/profile-owner.mjs", import.meta.url), [homeDirectory], {
      execArgv: ["--expose-gc"], stdio: ["ignore", "ignore", "pipe", "ipc"],
      signal: deadline.signal, killSignal: "SIGKILL",
    })
    const exited = once(child, "exit", { signal: deadline.signal })
    void exited.catch(() => {})
    try {
      const messages = on(child, "message", { signal: deadline.signal })
      for await (const [message] of messages) {
        expect(message).toEqual({ state: "owned" })
        break
      }
      const constructor = vi.fn(productionDaemonDependencies.createDaemon)
      await expect(createProductionDaemonWithDependencies({ environment: {}, homeDirectory }, {
        ...productionDaemonDependencies, createDaemon: constructor,
      })).rejects.toThrow(/profile.*already.*owned/i)
      expect(constructor).not.toHaveBeenCalled()
      child.kill("SIGKILL")
      await exited
      deadline.throwIfExpired()
      const replacement = await createProductionDaemon({ environment: {}, homeDirectory })
      handles.push(replacement)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      try { await exited } finally { deadline.clear() }
    }
  }, 12_000)
})
