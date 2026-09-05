import { describe, expect, it, vi } from "vitest"

import { runFleetKeychainCommand } from "./fleet-keychain-command.js"
import { MachineCredentialStore } from "./machine-credentials.js"

function fixture(count = 513) {
  const values = new Map<string, string>()
  const credentials = new MachineCredentialStore({
    get: (id) => values.get(id), set: (id, value) => { values.set(id, value) }, delete: (id) => values.delete(id),
  })
  const ids = Array.from({ length: count }, (_, index) => `machine-${index.toString(16).padStart(32, "0")}`)
  for (const id of ids) credentials.save(id, "n".repeat(43))
  const stdout = vi.fn(), stderr = vi.fn()
  return { credentials, ids, stdout, stderr }
}

describe("local fleet keychain recovery", () => {
  it("lists the complete native index beyond the wire cap without reading credential bytes", () => {
    const f = fixture()
    const readSecret = vi.spyOn(f.credentials, "forMachine")
    expect(runFleetKeychainCommand(["fleet-keychain", "list"], f)).toBe(0)
    const lines = f.stdout.mock.calls.flat().join("").trim().split("\n")
    expect(lines).toEqual(f.ids)
    expect(readSecret).not.toHaveBeenCalled()
    expect(lines.join("\n")).not.toContain("n".repeat(43))
  })

  it("requires a stopped-daemon confirmation before removing only the named local key and index entry", () => {
    const f = fixture(2)
    expect(runFleetKeychainCommand(["fleet-keychain", "forget", f.ids[0]!], f)).toBe(1)
    expect(f.credentials.forMachine(f.ids[0]!)).toBe("n".repeat(43))
    expect(runFleetKeychainCommand(["fleet-keychain", "forget", f.ids[0]!, "--confirm-daemon-stopped"], f)).toBe(0)
    expect(f.credentials.forMachine(f.ids[0]!)).toBeUndefined()
    expect(f.credentials.forMachine(f.ids[1]!)).toBe("n".repeat(43))
    expect(f.credentials.machines()).toEqual([f.ids[1]])
    expect(f.stdout.mock.calls.flat().join("")).toContain("Remote revocation is unconfirmed")
    expect(f.stdout.mock.calls.flat().join("")).toContain("target's Devices list")
  })

  it("refuses invalid identities and never echoes argv or keychain error secrets", () => {
    const f = fixture(1)
    const remove = vi.spyOn(f.credentials, "forget")
    expect(runFleetKeychainCommand(["fleet-keychain", "forget", "token=do-not-print", "--confirm-daemon-stopped"], f)).toBe(1)
    expect(remove).not.toHaveBeenCalled()
    vi.spyOn(f.credentials, "machines").mockImplementation(() => { throw new Error("token=do-not-print") })
    expect(runFleetKeychainCommand(["fleet-keychain", "list"], f)).toBe(1)
    expect(JSON.stringify([...f.stdout.mock.calls, ...f.stderr.mock.calls])).not.toContain("do-not-print")
  })

  it("does not claim removal when keychain readback still finds the credential", () => {
    const f = fixture(1)
    vi.spyOn(f.credentials, "forget").mockImplementation(() => {})
    expect(runFleetKeychainCommand(["fleet-keychain", "forget", f.ids[0]!, "--confirm-daemon-stopped"], f)).toBe(1)
    expect(f.stdout).not.toHaveBeenCalled()
    expect(f.stderr.mock.calls.flat().join("")).toContain("did not complete")
  })
})
