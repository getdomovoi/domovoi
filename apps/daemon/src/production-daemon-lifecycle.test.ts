import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it, vi } from "vitest"

import { readLocalOwnerRecord } from "./local-owner-record.js"
import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"
import { claimProfile } from "./profile-lease.js"
import { createProductionDaemonWithDependencies, productionDaemonDependencies } from "./production-daemon.js"
import { waitForDaemon } from "./test-wait-for.js"

it("never releases ownership or publishes late startup until that runtime has stopped", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "domovoi-owner-lifecycle-"))
  let now = 0
  const deadline = OperationDeadline.start(30_000, { now: () => now })
  let finishStart: (value: { host: string; port: number }) => void = () => {}
  let finishStop: () => void = () => {}
  const started = new Promise<{ host: string; port: number }>((resolve) => { finishStart = resolve })
  const stopped = new Promise<void>((resolve) => { finishStop = resolve })
  const stop = vi.fn(() => stopped)
  const owner = await createProductionDaemonWithDependencies({ homeDirectory, environment: {} }, {
    ...productionDaemonDependencies,
    createDaemon: (options) => ({
      host: "127.0.0.1", requestedPort: 0, authToken: options.authToken!, start: () => started, stop,
    }),
  }, { lease: claimProfile(homeDirectory), deadline })
  const observation = OperationDeadline.start(3_000)
  try {
    const opening = owner.start()
    now = 30_001
    expect(() => deadline.throwIfExpired()).toThrow("deadline")
    await expect(beforeDeadline(opening, observation)).rejects.toThrow("deadline")
    expect(readLocalOwnerRecord(homeDirectory)?.state).toBe("stopping")
    expect(() => claimProfile(homeDirectory)).toThrow("already owned")
    expect(stop).not.toHaveBeenCalled()
    finishStart({ host: "127.0.0.1", port: 48765 })
    await beforeDeadline(waitForDaemon(() => expect(stop).toHaveBeenCalledOnce()), observation)
    expect(readLocalOwnerRecord(homeDirectory)?.state).toBe("stopping")
    expect(() => claimProfile(homeDirectory)).toThrow("already owned")
    finishStop()
    await beforeDeadline(owner.stop(), observation)
    expect(readLocalOwnerRecord(homeDirectory)?.state).toBe("none")
    claimProfile(homeDirectory).release()
  } finally {
    finishStart({ host: "127.0.0.1", port: 48765 })
    finishStop()
    await beforeDeadline(owner.stop(), observation)
    observation.clear()
    deadline.clear()
    await rm(homeDirectory, { recursive: true, force: true })
  }
})
