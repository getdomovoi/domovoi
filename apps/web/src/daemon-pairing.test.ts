import { describe, expect, it, vi } from "vitest"

import { daemonCredentialShapeMessage, pairBrowserDevice, type PairingClient } from "./daemon-pairing"

const deviceId = `device-${"a1b2c3d4".repeat(4)}`
const bearer = "r".repeat(43)
const deviceToken = "d".repeat(43)

function pairResult() {
  return {
    device: {
      id: deviceId,
      label: "Web browser 4f2a1c9d",
      pairedAt: "2026-09-05T09:00:00.000Z",
      binding: { kind: "client", client: "web" },
    },
    token: deviceToken,
  }
}

function fakeClient(overrides: Partial<PairingClient> = {}) {
  const client: PairingClient = {
    connect: vi.fn().mockResolvedValue(undefined),
    request: vi.fn().mockResolvedValue(pairResult()),
    disconnect: vi.fn(),
    ...overrides,
  }
  return client
}

describe("browser device pairing", () => {
  it("spends the pasted bearer once and keeps only the device credential", async () => {
    const client = fakeClient()

    const session = await pairBrowserDevice({
      url: "wss://daemon.example/rpc",
      client: "web",
      bearer,
      label: "Web browser 4f2a1c9d",
      createClient: () => client,
    })

    expect(session).toEqual({ deviceId, token: deviceToken })
    expect(session.token).not.toBe(bearer)
    expect(client.request).toHaveBeenCalledWith("device.pair", { label: "Web browser 4f2a1c9d", client: "web" })
    expect(client.disconnect).toHaveBeenCalledOnce()
  })

  it("carries the bearer only into the connection it opens", async () => {
    const client = fakeClient()
    const createClient = vi.fn().mockReturnValue(client)

    await pairBrowserDevice({
      url: "wss://daemon.example/rpc",
      client: "tablet",
      bearer,
      label: "Tablet browser 4f2a1c9d",
      createClient,
    })

    expect(createClient).toHaveBeenCalledWith({ url: "wss://daemon.example/rpc", client: "tablet", bearer })
  })

  it("closes the connection when the daemon refuses the pairing", async () => {
    const client = fakeClient({ request: vi.fn().mockRejectedValue(new Error("Daemon authentication failed")) })

    await expect(pairBrowserDevice({
      url: "wss://daemon.example/rpc",
      client: "web",
      bearer,
      label: "Web browser 4f2a1c9d",
      createClient: () => client,
    })).rejects.toThrow("Daemon authentication failed")
    expect(client.disconnect).toHaveBeenCalledOnce()
  })

  it("refuses a credential of the wrong shape before it opens a connection", async () => {
    const createClient = vi.fn()

    await expect(pairBrowserDevice({
      url: "wss://daemon.example/rpc",
      client: "web",
      bearer: "pasted-the-wrong-line",
      label: "Web browser 4f2a1c9d",
      createClient,
    })).rejects.toThrow(daemonCredentialShapeMessage)
    expect(createClient).not.toHaveBeenCalled()
  })
})
