import { describe, expect, it, vi } from "vitest"

import { protocolVersion } from "@getdomovoi/protocol"

import { clientVersion } from "./client.js"
import { Deadline } from "./deadline.js"
import { machineHelloParams, pairMachine, MachinePairingError } from "./pair-machine.js"

const code = "hearth-quiet-ember-42"
const deadline = Deadline.start(2_147_483_647)
const credential = "n".repeat(43)
const machineId = `machine-${"c".repeat(32)}`
const device = {
  id: `device-${"a".repeat(32)}`,
  label: "studio-ipad",
  pairedAt: "2026-08-31T12:00:00.000Z",
  binding: { kind: "machine", machineId },
}

function pairing(overrides: {
  identify?: (input: { endpoint: string; credential: string; deadline: Deadline }) => Promise<{ id: string; name: string }>
  saveCredential?: (input: { machineId: string; credential: string; deadline: Deadline }) => Promise<void>
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
      ?? vi.fn(async (input: { machineId: string; credential: string; deadline: Deadline }) => {
        saved.push({ machineId: input.machineId, credential: input.credential })
      }),
  }
}

const request = { endpoint: "wss://workshop.tailnet:47831/rpc", code, label: "studio-ipad" }

describe("pairMachine", () => {
  it("saves the claimed credential for the identity the machine reports", async () => {
    const io = pairing()

    const paired = await pairMachine({ request, machineId: `machine-${"c".repeat(32)}`, deadline, ...io })

    expect(io.saved).toEqual([{ machineId, credential }])
    expect(paired).toEqual({ machineId, label: "workshop" })
    expect(io.identify).toHaveBeenCalledWith({ endpoint: request.endpoint, credential, deadline })
  })

  it("carries one deadline through the claim, the greeting, and the store", async () => {
    const io = pairing()
    const own = Deadline.start(30_000)

    await pairMachine({ request, machineId, deadline: own, ...io })

    expect(io.open).toHaveBeenCalledWith(request.endpoint, own)
    expect(io.identify).toHaveBeenCalledWith(expect.objectContaining({ deadline: own }))
    expect(io.saveCredential).toHaveBeenCalledWith({ machineId, credential, deadline: own })
    own.clear()
  })

  it("refuses to save a credential for an identity the protocol does not describe", async () => {
    const io = pairing({ identify: vi.fn(async () => ({ id: "machine-nonsense", name: "workshop" })) })

    await expect(pairMachine({ request, machineId: `machine-${"c".repeat(32)}`, deadline, ...io })).rejects.toThrow(MachinePairingError)
    expect(io.saved).toEqual([])
  })

  it("never quotes the credential when the machine fails to name itself", async () => {
    const io = pairing({
      identify: vi.fn(async () => {
        throw new Error(`Handshake with ${credential} failed`)
      }),
    })

    await expect(pairMachine({ request, machineId: `machine-${"c".repeat(32)}`, deadline, ...io })).rejects.toThrow(
      "The machine did not name itself after pairing",
    )
    expect(io.saved).toEqual([])
  })

  it("never quotes the credential when saving it fails", async () => {
    const io = pairing({
      saveCredential: vi.fn(async () => {
        throw new Error(`Storing ${credential} failed`)
      }),
    })

    await expect(pairMachine({ request, machineId: `machine-${"c".repeat(32)}`, deadline, ...io })).rejects.toThrow(
      "The machine paired but its credential could not be stored",
    )
  })
})

it("greets a newly paired machine as a machine, on the current protocol", () => {
  expect(machineHelloParams("machine-token")).toEqual({
    client: "machine",
    clientVersion,
    protocolVersion,
    authToken: "machine-token",
  })
  expect(protocolVersion).not.toBe("0.1.0")
})
