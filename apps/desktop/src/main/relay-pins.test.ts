import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createRelayPinFile, relayPinFileName, relayPinKeyPattern } from "./relay-pins.js"

const synced = vi.hoisted(() => ({ refuse: false, refuseClose: false, calls: [] as string[] }))
const renamed = vi.hoisted(() => ({ refuse: false }))
const unlinked = vi.hoisted(() => ({ refuse: false }))
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (renamed.refuse) throw Object.assign(new Error("injected rename refusal"), { code: "EACCES" })
      return actual.rename(...args)
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (unlinked.refuse) throw Object.assign(new Error("injected unlink refusal"), { code: "EPERM" })
      return actual.unlink(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      return new Proxy(handle, {
        get(target, name) {
          if (name === "sync" || name === "datasync") {
            return async () => {
              synced.calls.push(String(args[0]))
              if (synced.refuse) throw new Error("injected file sync refusal")
              return (target[name as "sync"] as () => Promise<void>).call(target)
            }
          }
          if (name === "close" && synced.refuseClose) {
            return async () => { await target.close(); throw new Error("injected close refusal") }
          }
          const value = Reflect.get(target, name, target)
          return typeof value === "function" ? value.bind(target) : value
        },
      })
    },
  }
})

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "domovoi-relay-pins-")); synced.refuse = false; synced.refuseClose = false; synced.calls.length = 0; renamed.refuse = false; unlinked.refuse = false })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const key = `domovoi.daemon.relayPin.machine-${"a".repeat(32)}`
const other = `domovoi.daemon.relayPin.machine-${"b".repeat(32)}`

describe("desktop relay pin file", () => {
  it("reads nothing before the first swap and reads back what was swapped in", async () => {
    const pins = createRelayPinFile(join(root, relayPinFileName))
    expect(await pins.read(key)).toBeUndefined()
    expect(await pins.compareAndSwap(key, undefined, "{\"version\":1}")).toBe(true)
    expect(await pins.read(key)).toBe("{\"version\":1}")
    expect(await createRelayPinFile(join(root, relayPinFileName)).read(key)).toBe("{\"version\":1}")
  })

  it("refuses a swap whose expected bytes are not what the file holds", async () => {
    const pins = createRelayPinFile(join(root, relayPinFileName))
    expect(await pins.compareAndSwap(key, "stale", "next")).toBe(false)
    expect(await pins.read(key)).toBeUndefined()
    await pins.compareAndSwap(key, undefined, "one")
    expect(await pins.compareAndSwap(key, undefined, "two")).toBe(false)
    expect(await pins.compareAndSwap(key, "one", "two")).toBe(true)
    expect(await pins.read(key)).toBe("two")
  })

  it("keeps the file private and replaces it whole, never half-written", async () => {
    const path = join(root, relayPinFileName)
    const pins = createRelayPinFile(path)
    await pins.compareAndSwap(key, undefined, "one")
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600)
    const results = await Promise.all([pins.compareAndSwap(key, "one", "two"), pins.compareAndSwap(other, undefined, "three")])
    expect(results).toEqual([true, true])
    const parsed = JSON.parse(await readFile(path, "utf8")) as { version: number; pins: Record<string, string> }
    expect(parsed).toEqual({ version: 1, pins: { [key]: "two", [other]: "three" } })
  })

  it("syncs the temporary file and its directory, and refuses the swap when a sync fails", async () => {
    const path = join(root, relayPinFileName)
    const pins = createRelayPinFile(path)
    await pins.compareAndSwap(key, undefined, "one")
    expect(synced.calls.some((target) => target.endsWith(".tmp"))).toBe(true)
    if (process.platform !== "win32") expect(synced.calls).toContain(root)
    synced.refuse = true
    await expect(pins.compareAndSwap(key, "one", "two")).rejects.toThrow("injected file sync refusal")
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, pins: { [key]: "one" } })
    expect(await readdir(root)).toEqual([relayPinFileName])
  })

  it("reports the sync failure first when closing the file fails as well", async () => {
    const pins = createRelayPinFile(join(root, relayPinFileName))
    synced.refuse = true
    synced.refuseClose = true
    const outcome = await pins.compareAndSwap(key, undefined, "one").then(() => undefined, (error: unknown) => error as AggregateError)
    expect(outcome?.message).toBe("injected file sync refusal; closing the file also failed: injected close refusal")
    expect(outcome?.errors.map((error: Error) => error.message)).toEqual(["injected file sync refusal", "injected close refusal"])
    expect(outcome?.cause).toBe(outcome?.errors[0])
    expect(await readdir(root)).toEqual([])
  })

  it("removes the temporary file when the rename fails, and keeps a cleanup failure beside the cause", async () => {
    const path = join(root, relayPinFileName)
    const pins = createRelayPinFile(path)
    await pins.compareAndSwap(key, undefined, "one")
    renamed.refuse = true
    await expect(pins.compareAndSwap(key, "one", "two")).rejects.toThrow("injected rename refusal")
    expect(await readdir(root)).toEqual([relayPinFileName])
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, pins: { [key]: "one" } })
    unlinked.refuse = true
    const outcome = await pins.compareAndSwap(key, "one", "two").then(() => undefined, (error: unknown) => error as AggregateError)
    expect(outcome?.errors.map((error: Error) => error.message)).toEqual(["injected rename refusal", "injected unlink refusal"])
    expect(outcome?.message).toBe("injected rename refusal; removing the temporary file also failed: injected unlink refusal")
  })

  it("refuses a key or value outside the shape the renderer may use", async () => {
    const pins = createRelayPinFile(join(root, relayPinFileName))
    await expect(pins.compareAndSwap("domovoi.something.else", undefined, "x")).rejects.toThrow(/relay pin key/)
    await expect(pins.read("../etc/passwd")).rejects.toThrow(/relay pin key/)
    await expect(pins.compareAndSwap(key, undefined, "x".repeat(8_193))).rejects.toThrow(/relay pin value/)
    await expect(pins.compareAndSwap(key, "", "x")).rejects.toThrow(/relay pin value/)
    expect(relayPinKeyPattern.test(key)).toBe(true)
  })

  it("refuses a damaged file on read and on swap, and leaves its bytes alone", async () => {
    const path = join(root, relayPinFileName)
    const pins = createRelayPinFile(path)
    await pins.compareAndSwap(key, undefined, "kept")
    const damaged = `${await readFile(path, "utf8")}broken`
    await writeFile(path, damaged)
    await expect(pins.read(key)).rejects.toThrow(/not readable/)
    await expect(pins.compareAndSwap(key, undefined, "fresh")).rejects.toThrow(/not readable/)
    expect(await readFile(path, "utf8")).toBe(damaged)
  })

  it("refuses a file version it does not read without deleting its records", async () => {
    const path = join(root, relayPinFileName)
    const bytes = JSON.stringify({ version: 2, pins: { [key]: "future" } })
    await writeFile(path, bytes)
    const pins = createRelayPinFile(path)
    await expect(pins.read(key)).rejects.toThrow(/version/)
    await expect(pins.compareAndSwap(other, undefined, "x")).rejects.toThrow(/version/)
    expect(await readFile(path, "utf8")).toBe(bytes)
  })

  it("refuses a file holding a key or value outside the shape it writes", async () => {
    const path = join(root, relayPinFileName)
    for (const pins of [{ "domovoi.other": "x" }, { [key]: 7 }, []]) {
      const bytes = JSON.stringify({ version: 1, pins })
      await writeFile(path, bytes)
      const file = createRelayPinFile(path)
      await expect(file.read(key)).rejects.toThrow(/not readable/)
      await expect(file.compareAndSwap(key, undefined, "x")).rejects.toThrow(/not readable/)
      expect(await readFile(path, "utf8")).toBe(bytes)
    }
  })
})
