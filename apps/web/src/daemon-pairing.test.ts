import { describe, expect, it, vi } from "vitest"

import { daemonCredentialShapeMessage, pairBrowserDevice, type BearerPairingClient, type CodePairingClient } from "./daemon-pairing"

type PairingClient = BearerPairingClient & CodePairingClient

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
    const { redeemBrowserCode, codeShapeMessage } = await import("./daemon-pairing")
    const factory = vi.fn()
    await expect(redeemBrowserCode({ url: "wss://daemon.example/rpc", client: "web", code: "DVOI-4K7Q-91XZ", label: "x", createClient: factory })).rejects.toThrow(codeShapeMessage("web"))
    expect(codeShapeMessage("web")).toBe("A web code is the daemon's word code, like hearth-quiet-ember-42, shown on the machine in Settings under Phone and tablet.")
    expect(factory).not.toHaveBeenCalled()
  })

  it("maps the daemon's refusals to outcomes the page can draw", async () => {
    const { pairingOutcomeFor } = await import("./daemon-pairing")
    const { DaemonRpcError } = await import("@/client")
    const { daemonAuthenticationErrorCode, devicePairingLimitErrorCode, protocolVersionMismatchErrorCode } = await import("@getdomovoi/protocol")
    const host = "mac-mini-m4.tail4c2e.ts.net"
    expect(pairingOutcomeFor(new DaemonRpcError(daemonAuthenticationErrorCode, "Pairing was refused"), host)).toMatchObject({ pill: "refused", title: "That code was refused", body: "It may have expired or been used already. Show another on mac-mini-m4.tail4c2e.ts.net, under Settings, Phone and tablet." })
    expect(pairingOutcomeFor(new DaemonRpcError(protocolVersionMismatchErrorCode, "x", { kind: "protocol-mismatch", daemonProtocolVersion: "0.9.0", clientProtocolVersion: "0.8.0", compatibility: "machine-ahead" }), host)).toMatchObject({ pill: "refused", title: "This page is older than the daemon on mac-mini-m4.tail4c2e.ts.net", mono: "pair.refused · protocol_mismatch · page 0.8.0, daemon 0.9.0" })
    expect(pairingOutcomeFor(new DaemonRpcError(devicePairingLimitErrorCode, "The paired device limit is reached"), host)).toMatchObject({ pill: "refused", title: "mac-mini-m4.tail4c2e.ts.net has no room for another device" })
    const { PairingTransportError } = await import("@/browser-pairing-client")
    expect(pairingOutcomeFor(new PairingTransportError("Daemon connection closed"), host)).toMatchObject({ pill: "unconfirmed", title: "mac-mini-m4.tail4c2e.ts.net did not answer, so pairing is unconfirmed" })
  })

  it("draws a refusal it has no card for with the daemon's own words", async () => {
    const { pairingOutcomeFor } = await import("./daemon-pairing")
    const { DaemonRpcError } = await import("@/client")
    expect(pairingOutcomeFor(new DaemonRpcError(-32099, "Pairing is closed on this daemon"), "host")).toMatchObject({ pill: "refused", title: "The daemon refused pairing", mono: "pair.refused · -32099", body: "Pairing is closed on this daemon" })
  })

  // Q196, 2026-09-29: a touch browser greets as a phone or tablet, and a code
  // shown for a web browser binds its credential to web. The daemon refuses a
  // greeting whose kind is not the credential's, so such a credential is not
  // kept, and the page says which code this browser needs.
  it("keeps no credential bound to a kind this page does not greet as", async () => {
    const { redeemBrowserCode, pairingOutcomeFor } = await import("./daemon-pairing")
    const client = fakeClient()
    const caught = await redeemBrowserCode({ url: "wss://daemon.example/rpc", client: "phone", code: "hearth-quiet-ember-42", label: "Phone browser 4f2a1c9d", createClient: () => client }).catch((error: unknown) => error)
    expect(client.disconnect).toHaveBeenCalledOnce()
    expect(pairingOutcomeFor(caught, "mac-mini-m4.tail4c2e.ts.net")).toEqual({
      tone: "danger",
      pill: "not kept",
      title: "This code is for a web browser",
      mono: "pair.refused · kind_mismatch · code web, browser phone",
      body: "This browser counts as a phone. On mac-mini-m4.tail4c2e.ts.net, show a phone code under Settings, Phone and tablet. The code was used, so unpair the extra device under Machines.",
    })
  })

  it("names each kind a code can be bound to and a browser can greet as", async () => {
    const { redeemBrowserCode, pairingOutcomeFor } = await import("./daemon-pairing")
    const bound = (client: string) => fakeClient({ request: vi.fn().mockResolvedValue({ ...pairResult(), device: { ...pairResult().device, binding: { kind: "client", client } } }) })
    const outcome = async (code: string, browser: "web" | "tablet" | "phone" | "desktop" | "cli") => pairingOutcomeFor(
      await redeemBrowserCode({ url: "wss://daemon.example/rpc", client: browser, code: "hearth-quiet-ember-42", label: "x", createClient: () => bound(code) }).catch((error: unknown) => error),
      "host",
    )
    expect(await outcome("tablet", "web")).toMatchObject({ title: "This code is for a tablet", body: expect.stringContaining("This browser counts as a web browser. On host, show a web code under") })
    expect(await outcome("phone", "tablet")).toMatchObject({ title: "This code is for a phone", body: expect.stringContaining("This browser counts as a tablet. On host, show a tablet code under") })
    expect(await outcome("desktop", "web")).toMatchObject({ title: "This code is for the desktop app" })
    expect(await outcome("cli", "web")).toMatchObject({ title: "This code is for the command line" })
    expect(await outcome("web", "desktop")).toMatchObject({ body: expect.stringContaining("This browser counts as the desktop app. On host, show a desktop code under") })
    expect(await outcome("web", "cli")).toMatchObject({ body: expect.stringContaining("This browser counts as the command line. On host, show a command line code under") })
  })

  it("names the code this browser needs when a code is malformed", async () => {
    const { redeemBrowserCode, pairingOutcomeFor } = await import("./daemon-pairing")
    const factory = vi.fn()
    const caught = await redeemBrowserCode({ url: "wss://daemon.example/rpc", client: "phone", code: "DVOI-4K7Q-91XZ", label: "x", createClient: factory }).catch((error: unknown) => error)
    expect(factory).not.toHaveBeenCalled()
    expect(pairingOutcomeFor(caught, "host")).toEqual({
      tone: "plain",
      pill: "not sent",
      title: "That is not a phone code",
      mono: "word-word-word-00",
      body: "A phone code is the daemon's word code, like hearth-quiet-ember-42, shown on the machine in Settings under Phone and tablet.",
    })
  })

  it("says a code that bound no client kind is not for a browser", async () => {
    const { DeviceKindMismatchError, pairingOutcomeFor, redeemBrowserCode } = await import("./daemon-pairing")
    const machine = fakeClient({ request: vi.fn().mockResolvedValue({ ...pairResult(), device: { ...pairResult().device, binding: { kind: "machine", machineId: `machine-${"a".repeat(32)}` } } }) })
    const refusal = await redeemBrowserCode({ url: "wss://daemon.example/rpc", client: "web", code: "hearth-quiet-ember-42", label: "x", createClient: () => machine }).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(DeviceKindMismatchError)
    expect((refusal as Error).message).toBe("The code paired a device that is not a client, and this browser greets as web")
    expect(new DeviceKindMismatchError("web", "phone").message).toBe("The code paired web, and this browser greets as phone")
    expect(pairingOutcomeFor(refusal, "host")).toMatchObject({ title: "This code is not for a browser", mono: "pair.refused · kind_mismatch · code none, browser web" })
  })

  it("keeps a credential bound to the kind this page greets as", async () => {
    const { redeemBrowserCode } = await import("./daemon-pairing")
    const phone = fakeClient({ request: vi.fn().mockResolvedValue({ ...pairResult(), device: { ...pairResult().device, binding: { kind: "client", client: "phone" } } }) })
    await expect(redeemBrowserCode({ url: "wss://daemon.example/rpc", client: "phone", code: "hearth-quiet-ember-42", label: "x", createClient: () => phone })).resolves.toEqual({ deviceId, token: deviceToken })
  })

  it("does not blame the code for a refused greeting", async () => {
    const { pairingOutcomeFor } = await import("./daemon-pairing")
    const { DaemonRpcError } = await import("@/client")
    const { daemonAuthenticationErrorCode } = await import("@getdomovoi/protocol")
    expect(pairingOutcomeFor(new DaemonRpcError(daemonAuthenticationErrorCode, "Daemon authentication failed"), "host")).toMatchObject({ pill: "refused", title: "The daemon refused pairing", mono: `pair.refused · ${daemonAuthenticationErrorCode}`, body: "Daemon authentication failed" })
  })

  it("names a protocol mismatch even when the daemon sent no versions", async () => {
    const { pairingOutcomeFor } = await import("./daemon-pairing")
    const { DaemonRpcError } = await import("@/client")
    const { protocolVersion, protocolVersionMismatchErrorCode } = await import("@getdomovoi/protocol")
    expect(pairingOutcomeFor(new DaemonRpcError(protocolVersionMismatchErrorCode, "x"), "host").mono).toBe(`pair.refused · protocol_mismatch · page ${protocolVersion}, daemon unknown`)
    expect(pairingOutcomeFor(new DaemonRpcError(protocolVersionMismatchErrorCode, "x", { daemonProtocolVersion: 9 }), "host").mono).toBe(`pair.refused · protocol_mismatch · page ${protocolVersion}, daemon unknown`)
  })

  // The daemon says which side is older (data.compatibility), and checks the
  // version before it spends the code. Only an older page is cured by a
  // reload; an older daemon needs updating, and the code still works.
  it("names the older side of a protocol mismatch and what cures it", async () => {
    const { pairingNextStep, pairingOutcomeFor } = await import("./daemon-pairing")
    const { DaemonRpcError } = await import("@/client")
    const { protocolVersionMismatchErrorCode } = await import("@getdomovoi/protocol")
    const mismatch = (compatibility?: string) => new DaemonRpcError(protocolVersionMismatchErrorCode, "Client and daemon protocol versions are incompatible", {
      kind: "protocol-mismatch", daemonProtocolVersion: "0.7.0", clientProtocolVersion: "0.8.0", ...(compatibility ? { compatibility } : {}),
    })

    expect(pairingOutcomeFor(mismatch("machine-ahead"), "host")).toEqual({
      tone: "danger", pill: "refused", title: "This page is older than the daemon on host",
      mono: "pair.refused · protocol_mismatch · page 0.8.0, daemon 0.7.0",
      body: "The daemon was updated while this tab was open. Reload the page to update it. The daemon needs nothing. The code was not used.",
    })
    expect(pairingNextStep(mismatch("machine-ahead"))).toBe("reload")

    expect(pairingOutcomeFor(mismatch("machine-behind"), "host")).toEqual({
      tone: "danger", pill: "refused", title: "The daemon on host is older than this page",
      mono: "pair.refused · protocol_mismatch · page 0.8.0, daemon 0.7.0",
      // An update restarts the daemon, which drops the open code, and takes
      // longer than its 180 seconds, so the way on is a new code.
      body: "Update Domovoi on host, then show a new code there and type it here. The daemon checked the version first, so this code was not used.",
    })
    expect(pairingNextStep(mismatch("machine-behind"))).toBe("new-code")

    expect(pairingOutcomeFor(mismatch(), "host")).toEqual({
      tone: "danger", pill: "refused", title: "This page and the daemon on host speak different protocol versions",
      mono: "pair.refused · protocol_mismatch · page 0.8.0, daemon 0.7.0",
      body: "The daemon did not say which one is older, so this page cannot say which to update.",
    })
    expect(pairingNextStep(mismatch())).toBe("none")
    expect(pairingNextStep(mismatch("compatible"))).toBe("none")
  })

  // Q366 A: only a transport failure is retried with the same code. After
  // the daemon answered, a resend would only pair another device.
  it("retries only when the daemon did not answer", async () => {
    const { pairingNextStep, pairingOutcomeFor, CodeShapeError, DeviceKindMismatchError, PairingReplyError } = await import("./daemon-pairing")
    const { DaemonRpcError } = await import("@/client")
    const { PairingTransportError } = await import("@/browser-pairing-client")
    const { BrowserCapabilityError } = await import("./platform-refusals")
    const { daemonAuthenticationErrorCode } = await import("@getdomovoi/protocol")
    expect(pairingNextStep(new PairingTransportError("Daemon connection closed"))).toBe("retry")
    expect(pairingNextStep(new BrowserCapabilityError("credentials-unavailable"))).toBe("none")
    expect(pairingNextStep(new PairingReplyError())).toBe("none")
    expect(pairingNextStep(new Error("The daemon did not return a device credential for this browser"))).toBe("new-code")
    expect(pairingNextStep("socket closed")).toBe("new-code")
    expect(pairingOutcomeFor(new Error("anything else"), "host", "Web browser 4f2a1c9d")).toEqual({
      tone: "plain", pill: "unconfirmed", title: "Pairing with host did not finish", mono: "pair · unconfirmed",
      body: "If host lists Web browser 4f2a1c9d under Machines, it paired. Before you pair again, revoke it there, in the desktop app on host.",
    })
    // Without a label the card still names no control a browser cannot reach.
    expect(pairingOutcomeFor(new PairingReplyError(), "host").body).toBe("It may have paired this browser. If it did, in the desktop app on host, under Machines, revoke this browser's device.")
    expect(pairingNextStep(new DaemonRpcError(daemonAuthenticationErrorCode, "Pairing was refused"))).toBe("new-code")
    expect(pairingNextStep(new CodeShapeError("web"))).toBe("new-code")
    expect(pairingNextStep(new DeviceKindMismatchError("web", "phone"))).toBe("new-code")
  })

  it("says a malformed code was never sent", async () => {
    const { pairingOutcomeFor, CodeShapeError, codeShapeMessage } = await import("./daemon-pairing")
    expect(pairingOutcomeFor(new CodeShapeError("web"), "host")).toMatchObject({ pill: "not sent", title: "That is not a web code", body: codeShapeMessage("web") })
  })

  it("reports the connection once it opens, before the daemon answers", async () => {
    const { redeemBrowserCode } = await import("./daemon-pairing")
    const order: string[] = []
    const client = fakeClient({ connect: vi.fn(async () => { order.push("connect") }), request: vi.fn(async () => { order.push("request"); return pairResult() }) })
    await redeemBrowserCode({ url: "wss://daemon.example/rpc", client: "web", code: "hearth-quiet-ember-42", label: "x", createClient: () => client, onConnected: () => order.push("connected") })
    expect(order).toEqual(["connect", "connected", "request"])
    const refused = fakeClient({ connect: vi.fn(async () => { throw new Error("socket closed") }) })
    const onConnected = vi.fn()
    await expect(redeemBrowserCode({ url: "wss://daemon.example/rpc", client: "web", code: "hearth-quiet-ember-42", label: "x", createClient: () => refused, onConnected })).rejects.toThrow("socket closed")
    expect(onConnected).not.toHaveBeenCalled()
  })
})
