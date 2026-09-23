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

describe("redeeming a web code", () => {
  it("sends the code, the label and the protocol version with no bearer, and keeps only the device credential", async () => {
    const { redeemBrowserCode } = await import("./daemon-pairing")
    const { protocolVersion } = await import("@getdomovoi/protocol")
    const client = fakeClient()
    const factory = vi.fn(() => client)
    const session = await redeemBrowserCode({ url: "wss://daemon.example/rpc", client: "web", code: "hearth-quiet-ember-42", label: "Web browser 4f2a1c9d", createClient: factory })
    expect(session).toEqual({ deviceId, token: deviceToken })
    expect(factory).toHaveBeenCalledWith({ url: "wss://daemon.example/rpc", client: "web" })
    expect(client.request).toHaveBeenCalledWith("device.redeemCode", { code: "hearth-quiet-ember-42", label: "Web browser 4f2a1c9d", protocolVersion })
    expect(client.disconnect).toHaveBeenCalledOnce()
  })

  it("refuses a code that is not the daemon's word format before dialing", async () => {
    const { redeemBrowserCode, webCodeShapeMessage } = await import("./daemon-pairing")
    const factory = vi.fn()
    await expect(redeemBrowserCode({ url: "wss://daemon.example/rpc", client: "web", code: "DVOI-4K7Q-91XZ", label: "x", createClient: factory })).rejects.toThrow(webCodeShapeMessage)
    expect(factory).not.toHaveBeenCalled()
  })

  it("maps the daemon's refusals to outcomes the page can draw", async () => {
    const { pairingOutcomeFor } = await import("./daemon-pairing")
    const { DaemonRpcError } = await import("@/client")
    const { daemonAuthenticationErrorCode, devicePairingLimitErrorCode, protocolVersionMismatchErrorCode } = await import("@getdomovoi/protocol")
    const host = "mac-mini-m4.tail4c2e.ts.net"
    expect(pairingOutcomeFor(new DaemonRpcError(daemonAuthenticationErrorCode, "Pairing was refused"), host)).toMatchObject({ pill: "refused", title: "That code was refused", body: "It may have expired or been used already. Show another on mac-mini-m4.tail4c2e.ts.net, under Settings, Phone and tablet." })
    expect(pairingOutcomeFor(new DaemonRpcError(protocolVersionMismatchErrorCode, "x", { kind: "protocol-mismatch", daemonProtocolVersion: "0.9.0", clientProtocolVersion: "0.8.0", compatibility: "client-too-old" }), host)).toMatchObject({ pill: "refused", title: "This page is older than the daemon on mac-mini-m4.tail4c2e.ts.net", mono: "pair.refused · protocol_mismatch · page 0.8.0, daemon 0.9.0" })
    expect(pairingOutcomeFor(new DaemonRpcError(devicePairingLimitErrorCode, "The paired device limit is reached"), host)).toMatchObject({ pill: "refused", title: "mac-mini-m4.tail4c2e.ts.net has no room for another device" })
    expect(pairingOutcomeFor(new Error("socket closed"), host)).toMatchObject({ pill: "unconfirmed", title: "mac-mini-m4.tail4c2e.ts.net did not answer, so pairing is unconfirmed" })
  })
})
