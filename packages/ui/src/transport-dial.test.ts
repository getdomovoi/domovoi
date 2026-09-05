import { describe, expect, it, vi } from "vitest"

import type { TransportCandidate } from "@getdomovoi/protocol"

import { dialTransport, TransportDialError } from "./transport-dial.js"

const loopback: TransportCandidate = {
  kind: "local",
  endpoint: "ws://127.0.0.1:47831/rpc",
  authenticated: true,
}
const lan: TransportCandidate = {
  kind: "lan",
  endpoint: "wss://workshop.local:47831/rpc",
  authenticated: true,
}
const tailnet: TransportCandidate = {
  kind: "tailnet",
  endpoint: "wss://workshop.tailnet:47831/rpc",
  authenticated: true,
}

const credential = "n".repeat(43)

describe("dialTransport", () => {
  it("connects over the most private candidate", async () => {
    const connect = vi.fn(async () => ({ closed: false }))

    const dialed = await dialTransport({
      candidates: [tailnet, loopback],
      credential,
      connect,
    })

    expect(dialed.transport).toEqual(loopback)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledWith({ endpoint: loopback.endpoint, credential })
  })

  it("falls back to the next candidate when a closer one refuses", async () => {
    const connect = vi.fn(async ({ endpoint }: { endpoint: string }) => {
      if (endpoint === lan.endpoint) throw new Error("ECONNREFUSED")
      return { closed: false }
    })

    const dialed = await dialTransport({ candidates: [tailnet, lan], credential, connect })

    expect(dialed.transport).toEqual(tailnet)
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it("refuses to send a credential in the clear to a remote host", async () => {
    const connect = vi.fn(async () => ({ closed: false }))
    const plaintextRemote: TransportCandidate = {
      kind: "lan",
      endpoint: "ws://workshop.local:47831/rpc",
      authenticated: true,
    }

    await expect(dialTransport({ candidates: [plaintextRemote], credential, connect }))
      .rejects.toThrow(TransportDialError)
    expect(connect).not.toHaveBeenCalled()
  })

  it.each([
    { label: "remote endpoint labelled local", candidate: { ...lan, kind: "local" } },
    { label: "loopback endpoint labelled LAN", candidate: { ...loopback, kind: "lan" } },
    { label: "SSH without configuration", candidate: { ...loopback, kind: "ssh" } },
    { label: "LAN with a configuration flag", candidate: { ...lan, configured: false } },
    { label: "credential in endpoint", candidate: { ...lan, endpoint: `wss://${credential}@workshop.local/rpc` } },
    { label: "credential in unknown kind", candidate: { ...lan, kind: credential } },
    { label: "credential in unknown field", candidate: { ...lan, [credential]: true } },
    { label: "missing candidate", candidate: null },
    { label: "invalid endpoint type", candidate: { ...lan, endpoint: null } },
  ])("translates $label into a safe typed refusal before dialing", async ({ candidate }) => {
    const connect = vi.fn(async () => ({ closed: false }))

    const failure = await dialTransport({ candidates: [loopback, candidate] as never, credential, connect })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(TransportDialError)
    expect(failure).toMatchObject({ message: expect.stringContaining("Refresh") })
    expect(String(failure)).not.toContain(credential)
    expect(failure).not.toHaveProperty("cause")
    expect(connect).not.toHaveBeenCalled()
  })

  it("allows plaintext only to a loopback endpoint", async () => {
    const connect = vi.fn(async () => ({ closed: false }))

    await expect(dialTransport({ candidates: [loopback], credential, connect })).resolves.toBeTruthy()
    expect(connect).toHaveBeenCalledWith({ endpoint: loopback.endpoint, credential })
  })

  it("refuses to dial without a credential", async () => {
    const connect = vi.fn(async () => ({ closed: false }))

    await expect(dialTransport({ candidates: [loopback], credential: "", connect }))
      .rejects.toThrow("A transport credential is required")
    expect(connect).not.toHaveBeenCalled()
  })

  it("reports every failure when no candidate connects", async () => {
    const connect = vi.fn(async () => {
      throw new Error("ECONNREFUSED")
    })

    await expect(dialTransport({ candidates: [lan, tailnet], credential, connect }))
      .rejects.toThrow("No transport reached that machine")
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it.each([undefined, false, true])("cannot enable reserved relay with availability %s", async (relayAvailable) => {
    const connect = vi.fn(async () => ({ closed: false }))
    const relay: TransportCandidate = {
      kind: "relay",
      endpoint: "wss://relay.domovoi.sh/rpc",
      authenticated: true,
    }

    await expect(dialTransport({
      candidates: [relay], credential, connect,
      ...(relayAvailable === undefined ? {} : { relayAvailable }),
    }))
      .rejects.toThrow("No transport reached that machine")
    expect(connect).not.toHaveBeenCalled()
  })

  it("only dials a configured SSH forward after closer routes fail", async () => {
    const disabled: TransportCandidate = { ...loopback, kind: "ssh", configured: false }
    const enabled: TransportCandidate = { ...disabled, endpoint: "ws://127.0.0.1:47832/rpc", configured: true }
    const connect = vi.fn(async ({ endpoint }: { endpoint: string }) => {
      if (endpoint === lan.endpoint) throw new Error("ECONNREFUSED")
      return { closed: false }
    })

    const dialed = await dialTransport({ candidates: [disabled, enabled, lan], credential, connect })

    expect(dialed.transport).toEqual(enabled)
    expect(connect.mock.calls.map(([attempt]) => attempt.endpoint)).toEqual([lan.endpoint, enabled.endpoint])
  })

  it("never keeps a credential in the error it reports", async () => {
    const connect = vi.fn(async () => {
      throw new Error(`refused ${credential}`)
    })

    const failure = await dialTransport({ candidates: [lan], credential, connect })
      .catch((error: Error) => error)

    expect(String(failure)).not.toContain(credential)
  })
})
