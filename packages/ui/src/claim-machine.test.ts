import { afterAll, describe, expect, it, vi } from "vitest"

import { claimMachine, MachineClaimError } from "./claim-machine.js"
import { Deadline } from "./deadline.js"

const code = "hearth-quiet-ember-42"
const deadline = Deadline.start(2_147_483_647)
afterAll(() => deadline.clear())
const credential = "n".repeat(43)
const device = {
  id: `device-${"a".repeat(32)}`,
  label: "studio-ipad",
  pairedAt: "2026-08-31T12:00:00.000Z",
  binding: { kind: "machine", machineId: `machine-${"b".repeat(32)}` },
}

function transport(result: unknown = { device, token: credential }) {
  const calls: { endpoint: string; method: string; params: Record<string, unknown> }[] = []
  const closed: string[] = []
  return {
    calls,
    closed,
    open: vi.fn(async (endpoint: string) => ({
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push({ endpoint, method, params })
        if (result instanceof Error) throw result
        return result
      },
      close: () => closed.push(endpoint),
    })),
  }
}

describe("claimMachine", () => {
  it("claims a credential from an encrypted endpoint", async () => {
    const io = transport()

    const claimed = await claimMachine({
      endpoint: "wss://workshop.tailnet:47831/rpc",
      code,
      label: "studio-ipad",
      machineId: `machine-${"b".repeat(32)}`,
      open: io.open,
      deadline,
    })

    expect(claimed.token).toBe(credential)
    expect(claimed.device.label).toBe("studio-ipad")
    expect(io.calls[0]).toMatchObject({ method: "device.claim", params: { code, label: "studio-ipad" } })
  })

  it("opens the claim socket under the pairing's own deadline", async () => {
    const io = transport()
    const own = Deadline.start(30_000)

    await claimMachine({
      endpoint: "wss://workshop.tailnet:47831/rpc",
      code,
      label: "studio-ipad",
      machineId: `machine-${"b".repeat(32)}`,
      open: io.open,
      deadline: own,
    })

    expect(io.open).toHaveBeenCalledWith("wss://workshop.tailnet:47831/rpc", own)
    own.clear()
  })

  it("claims over loopback without encryption", async () => {
    const io = transport()

    await expect(claimMachine({
      endpoint: "ws://127.0.0.1:47831/rpc",
      code,
      label: "studio-ipad",
      machineId: `machine-${"b".repeat(32)}`,
      open: io.open,
      deadline,
    })).resolves.toBeTruthy()
  })

  it("never sends a code to an unencrypted remote endpoint", async () => {
    const io = transport()

    await expect(claimMachine({
      endpoint: "ws://workshop.tailnet:47831/rpc",
      code,
      label: "studio-ipad",
      machineId: `machine-${"b".repeat(32)}`,
      open: io.open,
      deadline,
    })).rejects.toThrow(MachineClaimError)
    expect(io.open).not.toHaveBeenCalled()
  })

  it("refuses an endpoint that is not a WebSocket URL", async () => {
    const io = transport()

    await expect(claimMachine({
      endpoint: "https://workshop.tailnet",
      code,
      label: "studio-ipad",
      machineId: `machine-${"b".repeat(32)}`,
      open: io.open,
      deadline,
    })).rejects.toThrow(MachineClaimError)
    expect(io.open).not.toHaveBeenCalled()
  })

  it.each(["wss://", "ws://", "not a url"])(
    "refuses an endpoint with no machine to reach: %s",
    async (endpoint) => {
      const io = transport()

      await expect(claimMachine({ endpoint, code, label: "studio-ipad", machineId: `machine-${"b".repeat(32)}`, open: io.open, deadline }))
        .rejects.toThrow(MachineClaimError)
      expect(io.open).not.toHaveBeenCalled()
    },
  )

  it("closes the connection once the claim is done", async () => {
    const io = transport()

    await claimMachine({
      endpoint: "wss://workshop.tailnet:47831/rpc",
      code,
      label: "studio-ipad",
      machineId: `machine-${"b".repeat(32)}`,
      open: io.open,
      deadline,
    })

    expect(io.closed).toEqual(["wss://workshop.tailnet:47831/rpc"])
  })

  it("closes the connection when the claim is refused", async () => {
    const io = transport(new Error("Pairing was refused"))

    await expect(claimMachine({
      endpoint: "wss://workshop.tailnet:47831/rpc",
      code,
      label: "studio-ipad",
      machineId: `machine-${"b".repeat(32)}`,
      open: io.open,
      deadline,
    })).rejects.toThrow("Pairing was refused")
    expect(io.closed).toEqual(["wss://workshop.tailnet:47831/rpc"])
  })

  it("never repeats the code in an error", async () => {
    const io = transport(new Error(`refused ${code}`))

    const failure = await claimMachine({
      endpoint: "wss://workshop.tailnet:47831/rpc",
      code,
      label: "studio-ipad",
      machineId: `machine-${"b".repeat(32)}`,
      open: io.open,
      deadline,
    }).catch((error: Error) => error)

    expect(String(failure)).not.toContain(code)
  })

  it("refuses a result that is not a described pairing", async () => {
    const io = transport({ device, token: "short" })

    await expect(claimMachine({
      endpoint: "wss://workshop.tailnet:47831/rpc",
      code,
      label: "studio-ipad",
      machineId: `machine-${"b".repeat(32)}`,
      open: io.open,
      deadline,
    })).rejects.toThrow(MachineClaimError)
  })
})

it("names the machine the credential is being issued for", async () => {
  const io = transport()

  await claimMachine({
    endpoint: "ws://127.0.0.1:47831/rpc",
    code,
    label: "studio-ipad",
    machineId: `machine-${"b".repeat(32)}`,
    open: io.open,
    deadline,
  })

  expect(io.calls[0]?.params).toEqual({
    code,
    label: "studio-ipad",
    machineId: `machine-${"b".repeat(32)}`,
  })
})
