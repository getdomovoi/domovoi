import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createRelayPinFile, relayPinFileName, relayPinKeyPattern } from "./relay-pins.js"

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "domovoi-relay-pins-")) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const key = `domovoi.daemon.relayPin.machine-${"a".repeat(32)}`

describe("desktop relay pin file", () => {
  it("reads nothing before the first write and reads back what was written", async () => {
    const pins = createRelayPinFile(join(root, relayPinFileName))
    expect(await pins.read(key)).toBeUndefined()
    await pins.write(key, "{\"version\":1}")
    expect(await pins.read(key)).toBe("{\"version\":1}")
    expect(await createRelayPinFile(join(root, relayPinFileName)).read(key)).toBe("{\"version\":1}")
  })

  it("keeps the file private and replaces it whole, never half-written", async () => {
    const path = join(root, relayPinFileName)
    const pins = createRelayPinFile(path)
    await pins.write(key, "one")
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600)
    const other = `domovoi.daemon.relayPin.machine-${"b".repeat(32)}`
    await Promise.all([pins.write(key, "two"), pins.write(other, "three")])
    const parsed = JSON.parse(await readFile(path, "utf8")) as { version: number; pins: Record<string, string> }
    expect(parsed).toEqual({ version: 1, pins: { [key]: "two", [other]: "three" } })
  })

  it("refuses a key or value outside the shape the renderer may use", async () => {
    const pins = createRelayPinFile(join(root, relayPinFileName))
    await expect(pins.write("domovoi.something.else", "x")).rejects.toThrow(/relay pin key/)
    await expect(pins.read("../etc/passwd")).rejects.toThrow(/relay pin key/)
    await expect(pins.write(key, "x".repeat(8_193))).rejects.toThrow(/relay pin value/)
    expect(relayPinKeyPattern.test(key)).toBe(true)
  })

  it("treats an unreadable file as empty rather than throwing at read, and overwrites it on write", async () => {
    const path = join(root, relayPinFileName)
    await writeFile(path, "{not json")
    const pins = createRelayPinFile(path)
    expect(await pins.read(key)).toBeUndefined()
    await pins.write(key, "fresh")
    expect(await pins.read(key)).toBe("fresh")
  })
})
