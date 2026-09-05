import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { OperationDeadline } from "../operation-deadline.js"
import { claimProfile } from "../profile-lease.js"
import { createServiceConfiguration } from "./configuration.js"
import { withinServiceDeadline } from "./deadline.js"
import { installService, nodeServiceEffects, removeService, serviceStatus } from "./install.js"

const budget = process.platform === "win32" ? 30_000 : 10_000
const cleanupBudget = 5_000

function latch() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

describe("service command exclusion", () => {
  it.each([
    ["install", "install"], ["install", "remove"], ["install", "status"],
    ["remove", "install"], ["remove", "remove"], ["remove", "status"],
  ] as const)("refuses %s overlapping %s before a second manager call or file change", async (first, second) => {
    const deadline = OperationDeadline.start(budget)
    const within = <T>(operation: () => Promise<T>) => withinServiceDeadline(deadline, operation)
    const home = await within(() => mkdtemp(join(tmpdir(), "domovoi-service-overlap-")))
    const entered = latch()
    const resume = latch()
    const node = nodeServiceEffects({ userHomeDirectory: home })
    const target = {
      platform: "linux", home, execPath: "/usr/local/bin/domovoid",
      configuration: createServiceConfiguration({}, {
        homeDirectory: home, platform: process.platform, workingDirectory: home,
      }),
    }
    let pending: Promise<unknown> | undefined
    try {
      // Real publication, digest snapshots and profile claims. Only the native
      // manager is simulated, so no service belonging to the tester is touched.
      await within(() => installService(target, { ...node, run: async () => {} }))
      const running = {
        ...node,
        run: async (_command: string, _args: string[], active: OperationDeadline) => {
          entered.release()
          await withinServiceDeadline(active, () => resume.promise)
        },
      }
      pending = first === "install" ? installService(target, running) : removeService(target, running)
      void pending.catch(() => {})
      await within(() => entered.promise)

      // The daemon must be able to acquire its separate runtime lease while
      // the service command is waiting on the manager to start it.
      const profile = claimProfile(home)
      profile.release()
      const contender = {
        ...nodeServiceEffects({ userHomeDirectory: home }),
        run: vi.fn(async () => {}),
        capture: vi.fn(async () => ({ code: 0, stdout: "active" })),
        write: vi.fn(node.write), remove: vi.fn(node.remove),
        exists: vi.fn(node.exists), removalSnapshot: vi.fn(node.removalSnapshot),
      }
      await expect(within(() => second === "install" ? installService(target, contender)
        : second === "remove" ? removeService(target, contender) : serviceStatus(target, contender)))
        .rejects.toThrow(/Another Domovoi service operation/)
      for (const operation of [contender.run, contender.capture, contender.write, contender.remove, contender.exists, contender.removalSnapshot]) {
        expect(operation).not.toHaveBeenCalled()
      }

      resume.release()
      await within(() => pending!)
      // Completion releases the operation lease, rather than leaving a busy
      // marker whose age somebody later guesses from timestamps.
      await within(() => serviceStatus(target, contender))
      expect(contender.capture).toHaveBeenCalledOnce()
    } finally {
      resume.release()
      deadline.clear()
      const cleanup = OperationDeadline.start(cleanupBudget)
      try {
        if (pending) await withinServiceDeadline(cleanup, () => pending!.catch(() => {}))
        await withinServiceDeadline(cleanup, () => rm(home, { recursive: true, force: true }))
      } finally { cleanup.clear() }
    }
  }, budget + cleanupBudget + 1_000)
})
