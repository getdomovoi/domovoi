import { describe, expect, it } from "vitest"

import { decodePairingPayload, encodePairingPayload, maximumPairingPayloadLength, pairingPayloadPrefix, pairingPayloadSchema } from "./pairing-payload.js"

const token = "t".repeat(43)
const payload = { v: 1 as const, url: "wss://djs-macbook-pro-1.raptor-pompano.ts.net:47831/rpc", token, label: "djs-macbook-pro-1" }

// The QR a phone scans carries the daemon's address and a client-scoped
// credential, nothing else. The text is self-describing so a scanner that
// reads some other QR can say so, and the credential is validated as one.
describe("pairing payload", () => {
  it("round-trips through the text a QR carries", () => {
    const text = encodePairingPayload(payload)
    expect(text.startsWith(pairingPayloadPrefix)).toBe(true)
    expect(text).not.toContain(token)
    expect(decodePairingPayload(text)).toEqual(payload)
  })

  it("names what is wrong with text that is not a pairing code", () => {
    expect(() => decodePairingPayload("https://example.com")).toThrow(/not a Domovoi pairing code/)
    expect(() => decodePairingPayload(`${pairingPayloadPrefix}not-base64!!`)).toThrow(/could not be read/)
    const forged = `${pairingPayloadPrefix}${Buffer.from(JSON.stringify({ ...payload, token: "short" })).toString("base64url")}`
    expect(() => decodePairingPayload(forged)).toThrow(/credential/)
    const plaintext = `${pairingPayloadPrefix}${Buffer.from(JSON.stringify({ ...payload, url: "ws://100.80.185.103:47831/rpc" })).toString("base64url")}`
    expect(() => decodePairingPayload(plaintext)).toThrow(/daemon address/)
  })

  it("refuses text past the envelope before decoding any of it", () => {
    // The worst case the field bounds admit: every unit a control character,
    // which JSON escapes to six bytes; the URL parser drops them from the
    // parsed address but the raw string is what the JSON carries.
    const control = String.fromCharCode(1)
    const worst = { ...payload, url: `wss://h/${control.repeat(500)}`, label: control.repeat(128) }
    const longest = encodePairingPayload(worst)
    expect(longest.length).toBeGreaterThan(5000)
    expect(longest.length).toBeLessThan(maximumPairingPayloadLength)
    expect(decodePairingPayload(longest)).toEqual(worst)
    const cjk = { ...payload, url: `wss://example.test/${"界".repeat(490)}`, label: "界".repeat(128) }
    expect(decodePairingPayload(encodePairingPayload(cjk))).toEqual(cjk)
    const emoji = { ...payload, url: `wss://example.test/${"😀".repeat(245)}`, label: "😀".repeat(64) }
    expect(decodePairingPayload(encodePairingPayload(emoji))).toEqual(emoji)
    const padded = `${pairingPayloadPrefix}${"A".repeat(maximumPairingPayloadLength)}`
    const started = performance.now()
    expect(() => decodePairingPayload(padded)).toThrow(/too long/)
    expect(() => decodePairingPayload(" ".repeat(20_000_000))).toThrow(/too long/)
    expect(performance.now() - started).toBeLessThan(50)
  })

  it("refuses a plaintext address off loopback and any extra field", () => {
    expect(pairingPayloadSchema.safeParse({ ...payload, url: "ws://100.80.185.103:47831/rpc" }).success).toBe(false)
    expect(pairingPayloadSchema.safeParse({ ...payload, url: "ws://127.0.0.1:47831/rpc" }).success).toBe(true)
    expect(pairingPayloadSchema.safeParse({ ...payload, url: "https://example.com/rpc" }).success).toBe(false)
    expect(pairingPayloadSchema.safeParse({ ...payload, extra: 1 }).success).toBe(false)
    expect(pairingPayloadSchema.safeParse({ ...payload, v: 2 }).success).toBe(false)
  })
})
