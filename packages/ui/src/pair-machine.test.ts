import { afterAll, describe, expect, it, vi } from "vitest"

import {
  fleetEnrollRefusalSchema,
  protocolVersion,
  type FleetEnrollParams,
  type FleetEnrollResult,
  type FleetMachine,
} from "@getdomovoi/protocol"

import { Deadline } from "./deadline.js"
import { enrollRefusalMessage, pairMachine, MachinePairingError } from "./pair-machine.js"

const code = "hearth-quiet-ember-42"
const deadline = Deadline.start(2_147_483_647)
afterAll(() => deadline.clear())
const machineId = `machine-${"c".repeat(32)}`

const workshop: FleetMachine = {
  id: machineId,
  label: "workshop",
  platform: "linux",
  arch: "x64",
  version: "0.4.2",
  capabilities: ["sessions"],
  protocolVersion,
  transports: [],
  connection: "direct",
  verifiedRoute: {
    endpoint: "wss://workshop.tailnet:47831/rpc",
    lastAuthenticatedAt: "2026-09-04T12:00:00.000Z",
  },
  heartbeat: { state: "online", lastSeenAt: "2026-09-04T12:00:00.000Z" },
  health: "healthy",
  self: false,
}

const enrolled: FleetEnrollResult = {
  outcome: "enrolled",
  machineId,
  fleet: { entries: [{ kind: "machine", machine: workshop }] },
}

const request = { endpoint: "wss://workshop.tailnet:47831/rpc", code, label: "studio-desktop" }

function enrolling(result: FleetEnrollResult | Error = enrolled) {
  return vi.fn(async (_params: Omit<FleetEnrollParams, "client">, _deadline: Deadline) => {
    if (result instanceof Error) throw result
    return result
  })
}

describe("pairMachine", () => {
  it("enrolls in one call and names the machine from the daemon's own fleet", async () => {
    const enroll = enrolling()

    const paired = await pairMachine({ request, deadline, enroll })

    expect(enroll).toHaveBeenCalledOnce()
    expect(enroll).toHaveBeenCalledWith(
      { endpoint: request.endpoint, code, sourceDeviceLabel: "studio-desktop" },
      deadline,
    )
    expect(paired).toEqual({ outcome: "enrolled", machineId, label: "workshop", fleet: enrolled.fleet })
  })

  it("hands the pairing's own deadline to the enroll call", async () => {
    const enroll = enrolling()
    const own = Deadline.start(30_000)

    await pairMachine({ request, deadline: own, enroll })

    expect(enroll.mock.calls[0]?.[1]).toBe(own)
    own.clear()
  })

  it("reports an enrollment the daemon is still finishing as pending", async () => {
    const operation = {
      kind: "pending" as const,
      id: "3d5b7a2e-4c1f-4a6b-9e2d-8f7c6b5a4d3e",
      machineId,
      operation: "enroll" as const,
      startedAt: "2026-09-04T12:00:00.000Z",
    }
    const pending: FleetEnrollResult = {
      outcome: "pending",
      operation,
      fleet: { entries: [operation] },
    }

    await expect(pairMachine({ request, deadline, enroll: enrolling(pending) }))
      .resolves.toEqual({ outcome: "pending", machineId, fleet: pending.fleet })
  })

  it("turns every refusal the protocol names into this build's own words", async () => {
    for (const reason of fleetEnrollRefusalSchema.options) {
      const enroll = enrolling({ outcome: "refused", reason })
      const failure = await pairMachine({ request, deadline, enroll }).then(
        () => undefined,
        (cause: unknown) => cause,
      )
      expect(failure).toBeInstanceOf(MachinePairingError)
      expect((failure as Error).message).toBe(enrollRefusalMessage[reason])
      expect(enrollRefusalMessage[reason]).not.toMatch(/[!—]/u)
    }
  })

  it("says the target refused the code in plain words", async () => {
    await expect(pairMachine({ request, deadline, enroll: enrolling({ outcome: "refused", reason: "pairing-refused" }) }))
      .rejects.toThrow("That machine refused the pairing code")
  })

  it("refuses an address that is not a WebSocket URL before asking the daemon", async () => {
    const enroll = enrolling()

    await expect(pairMachine({ request: { ...request, endpoint: "https://workshop.tailnet/rpc" }, deadline, enroll }))
      .rejects.toThrow("A machine address must be a WebSocket URL")
    expect(enroll).not.toHaveBeenCalled()
  })

  it("never sends a pairing code over a plaintext address off this machine", async () => {
    const enroll = enrolling()

    await expect(pairMachine({ request: { ...request, endpoint: "ws://workshop.tailnet:47831/rpc" }, deadline, enroll }))
      .rejects.toThrow("Refusing to send a pairing code over an unencrypted connection")
    expect(enroll).not.toHaveBeenCalled()
  })

  it("allows a plaintext address that stays on this machine", async () => {
    const enroll = enrolling()

    await pairMachine({ request: { ...request, endpoint: "ws://127.0.0.1:47831/rpc" }, deadline, enroll })

    expect(enroll).toHaveBeenCalledOnce()
  })

  it("refuses an address that carries credentials, a query or a fragment", async () => {
    const enroll = enrolling()

    await expect(pairMachine({ request: { ...request, endpoint: "wss://user:pw@workshop.tailnet/rpc" }, deadline, enroll }))
      .rejects.toThrow("A machine address cannot carry credentials, a query or a fragment")
    expect(enroll).not.toHaveBeenCalled()
  })

  it("refuses a code that does not look like one before asking the daemon", async () => {
    const enroll = enrolling()

    await expect(pairMachine({ request: { ...request, code: "not a code" }, deadline, enroll }))
      .rejects.toThrow("A pairing code looks like hearth-quiet-ember-42")
    expect(enroll).not.toHaveBeenCalled()
  })

  it("never quotes the code when the daemon's failure does", async () => {
    const enroll = enrolling(new Error(`Invalid params: ${code}`))

    await expect(pairMachine({ request, deadline, enroll })).rejects.toThrow("Pairing was refused")
  })

  it("keeps the daemon's own words when they do not carry the code", async () => {
    const enroll = enrolling(new Error("Daemon connection is not open"))

    await expect(pairMachine({ request, deadline, enroll })).rejects.toThrow("Daemon connection is not open")
  })
})
