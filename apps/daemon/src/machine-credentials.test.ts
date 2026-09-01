import { describe, expect, it } from "vitest"

import {
  MachineCredentialStore,
  MachineCredentialUnavailableError,
} from "./machine-credentials.js"

const machineId = `machine-${"a".repeat(32)}`
const credential = "n".repeat(43)

function keyring() {
  const entries = new Map<string, string>()
  return {
    entries,
    get: (account: string) => entries.get(account),
    set: (account: string, secret: string) => {
      entries.set(account, secret)
    },
    delete: (account: string) => entries.delete(account),
  }
}

describe("MachineCredentialStore", () => {
  it("keeps a machine credential and gives it back", () => {
    const ring = keyring()
    const store = new MachineCredentialStore(ring)

    store.save(machineId, credential)

    expect(store.forMachine(machineId)).toBe(credential)
  })

  it("keeps each machine's credential apart", () => {
    const store = new MachineCredentialStore(keyring())
    const other = `machine-${"b".repeat(32)}`
    store.save(machineId, credential)
    store.save(other, "z".repeat(43))

    expect(store.forMachine(machineId)).toBe(credential)
    expect(store.forMachine(other)).toBe("z".repeat(43))
  })

  it("has nothing for a machine it was never given", () => {
    expect(new MachineCredentialStore(keyring()).forMachine(machineId)).toBeUndefined()
  })

  it("forgets a credential when a machine is dropped", () => {
    const store = new MachineCredentialStore(keyring())
    store.save(machineId, credential)

    store.forget(machineId)

    expect(store.forMachine(machineId)).toBeUndefined()
  })

  it("reports which machines it holds without revealing any credential", () => {
    const store = new MachineCredentialStore(keyring())
    store.save(machineId, credential)

    const held = store.machines()

    expect(held).toEqual([machineId])
    expect(JSON.stringify(held)).not.toContain(credential)
  })

  it("still knows its machines after the daemon restarts", () => {
    const ring = keyring()
    new MachineCredentialStore(ring).save(machineId, credential)

    const restarted = new MachineCredentialStore(ring)

    expect(restarted.machines()).toEqual([machineId])
    expect(restarted.forMachine(machineId)).toBe(credential)
  })

  it("drops a forgotten machine from the list after a restart", () => {
    const ring = keyring()
    const store = new MachineCredentialStore(ring)
    store.save(machineId, credential)
    store.forget(machineId)

    expect(new MachineCredentialStore(ring).machines()).toEqual([])
  })

  it("treats an index holding anything but machine identities as empty", () => {
    for (const stored of ['[["machine-' + "a".repeat(32) + '"]]', '[42]', '[null]', '{"a":1}']) {
      const ring = keyring()
      ring.entries.set("domovoi.machine-credential.index", stored)

      expect(new MachineCredentialStore(ring).machines()).toEqual([])
    }
  })

  it("refuses a credential that is not the issued shape", () => {
    const store = new MachineCredentialStore(keyring())

    expect(() => store.save(machineId, "short")).toThrow("Machine credential is malformed")
    expect(() => store.save(machineId, "")).toThrow("Machine credential is malformed")
  })

  it("refuses an identifier that is not a machine identity", () => {
    const store = new MachineCredentialStore(keyring())

    expect(() => store.save("laptop", credential)).toThrow("Machine identity is malformed")
  })

  it("says plainly when the keychain cannot be reached", () => {
    const store = new MachineCredentialStore({
      get: () => {
        throw new Error("no keychain")
      },
      set: () => {
        throw new Error("no keychain")
      },
      delete: () => {
        throw new Error("no keychain")
      },
    })

    expect(() => store.save(machineId, credential)).toThrow(MachineCredentialUnavailableError)
    expect(() => store.forMachine(machineId)).toThrow("OS keychain is unavailable on this machine")
  })

  it("never puts a credential in an error", () => {
    const store = new MachineCredentialStore({
      get: () => undefined,
      set: (_account: string, secret: string) => {
        throw new Error(`keychain refused ${secret}`)
      },
      delete: () => undefined,
    })

    const failure = (() => {
      try {
        store.save(machineId, credential)
        return undefined
      } catch (error) {
        return error as Error
      }
    })()

    expect(String(failure)).not.toContain(credential)
  })
})
