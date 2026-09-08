import { describe, expect, it } from "vitest"

import {
  browserDeviceLabel,
  clearDaemonSession,
  daemonSessionFrom,
  forgetSupersededCredential,
  isDaemonCredential,
  loadDaemonSession,
  saveDaemonSession,
} from "./credential"
import { BrowserCapabilityError } from "./platform-refusals"

const deviceId = `device-${"a1b2c3d4".repeat(4)}`
const token = "x".repeat(43)

class MemoryStorage implements Pick<Storage, "getItem" | "removeItem" | "setItem"> {
  readonly values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

class BlockedStorage implements Pick<Storage, "getItem" | "removeItem" | "setItem"> {
  getItem(): never { throw new Error("storage blocked") }
  removeItem(): never { throw new Error("storage blocked") }
  setItem(): never { throw new Error("storage blocked") }
}

describe("browser daemon session", () => {
  it("keeps only the paired device credential for this tab", () => {
    const storage = new MemoryStorage()

    saveDaemonSession(storage, { deviceId, token })

    expect([...storage.values.keys()]).toEqual(["domovoi.daemon-session"])
    expect(loadDaemonSession(storage)).toEqual({ deviceId, token })
  })

  it("drops a root bearer an earlier build parked in this tab", () => {
    const storage = new MemoryStorage()
    storage.setItem("domovoi.daemon-credential", token)
    saveDaemonSession(storage, { deviceId, token })

    forgetSupersededCredential(storage)

    expect(storage.getItem("domovoi.daemon-credential")).toBeNull()
    expect(loadDaemonSession(storage)).toEqual({ deviceId, token })
  })

  it("forgets both the device credential and any older bearer", () => {
    const storage = new MemoryStorage()
    storage.setItem("domovoi.daemon-credential", token)
    saveDaemonSession(storage, { deviceId, token })

    clearDaemonSession(storage)

    expect([...storage.values.keys()]).toEqual([])
    expect(loadDaemonSession(storage)).toBeUndefined()
  })

  it("refuses a stored value that is not this build's device session", () => {
    const storage = new MemoryStorage()

    expect(loadDaemonSession(storage)).toBeUndefined()
    storage.setItem("domovoi.daemon-session", "not-json")
    expect(loadDaemonSession(storage)).toBeUndefined()
    storage.setItem("domovoi.daemon-session", '"a string"')
    expect(loadDaemonSession(storage)).toBeUndefined()
    storage.setItem("domovoi.daemon-session", "null")
    expect(loadDaemonSession(storage)).toBeUndefined()
    storage.setItem("domovoi.daemon-session", JSON.stringify({ deviceId: "device-nope", token }))
    expect(loadDaemonSession(storage)).toBeUndefined()
    storage.setItem("domovoi.daemon-session", JSON.stringify({ deviceId, token: "short" }))
    expect(loadDaemonSession(storage)).toBeUndefined()
  })

  it("names blocked storage instead of losing the credential quietly", () => {
    const storage = new BlockedStorage()

    expect(loadDaemonSession(storage)).toBeUndefined()
    expect(() => forgetSupersededCredential(storage)).not.toThrow()
    expect(() => saveDaemonSession(storage, { deviceId, token })).toThrow(BrowserCapabilityError)
    expect(() => saveDaemonSession(storage, { deviceId, token })).toThrow(
      "This browser blocked session storage, so Domovoi cannot hold a daemon credential for this tab.",
    )
    expect(() => clearDaemonSession(storage)).toThrow(BrowserCapabilityError)
  })

  it("reads a device credential only out of a device.pair result", () => {
    const device = {
      id: deviceId,
      label: "Web browser 4f2a1c9d",
      pairedAt: "2026-09-05T09:00:00.000Z",
      binding: { kind: "client", client: "web" },
    }

    expect(daemonSessionFrom({ device, token })).toEqual({ deviceId, token })
    expect(() => daemonSessionFrom({ device })).toThrow(
      "The daemon did not return a device credential for this browser",
    )
    expect(() => daemonSessionFrom({ device, token, extra: 1 })).toThrow(
      "The daemon did not return a device credential for this browser",
    )
  })

  it("names the client kind in the label the daemon's device list shows", () => {
    expect(browserDeviceLabel("web", "4f2a1c9d")).toBe("Web browser 4f2a1c9d")
    expect(browserDeviceLabel("tablet", "4f2a1c9d")).toBe("Tablet browser 4f2a1c9d")
    expect(browserDeviceLabel("phone", "4f2a1c9d")).toBe("Phone browser 4f2a1c9d")
    expect(browserDeviceLabel("desktop", "4f2a1c9d")).toBe("Desktop browser 4f2a1c9d")
    expect(browserDeviceLabel("cli", "4f2a1c9d")).toBe("Command line browser 4f2a1c9d")
  })

  it("recognises only the daemon's credential shape", () => {
    expect(isDaemonCredential(token)).toBe(true)
    expect(isDaemonCredential(`${token}x`)).toBe(false)
    expect(isDaemonCredential("")).toBe(false)
  })
})
