import { mkdtemp, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it, vi } from "vitest"

import { DomovoiDaemon } from "./server.js"
import { removeScratchDirectories } from "./test-scratch.js"

// A daemon on in-memory state has nowhere beside its state file to keep
// transfer packages, so it makes itself one under the temporary directory.
// Pointing the temporary directory at a scratch tree makes what it leaves
// behind observable without depending on what else the suite is running.
const temporary = vi.hoisted(() => ({ root: undefined as string | undefined }))
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  return { ...actual, tmpdir: () => temporary.root ?? actual.tmpdir() }
})

const scratchDirectories: string[] = []
const daemons: DomovoiDaemon[] = []

afterEach(async () => {
  temporary.root = undefined
  const stops = await Promise.allSettled(daemons.splice(0).map((daemon) => daemon.stop()))
  const failures = stops.flatMap((stop) => stop.status === "rejected" ? [stop.reason] : [])
  try { await removeScratchDirectories(scratchDirectories) } catch (error) { failures.push(error) }
  if (failures.length > 0) throw new AggregateError(failures, "Cleanup failed")
})

async function transferRoots(): Promise<string[]> {
  return (await readdir(temporary.root!))
    .filter((entry) => entry.startsWith("domovoi-transfer-transactions-"))
}

it("removes the temporary transfer root it created for in-memory state", async () => {
  const root = await mkdtemp(join(tmpdir(), "domovoi-transfer-root-"))
  scratchDirectories.push(root)
  temporary.root = root
  const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:", errorSink: () => {} })
  daemons.push(daemon)

  await daemon.start()
  expect(await transferRoots()).toHaveLength(1)

  await daemon.stop()

  // A daemon that made this directory owns it. Leaving it behind fills a
  // memory backed temporary filesystem one test run at a time.
  expect(await transferRoots()).toEqual([])
})
