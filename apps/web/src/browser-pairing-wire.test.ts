import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { protocolVersion } from "@getdomovoi/protocol"

import { createBrowserPairingClient } from "@/browser-pairing-client"
import { installFakeWebSocket, type FakeWebSocketHarness } from "@/test-support/fake-websocket"

import { redeemBrowserCode } from "./daemon-pairing"

const url = "ws://127.0.0.1:47831/rpc"
const deviceId = `device-${"a1b2c3d4".repeat(4)}`
const deviceToken = "d".repeat(43)

let harness: FakeWebSocketHarness

beforeEach(() => { harness = installFakeWebSocket() })
afterEach(() => { harness.uninstall() })

// The client main.tsx hands the connect page, driven over a socket. A tab that
// holds no credential cannot greet the daemon, so the code has to be the first
// thing it sends; a greeting first is refused and the code is never spent.
it("sends the code as the first frame on the code path and never greets", async () => {
  const pairing = redeemBrowserCode({
    url,
    client: "web",
    code: "hearth-quiet-ember-42",
    label: "Web browser 4f2a1c9d",
    createClient: createBrowserPairingClient,
  })
  const socket = harness.socket(0)
  socket.open()
  await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0))

  const [first] = socket.sent
  expect(first).toMatchObject({
    method: "device.redeemCode",
    params: { code: "hearth-quiet-ember-42", label: "Web browser 4f2a1c9d", protocolVersion },
  })
  socket.receive({
    jsonrpc: "2.0",
    id: first!.id,
    result: {
      device: { id: deviceId, label: "Web browser 4f2a1c9d", pairedAt: "2026-09-05T09:00:00.000Z", binding: { kind: "client", client: "web" } },
      token: deviceToken,
    },
  })

  await expect(pairing).resolves.toEqual({ deviceId, token: deviceToken })
  expect(socket.sent.map((frame) => frame.method)).toEqual(["device.redeemCode"])
  expect(socket.closeCalls).toHaveLength(1)
})
