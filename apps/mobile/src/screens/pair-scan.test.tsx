import { describe, expect, it, jest } from "@jest/globals"
import { encodePairingPayload, phoneAndTabletPromise, phoneAndTabletPromiseGap } from "@getdomovoi/protocol"
import { fireEvent, render, screen } from "@testing-library/react-native"
import { PermissionStatus, type PermissionResponse } from "expo-camera"
import { useEffect } from "react"

import { PairScanScreen, readPairingScan, type PairScanner } from "./pair-scan"

const payload = { v: 1 as const, url: "wss://djs-macbook-pro-1.raptor-pompano.ts.net:47831/rpc", token: "t".repeat(43), label: "djs-macbook-pro-1" }

// A fake camera: after it mounts, it reports the text a QR would carry, the
// way the real one reports a frame.
function scannerWith(text: string): PairScanner {
  return function FakeScanner({ onScanned }) {
    // One frame, once: the screen's handler is stable, so this fires on mount.
    useEffect(() => { if (text) onScanned(text) }, [onScanned])
    return null
  }
}

const granted: PermissionResponse = { status: PermissionStatus.GRANTED, granted: true, canAskAgain: true, expires: "never" }
const denied: PermissionResponse = { status: PermissionStatus.DENIED, granted: false, canAskAgain: false, expires: "never" }

describe("pairing by camera", () => {
  it("reads a pairing code the way a QR carries it", () => {
    expect(readPairingScan(encodePairingPayload(payload))).toEqual({ ok: true, payload })
    expect(readPairingScan("https://example.com")).toEqual({ ok: false, reason: "This is not a Domovoi pairing code" })
  })

  it("pairs from a scanned code and names the machine before connecting", async () => {
    const onPaired = jest.fn()
    await render(
      <PairScanScreen permission={granted} requestPermission={jest.fn(async () => granted)} Scanner={scannerWith(encodePairingPayload(payload))} onPaired={onPaired} onCancel={jest.fn()} />,
    )
    expect(screen.getByText(/djs-macbook-pro-1/)).toBeTruthy()
    expect(screen.queryByText(payload.token)).toBeNull()
    // The phone checks shape, not scope; the promise is conditional.
    for (const line of phoneAndTabletPromise) expect(screen.getByText(line)).toBeTruthy()
    expect(screen.getByText(phoneAndTabletPromiseGap)).toBeTruthy()
    expect(screen.getByText(/cannot tell that credential from the machine's own/)).toBeTruthy()
    await fireEvent.press(screen.getByRole("button", { name: "Pair with this machine" }))
    expect(onPaired).toHaveBeenCalledWith(payload)
  })

  it("says what a wrong code is and keeps scanning", async () => {
    await render(
      <PairScanScreen permission={granted} requestPermission={jest.fn(async () => granted)} Scanner={scannerWith("https://example.com")} onPaired={jest.fn()} onCancel={jest.fn()} />,
    )
    expect(screen.getByText("This is not a Domovoi pairing code")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Pair with this machine" })).toBeNull()
  })

  it("offers the pasted code when the camera is refused, and reads it the same way", async () => {
    const onPaired = jest.fn()
    await render(
      <PairScanScreen permission={denied} requestPermission={jest.fn(async () => denied)} Scanner={scannerWith("")} onPaired={onPaired} onCancel={jest.fn()} />,
    )
    expect(screen.getByText("Camera refused")).toBeTruthy()
    await fireEvent.changeText(screen.getByLabelText("Pairing code"), encodePairingPayload(payload))
    expect(screen.getByText(/djs-macbook-pro-1/)).toBeTruthy()
    await fireEvent.press(screen.getByRole("button", { name: "Pair with this machine" }))
    expect(onPaired).toHaveBeenCalledWith(payload)
  })
})
