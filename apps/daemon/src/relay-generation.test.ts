import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { publishFileDurably } from "@getdomovoi/credential-store"
import { afterEach, expect, it } from "vitest"

import { openRelayGeneration, type RelayGeneration } from "./relay-generation.js"
import { removeScratchDirectories } from "./test-scratch.js"

const roots: string[] = []
const stores: RelayGeneration[] = []
const binding = "a".repeat(64)
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await removeScratchDirectories(roots)
})
async function fixture(floor = 0) {
  const directory = await mkdtemp(join(tmpdir(), "domovoi-relay-generation-"))
  roots.push(directory)
  const path = join(directory, "relay-generation.json")
  await writeFile(path, JSON.stringify({ version: 1, binding, generation: floor }), { mode: 0o600 })
  return path
}
function open(path: string, publish = publishFileDurably) {
  const store = openRelayGeneration(path, binding, publish)
  stores.push(store)
  return store
}

it("durably reserves a strictly newer generation before returning, including concurrent calls and restart", async () => {
  const path = await fixture()
  const first = open(path)
  expect(await Promise.all([first.next(), first.next()])).toEqual([1, 2])
  expect(JSON.parse(await readFile(path, "utf8")).generation).toBe(2)
  await first.close()
  const second = open(path)
  expect(await second.next()).toBe(3)
  await second.close()
  await expect(second.next()).rejects.toThrow()
})

it("refuses a simultaneous owner, changed binding, missing state, corruption and exhaustion", async () => {
  const path = await fixture(Number.MAX_SAFE_INTEGER)
  const store = open(path)
  expect(() => open(path)).toThrow()
  await expect(store.next()).rejects.toThrow()
  await store.close()
  expect(() => openRelayGeneration(path, "b".repeat(64))).toThrow()
  expect(() => open(path + ".missing")).toThrow()
  await writeFile(path, "{}")
  expect(() => open(path)).toThrow()
})

it("never returns an uncertain publication, poisons that owner, and skips its visible generation after restart", async () => {
  const path = await fixture()
  const store = open(path, async (staging, destination) => {
    await publishFileDurably(staging, destination)
    throw new Error("fixture directory flush failed after rename")
  })
  await expect(store.next()).rejects.toThrow()
  await expect(store.next()).rejects.toThrow()
  await store.close()
  expect(await open(path).next()).toBe(2)
})
