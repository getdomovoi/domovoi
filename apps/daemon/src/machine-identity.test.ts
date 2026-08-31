import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { loadOrCreateMachineIdentity } from "./machine-identity.js"

const scratchDirectories: string[] = []

afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true })))
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

  it("recovers from an interrupted initial write", async () => {
    const root = await scratch()
    const identityPath = join(root, "machine.json")
    await writeFile(identityPath, "")

    const identity = await loadOrCreateMachineIdentity(identityPath, { label: "workshop" })

    expect(identity.id).toMatch(/^machine-[0-9a-f]{32}$/)
    expect(JSON.parse(await readFile(identityPath, "utf8")) as { id: string }).toEqual(identity)
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
