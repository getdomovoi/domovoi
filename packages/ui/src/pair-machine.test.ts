import { describe, expect, it, vi } from "vitest"

import { pairMachine, MachinePairingError } from "./pair-machine.js"

const code = "hearth-quiet-ember-42"
const credential = "n".repeat(43)
const machineId = `machine-${"c".repeat(32)}`
const device = {
  id: `device-${"a".repeat(32)}`,
  label: "studio-ipad",
  pairedAt: "2026-08-31T12:00:00.000Z",
}

function pairing(overrides: {
  identify?: (input: { endpoint: string; credential: string }) => Promise<{ id: string; name: string }>
  saveCredential?: (input: { machineId: string; credential: string }) => Promise<void>
} = {}) {
  const saved: { machineId: string; credential: string }[] = []
  return {
    saved,
    open: vi.fn(async () => ({
      call: async () => ({ device, token: credential }),
      close: () => {},
    })),
    identify: overrides.identify
      ?? vi.fn(async () => ({ id: machineId, name: "workshop" })),
    saveCredential: overrides.saveCredential
      ?? vi.fn(async (input: { machineId: string; credential: string }) => {
        saved.push(input)
      }),
  }
}

const request = { endpoint: "wss://workshop.tailnet:47831/rpc", code, label: "studio-ipad" }

describe("pairMachine", () => {
  it("saves the claimed credential for the identity the machine reports", async () => {
    const io = pairing()

    const paired = await pairMachine({ request, ...io })

    expect(io.saved).toEqual([{ machineId, credential }])
    expect(paired).toEqual({ machineId, label: "workshop" })
    expect(io.identify).toHaveBeenCalledWith({ endpoint: request.endpoint, credential })
  })

  it("refuses to save a credential for an identity the protocol does not describe", async () => {
    const io = pairing({ identify: vi.fn(async () => ({ id: "machine-nonsense", name: "workshop" })) })

    await expect(pairMachine({ request, ...io })).rejects.toThrow(MachinePairingError)
    expect(io.saved).toEqual([])
  })

  it("never quotes the credential when saving it fails", async () => {
    const io = pairing({
      saveCredential: vi.fn(async () => {
        throw new Error(`Storing ${credential} failed`)
      }),
    })

    await expect(pairMachine({ request, ...io })).rejects.toThrow(
      "The machine paired but its credential could not be stored",
    )
  })
})
