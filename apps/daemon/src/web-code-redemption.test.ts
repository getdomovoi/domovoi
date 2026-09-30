import { afterEach, expect, it } from "vitest"

import { devicePairResultSchema, protocolVersion } from "@getdomovoi/protocol"

import { DomovoiDaemon } from "./server.js"
import { createBrowserPairingClient } from "../../../packages/ui/src/browser-pairing-client.js"
import { DomovoiClient } from "../../../packages/ui/src/client.js"

const running: DomovoiDaemon[] = []
const budgets = { connectMs: 5_000, requestMs: 5_000 }

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.stop()))
})

async function daemonShowingWebCode() {
  const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
  running.push(daemon)
  await daemon.start()
  const url = `ws://${daemon.address!.host}:${daemon.address!.port}/rpc`
  const owner = new DomovoiClient(url, "cli", { budgets, authToken: daemon.authToken })
  try {
    await owner.connect()
    const { code } = await owner.request("device.issueCode", { targetClient: "web" })
    return { url, code }
  } finally { owner.disconnect() }
}

// The web connect page as main.tsx builds it, against a real daemon: the tab
// holds no credential, so the daemon has to be sent the code before anything
// else. A greeting first is refused, and the code is never spent.
it("pairs a browser tab with a web code through the client the page uses", async () => {
  const { url, code } = await daemonShowingWebCode()

  const pairing = createBrowserPairingClient({ url, client: "web" })
  let redeemed: unknown
  try {
    await pairing.connect()
    redeemed = await pairing.request("device.redeemCode", { code, label: "Web browser 4f2a1c9d", protocolVersion })
  } finally { pairing.disconnect() }

  const paired = devicePairResultSchema.parse(redeemed)
  expect(paired.device.binding).toMatchObject({ kind: "client", client: "web" })

  const tab = new DomovoiClient(url, "web", { budgets, authToken: paired.token })
  try {
    await tab.connect()
    expect(await tab.request("device.current", {})).toMatchObject({ kind: "client", deviceId: paired.device.id, client: "web" })
  } finally { tab.disconnect() }
})
