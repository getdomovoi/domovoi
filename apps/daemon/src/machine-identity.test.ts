import { mkdtemp, readdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { removeScratchDirectories } from "./test-scratch.js"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { loadOrCreateMachineIdentity, publishMachineIdentity } from "./machine-identity.js"

const scratchDirectories: string[] = []

afterEach(async () => {
  await removeScratchDirectories(scratchDirectories.splice(0))
})

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "domovoi-machine-identity-"))
  scratchDirectories.push(directory)
  return directory
}

describe("loadOrCreateMachineIdentity", () => {
  it("creates a high-entropy private identity and reuses it", async () => {
    const root = await scratch()
    const identityPath = join(root, "state", "machine.json")

    const created = await loadOrCreateMachineIdentity(identityPath, { label: "workshop" })
    const reused = await loadOrCreateMachineIdentity(identityPath, { label: "workshop" })

    expect(created.id).toMatch(/^machine-[0-9a-f]{32}$/)
    expect(created.label).toBe("workshop")
    expect(reused).toEqual(created)
    if (process.platform !== "win32") {
      expect((await stat(join(root, "state"))).mode & 0o777).toBe(0o700)
      expect((await stat(identityPath)).mode & 0o777).toBe(0o600)
    }
  })

  it("keeps the stored identity when the host label changes", async () => {
    const root = await scratch()
    const identityPath = join(root, "machine.json")

    const created = await loadOrCreateMachineIdentity(identityPath, { label: "old-hostname" })
    const renamed = await loadOrCreateMachineIdentity(identityPath, { label: "new-hostname" })

    expect(renamed).toEqual(created)
  })

  it("gives separate state directories separate identities", async () => {
    const first = await loadOrCreateMachineIdentity(join(await scratch(), "machine.json"), {
      label: "workshop",
    })
    const second = await loadOrCreateMachineIdentity(join(await scratch(), "machine.json"), {
      label: "workshop",
    })

    expect(second.id).not.toBe(first.id)
  })

  it.each([
    ["not json", "{"],
    ["a missing id", JSON.stringify({ label: "workshop" })],
    ["an unrecognized id", JSON.stringify({ id: "machine-nope", label: "workshop" })],
    ["a blank label", JSON.stringify({ id: `machine-${"a".repeat(32)}`, label: "  " })],
  ])("rejects a stored identity with %s", async (_case, contents) => {
    const identityPath = join(await scratch(), "machine.json")
    await writeFile(identityPath, contents)

    await expect(loadOrCreateMachineIdentity(identityPath, { label: "workshop" })).rejects.toThrow(
      "Machine identity is malformed",
    )
  })

  it("refuses to replace an interrupted initial write without operator recovery", async () => {
    const root = await scratch()
    const identityPath = join(root, "machine.json")
    await writeFile(identityPath, "")

    await expect(loadOrCreateMachineIdentity(identityPath, { label: "workshop" }))
      .rejects.toThrow("Remove it explicitly before restarting Domovoi")

    expect(await readFile(identityPath, "utf8")).toBe("")
  })

  it("leaves no partial file behind after creating an identity", async () => {
    const root = await scratch()
    const identityPath = join(root, "machine.json")

    await loadOrCreateMachineIdentity(identityPath, { label: "workshop" })

    expect(await readdir(root)).toEqual(["machine.json"])
  })

  it("returns one identity to concurrent daemon starts", async () => {
    const identityPath = join(await scratch(), "machine.json")

    const identities = await Promise.all([
      loadOrCreateMachineIdentity(identityPath, { label: "workshop" }),
      loadOrCreateMachineIdentity(identityPath, { label: "workshop" }),
      loadOrCreateMachineIdentity(identityPath, { label: "workshop" }),
    ])

    expect(new Set(identities.map((identity) => identity.id)).size).toBe(1)
    const stored = JSON.parse(await readFile(identityPath, "utf8")) as { id: string }
    expect(stored.id).toBe(identities[0]!.id)
  })

  it("publishes one winner without overwriting it when claims overlap", async () => {
    const identityPath = join(await scratch(), "machine.json")
    const candidates = Array.from({ length: 8 }, (_, index) => ({
      id: `machine-${index.toString(16).padStart(32, "0")}`,
      label: `candidate-${index}`,
    }))

    const published = await Promise.all(candidates.map(
      (identity) => publishMachineIdentity(identityPath, identity),
    ))

    expect(new Set(published.map((identity) => identity.id)).size).toBe(1)
    expect(JSON.parse(await readFile(identityPath, "utf8"))).toEqual(published[0])
  })

  it("never deletes an interrupted empty identity to publish a winner", async () => {
    const identityPath = join(await scratch(), "machine.json")
    await writeFile(identityPath, "")
    const candidates = Array.from({ length: 8 }, (_, index) => ({
      id: `machine-${index.toString(16).padStart(32, "0")}`,
      label: `candidate-${index}`,
    }))

    const attempts = await Promise.allSettled(candidates.map(
      (identity) => publishMachineIdentity(identityPath, identity),
    ))

    expect(attempts.every((attempt) => attempt.status === "rejected")).toBe(true)
    expect(attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringContaining("Remove it explicitly"),
        }),
      }),
    ]))
    expect(await readFile(identityPath, "utf8")).toBe("")
  })

  it("keeps no-clobber publication when the filesystem rejects hard links", async () => {
    const identityPath = join(await scratch(), "machine.json")
    const candidates = Array.from({ length: 8 }, (_, index) => ({
      id: `machine-${index.toString(16).padStart(32, "0")}`,
      label: `candidate-${index}`,
    }))
    const hardLinkUnavailable = async () => {
      throw Object.assign(new Error("Hard links unsupported"), { code: "ENOTSUP" })
    }

    const published = await Promise.all(candidates.map(
      (identity) => publishMachineIdentity(identityPath, identity, hardLinkUnavailable),
    ))

    expect(new Set(published.map((identity) => identity.id)).size).toBe(1)
    expect(JSON.parse(await readFile(identityPath, "utf8"))).toEqual(published[0])
  })

  it("retries a busy winner while adopting an existing publication", async () => {
    const identityPath = join(await scratch(), "machine.json")
    const candidate = { id: `machine-${"a".repeat(32)}`, label: "candidate" }
    const winner = { id: `machine-${"b".repeat(32)}`, label: "winner" }
    const alreadyPublished = async () => {
      throw Object.assign(new Error("Already published"), { code: "EEXIST" })
    }
    let reads = 0
    const readPublished = async () => {
      reads += 1
      if (reads === 1) {
        throw Object.assign(new Error("Winner is still closing"), { code: "EBUSY" })
      }
      return winner
    }

    await expect(publishMachineIdentity(
      identityPath,
      candidate,
      alreadyPublished,
      readPublished,
    )).resolves.toEqual(winner)
    expect(reads).toBe(2)
  })

  it("waits for the identity published by the start that claimed initialization", async () => {
    const root = await scratch()
    const identityPath = join(root, "machine.json")
    await writeFile(`${identityPath}.lock`, "")
    const published = { id: `machine-${"c".repeat(32)}`, label: "claimed" }

    const pending = loadOrCreateMachineIdentity(identityPath, { label: "second-start" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await writeFile(`${identityPath}.publish`, `${JSON.stringify(published)}\n`)
    await rename(`${identityPath}.publish`, identityPath)

    await expect(pending).resolves.toEqual(published)
  })

  it("keeps waiting while the claiming start is still alive", async () => {
    const root = await scratch()
    const identityPath = join(root, "machine.json")
    await writeFile(`${identityPath}.lock`, "")
    const published = { id: `machine-${"d".repeat(32)}`, label: "claimed" }

    const pending = loadOrCreateMachineIdentity(identityPath, {
      label: "second-start",
      lockStalenessMs: 2_000,
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    await writeFile(`${identityPath}.publish`, `${JSON.stringify(published)}\n`)
    await rename(`${identityPath}.publish`, identityPath)

    await expect(pending).resolves.toEqual(published)
  })

  it("takes over an abandoned initialization claim", async () => {
    const root = await scratch()
    const identityPath = join(root, "machine.json")
    await writeFile(`${identityPath}.lock`, "")

    const identity = await loadOrCreateMachineIdentity(identityPath, {
      label: "workshop",
      lockStalenessMs: 0,
    })

    expect(identity.id).toMatch(/^machine-[0-9a-f]{32}$/)
    expect(await readdir(root)).toEqual(["machine.json"])
  })

  it("gives repeated concurrent starts one identity", async () => {
    for (let round = 0; round < 20; round += 1) {
      const identityPath = join(await scratch(), "machine.json")
      const identities = await Promise.all([
        loadOrCreateMachineIdentity(identityPath, { label: "workshop" }),
        loadOrCreateMachineIdentity(identityPath, { label: "workshop" }),
        loadOrCreateMachineIdentity(identityPath, { label: "workshop" }),
      ])
      expect(new Set(identities.map((identity) => identity.id)).size).toBe(1)
    }
  })

  it("falls back to a bounded label when the host name is unusable", async () => {
    const identityPath = join(await scratch(), "machine.json")

    const identity = await loadOrCreateMachineIdentity(identityPath, { label: "   " })

    expect(identity.label).toBe("domovoi-machine")
  })

  it("bounds an overlong host label", async () => {
    const identityPath = join(await scratch(), "machine.json")

    const identity = await loadOrCreateMachineIdentity(identityPath, { label: "n".repeat(400) })

    expect(identity.label).toBe("n".repeat(128))
  })
})
