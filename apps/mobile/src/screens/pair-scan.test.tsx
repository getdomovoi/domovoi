import { describe, expect, it, jest } from "@jest/globals"
import { encodePairingPayload, phoneAndTabletPromise } from "@getdomovoi/protocol"
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native"
import { PermissionStatus, type PermissionResponse } from "expo-camera"
import { useEffect } from "react"

import { PairScanScreen, readPairingScan, type PairScanner } from "./pair-scan"
import type { PairingPayload } from "@getdomovoi/protocol"
import type { PairedCredential } from "../lib/redeem-pairing-code"

const payload = { v: 1 as const, url: "wss://djs-macbook-pro-1.raptor-pompano.ts.net:47831/rpc", code: "hearth-quiet-ember-42", label: "djs-macbook-pro-1" }
const credential: PairedCredential = { url: payload.url, token: "t".repeat(43), client: "phone" }

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

  // The first render in this file pays for transforming the camera screen's
  // whole module tree. On the Windows runner that alone has taken the test past
  // jest's five seconds, three times in one evening, on branches that did not
  // touch it. The budget is for the cold start, not for the pairing.
  const cold = 20_000

  it("pairs from a scanned code and names the machine before connecting", async () => {
    const onPaired = jest.fn()
    await render(
      <PairScanScreen permission={granted} requestPermission={jest.fn(async () => granted)} Scanner={scannerWith(encodePairingPayload(payload))} onPaired={onPaired} onCancel={jest.fn()} redeem={async () => credential} deviceName="iPhone" />,
    )
    expect(screen.getByText(/djs-macbook-pro-1/)).toBeTruthy()
    expect(screen.queryByTestId("tab-bar")).toBeNull()
    expect(screen.queryByText(credential.token)).toBeNull()
    // The phone checks shape, not scope; the promise is conditional.
    for (const line of phoneAndTabletPromise) expect(screen.getByText(line.text)).toBeTruthy()
    expect(screen.getByText(/cannot tell that credential from the machine's own/)).toBeTruthy()
    await fireEvent.press(screen.getByRole("button", { name: "Pair with this machine" }))
    await waitFor(() => expect(onPaired).toHaveBeenCalledWith(credential))
  }, cold)
  it("says what a wrong code is and keeps scanning", async () => {
    await render(
      <PairScanScreen permission={granted} requestPermission={jest.fn(async () => granted)} Scanner={scannerWith("https://example.com")} onPaired={jest.fn()} onCancel={jest.fn()} redeem={async () => credential} deviceName="iPhone" />,
    )
    expect(screen.getByText("This is not a Domovoi pairing code")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Pair with this machine" })).toBeNull()
  })

  it("keeps the typed fallback explicit beside the camera", async () => {
    await render(
      <PairScanScreen permission={granted} requestPermission={jest.fn(async () => granted)} Scanner={scannerWith("")} onPaired={jest.fn()} onCancel={jest.fn()} redeem={async () => credential} deviceName="iPhone" />,
    )

    expect(screen.getByText("Point at the pairing code that domovoid pair prints on the machine.")).toBeTruthy()
    expect(screen.getByText("Or type the code")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Paste" })).toBeTruthy()
  })

  it("offers the pasted code when the camera is refused, and reads it the same way", async () => {
    const onPaired = jest.fn()
    await render(
      <PairScanScreen permission={denied} requestPermission={jest.fn(async () => denied)} Scanner={scannerWith("")} onPaired={onPaired} onCancel={jest.fn()} redeem={async () => credential} deviceName="iPhone" />,
    )
    expect(screen.getByText("Camera refused")).toBeTruthy()
    await fireEvent.changeText(screen.getByLabelText("Pairing code"), encodePairingPayload(payload))
    expect(screen.getByText(/djs-macbook-pro-1/)).toBeTruthy()
    await fireEvent.press(screen.getByRole("button", { name: "Pair with this machine" }))
    await waitFor(() => expect(onPaired).toHaveBeenCalledWith(credential))
  })

  it("spends the code for a credential and never shows the credential", async () => {
    const onPaired = jest.fn()
    const redeem = jest.fn<(payload: PairingPayload, label: string) => Promise<PairedCredential>>(async () => credential)
    await render(
      <PairScanScreen permission={granted} requestPermission={jest.fn(async () => granted)} Scanner={scannerWith(encodePairingPayload(payload))} onPaired={onPaired} onCancel={jest.fn()} redeem={redeem} deviceName="iPhone" />,
    )
    await fireEvent.press(screen.getByRole("button", { name: "Pair with this machine" }))
    await waitFor(() => expect(onPaired).toHaveBeenCalledWith(credential))
    expect(redeem).toHaveBeenCalledWith(payload, "iPhone")
    expect(screen.queryByText(credential.token)).toBeNull()
  })

  it("says what to do when the machine refuses a spent code, and keeps the phone unpaired", async () => {
    const onPaired = jest.fn()
    const redeem = jest.fn<(payload: PairingPayload, label: string) => Promise<PairedCredential>>(async () => { throw new Error("The machine would not take this code. It may already have been used. Show a fresh one and scan again.") })
    await render(
      <PairScanScreen permission={granted} requestPermission={jest.fn(async () => granted)} Scanner={scannerWith(encodePairingPayload(payload))} onPaired={onPaired} onCancel={jest.fn()} redeem={redeem} deviceName="iPhone" />,
    )
    await fireEvent.press(screen.getByRole("button", { name: "Pair with this machine" }))
    await waitFor(() => expect(screen.getByText(/may already have been used/)).toBeTruthy())
    expect(onPaired).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Pair with this machine" })).toBeTruthy()
  })

  it("does not pair when the machine answers after the person cancelled", async () => {
    const onPaired = jest.fn()
    const onCancel = jest.fn()
    let finish: (value: PairedCredential) => void = () => {}
    const redeem = jest.fn<(payload: PairingPayload, label: string) => Promise<PairedCredential>>(
      () => new Promise((resolve) => { finish = resolve }),
    )
    await render(
      <PairScanScreen permission={granted} requestPermission={jest.fn(async () => granted)} Scanner={scannerWith(encodePairingPayload(payload))} onPaired={onPaired} onCancel={onCancel} redeem={redeem} deviceName="iPhone" />,
    )
    await fireEvent.press(screen.getByRole("button", { name: "Pair with this machine" }))
    await fireEvent.press(screen.getByRole("button", { name: "Cancel" }))
    expect(onCancel).toHaveBeenCalled()
    // The code is spent on the machine either way; what must not happen is
    // this phone taking a credential the person walked away from.
    finish(credential)
    await Promise.resolve()
    expect(onPaired).not.toHaveBeenCalled()
  })

  // The same guard covers the screen being unmounted, through the effect
  // cleanup in pair-scan.tsx. That path is not covered here: this preset
  // (RNTL 14 on React 19) does not run effect cleanups on unmount, so a test
  // for it would pass without exercising the guard.
})
