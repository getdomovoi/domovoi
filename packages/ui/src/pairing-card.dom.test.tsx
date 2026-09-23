import { encodePairingPayload, phoneAndTabletPromise } from "@getdomovoi/protocol"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { PairingCard, type IssuedPairingCode } from "./pairing-card"

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
afterEach(() => { cleanup(); vi.useRealTimers() })

const address = { url: "wss://mac-mini-m4.tail4c2e.ts.net:47831/rpc", label: "mac-mini-m4.tail4c2e.ts.net", loopback: false }
const issued = (overrides: Partial<IssuedPairingCode> = {}): IssuedPairingCode => ({
  code: "hearth-quiet-ember-42",
  expiresAt: new Date(Date.now() + 180_000).toISOString(),
  pairingAddress: address,
  ...overrides,
})

function card(overrides: Partial<Parameters<typeof PairingCard>[0]> = {}) {
  const onIssueCode = vi.fn(async () => issued())
  const onCopy = vi.fn(async () => {})
  render(<PairingCard connected onIssueCode={onIssueCode} onCopy={onCopy} {...overrides} />)
  return { onIssueCode, onCopy, user: userEvent.setup({ advanceTimers: vi.advanceTimersByTime }) }
}

it("offers a code for a phone, a tablet or a browser, and lists what a paired device can do", () => {
  card({ inAppDaemon: true })
  expect(screen.getByRole("button", { name: "Show a pairing code" })).toBeTruthy()
  expect(screen.getByText("A code lasts 180 seconds. Showing another cancels it.")).toBeTruthy()
  expect(screen.getByText("domovoid pair --client phone")).toBeTruthy()
  const grants = screen.getByRole("list", { name: "A PAIRED DEVICE CAN" })
  for (const line of phoneAndTabletPromise) expect(within(grants).getByText(line.text)).toBeTruthy()
  expect(screen.getByText("While the daemon runs inside this app, quitting the app disconnects every paired device.")).toBeTruthy()
})

it("shows the daemon's code, its address and a countdown, and copies what the device pastes", async () => {
  const { onIssueCode, onCopy, user } = card()
  await user.click(screen.getByRole("button", { name: "Show a pairing code" }))
  expect(onIssueCode).toHaveBeenCalledWith("phone")
  expect(await screen.findByText("hearth-quiet-ember-42")).toBeTruthy()
  expect(screen.getByText("Scan it with the Domovoi app, or paste the code.")).toBeTruthy()
  expect(screen.getByText(/^(3:00|2:59) left$/)).toBeTruthy()
  expect(screen.getByText("The QR holds this address and the code, never a credential:")).toBeTruthy()
  expect(screen.getByText("mac-mini-m4.tail4c2e.ts.net")).toBeTruthy()
  expect(screen.getByRole("img", { name: "Pairing code for mac-mini-m4.tail4c2e.ts.net" })).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Copy" }))
  expect(onCopy).toHaveBeenCalledWith(encodePairingPayload({ v: 1, url: address.url, code: "hearth-quiet-ember-42", label: address.label }))
  act(() => { vi.advanceTimersByTime(61_000) })
  expect(screen.getByText(/^1:5\d left$/)).toBeTruthy()
})

it("replaces a code on Show another and says the old one is dead, then expires", async () => {
  const { onIssueCode, user } = card()
  await user.click(screen.getByRole("button", { name: "Show a pairing code" }))
  await screen.findByText("hearth-quiet-ember-42")
  onIssueCode.mockResolvedValueOnce(issued({ code: "cedar-slow-lantern-07" }))
  await user.click(screen.getByRole("button", { name: "Show another" }))
  expect(await screen.findByText("cedar-slow-lantern-07")).toBeTruthy()
  expect(screen.getByText("The previous code no longer works.")).toBeTruthy()
  act(() => { vi.advanceTimersByTime(181_000) })
  expect(screen.getByText("The code expired")).toBeTruthy()
  expect(screen.getByText("No device paired with it.")).toBeTruthy()
  expect(screen.getByRole("button", { name: "Show another" })).toBeTruthy()
})

it("draws the browser's certificate line and the web flag", async () => {
  const { onIssueCode, user } = card()
  await user.click(screen.getByRole("button", { name: "Web browser" }))
  expect(screen.getByText("domovoid pair --client web")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Show a pairing code" }))
  expect(onIssueCode).toHaveBeenCalledWith("web")
  expect(await screen.findByText("A certificate warning means the address is not this machine's full tailnet name, or its certificate lapsed. Do not click through.")).toBeTruthy()
})

it("locks the code for a watching window and names the refusal", () => {
  card({ readOnly: true })
  expect(screen.getByRole("button", { name: "Show a pairing code" }).hasAttribute("disabled")).toBe(true)
  expect(screen.getByText("Locked: this window is watching only, and only a full client can ask for a code.")).toBeTruthy()
  expect(screen.getByText("pair.issue refused · watch_only_client")).toBeTruthy()
})

it("draws no QR when a phone could not reach or trust the daemon, and says which", async () => {
  const { onIssueCode, user } = card()
  onIssueCode.mockResolvedValueOnce(issued({ pairingAddress: { url: "ws://127.0.0.1:47831/rpc", loopback: true } }))
  await user.click(screen.getByRole("button", { name: "Show a pairing code" }))
  expect(await screen.findByText("No code: a phone cannot reach this daemon")).toBeTruthy()
  expect(screen.getByText("listening on 127.0.0.1 only")).toBeTruthy()
  expect(screen.queryByRole("img", { name: /Pairing code/ })).toBeNull()
  onIssueCode.mockResolvedValueOnce(issued({ pairingAddress: { problem: "This daemon serves no certificate, so a device has no address it can verify." } }))
  await user.click(screen.getByRole("button", { name: "Show another" }))
  expect(await screen.findByText("No code: a phone would not trust this daemon")).toBeTruthy()
  expect(screen.getByText("This daemon serves no certificate, so a device has no address it can verify.")).toBeTruthy()
})
