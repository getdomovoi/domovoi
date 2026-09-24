import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it, vi } from "vitest"

import { MachineCredentialStore } from "./machine-credentials.js"
import {
  createProductionDaemonWithDependencies,
  productionDaemonDependencies,
  type ProductionDaemonHandle,
} from "./production-daemon.js"
import { claimProfile, ProfileAlreadyOwnedError } from "./profile-lease.js"
import type { DaemonServerOptions } from "./server.js"
import { asyncTestCredentials } from "./test-machine-credentials.js"
import { removeScratchDirectories } from "./test-scratch.js"

const roots: string[] = []
const running: ProductionDaemonHandle[] = []
afterEach(async () => {
  await Promise.allSettled(running.splice(0).map((daemon) => daemon.stop()))
  await removeScratchDirectories(roots)
})

// The store reads the stored protocol version, and may move damaged state aside,
// in its constructor. Only the process holding the profile lease may do that, so
// no other daemon can be writing the file while it is read.
it("constructs the daemon, and with it the state store, only while holding the profile lease", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "domovoi-store-lease-"))
  roots.push(homeDirectory)
  let leaseHeld: boolean | undefined
  const createDaemon = vi.fn((options: DaemonServerOptions) => {
    try {
      claimProfile(homeDirectory).release()
      leaseHeld = false
    } catch (error) {
      leaseHeld = error instanceof ProfileAlreadyOwnedError
    }
    return {
      host: options.host ?? "127.0.0.1",
      requestedPort: options.port ?? 0,
      authToken: options.authToken!,
      start: async () => ({ host: "127.0.0.1", port: 49_201 }),
      stop: async () => {},
    }
  })
  const handle = await createProductionDaemonWithDependencies({ homeDirectory, environment: { DOMOVOI_PORT: "0" } }, {
    ...productionDaemonDependencies,
    createMachineCredentials: () => asyncTestCredentials(new MachineCredentialStore({ get: () => undefined, set: () => {}, delete: () => {} })),
    createDaemon,
  })
  expect(createDaemon).toHaveBeenCalledOnce()
  expect(leaseHeld).toBe(true)
  // The probe above can tell: once the daemon stops and releases the lease,
  // the same claim succeeds.
  await handle.stop()
  expect(() => claimProfile(homeDirectory).release()).not.toThrow()
})
