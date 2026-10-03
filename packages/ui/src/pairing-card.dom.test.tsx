import { encodePairingPayload, phoneAndTabletPromise } from "@getdomovoi/protocol"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { CommandLinksProvider } from "./command-links"
import { PairingCard, type IssuedPairingCode } from "./pairing-card"
import type { TailnetReachController } from "./tailnet-reach-card"

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

// Q336 A: the command beside the code runs as printed on this machine.
it("names the shipped launcher by its full path where no link exists", async () => {
  const launcher = "/Applications/Domovoi.app/Contents/Resources/daemon-runtime/bin/domovoid"
  const commandLinks = vi.fn(async () => ({ report: { available: true, directory: "~/.local/bin", onPath: true, commands: [{ name: "domovoid", launcher, state: "absent" }] } }))
  render(<CommandLinksProvider bridge={{ commandLinks }}><PairingCard connected onIssueCode={vi.fn()} onCopy={vi.fn()} /></CommandLinksProvider>)
  expect(await screen.findByText(`${launcher} pair --client phone`)).toBeTruthy()
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
  // Q347 A: the daemon refuses device.issueCode from a watching credential
  // ("Watching-only credentials may only observe", apps/daemon/src/server.ts).
  expect(screen.getByText("device.issueCode refused · watching-only credential")).toBeTruthy()
  expect(screen.queryByText(/pair\.issue|watch_only_client/)).toBeNull()
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

// TailnetReach (Q404 A): with the desktop's switch present, the two problem
// boxes lead to it, as the design's pairing card does.
function controller(overrides: Partial<TailnetReachController> = {}): TailnetReachController {
  return {
    report: { state: "off", name: "mac-mini-m4.tail4c2e.ts.net", address: "100.101.102.103", stored: "~/.domovoi/tls/mac-mini-m4.tail4c2e.ts.net.crt, .key", httpsCertificates: true },
    readError: undefined, listener: undefined, running: undefined, failure: undefined, inApp: true,
    check: vi.fn(), turnOn: vi.fn(async () => undefined), turnOff: vi.fn(async () => undefined), revealed: 0, reveal: vi.fn(),
    ...overrides,
  }
}

it("leads a loopback daemon to the tailnet setting", async () => {
  const tailnet = controller()
  const { onIssueCode, user } = card({ tailnet })
  onIssueCode.mockResolvedValueOnce(issued({ pairingAddress: { url: "ws://127.0.0.1:47831/rpc", loopback: true } }))
  await user.click(screen.getByRole("button", { name: "Show a pairing code" }))
  await user.click(await screen.findByRole("button", { name: "Go to the tailnet setting" }))
  expect(tailnet.reveal).toHaveBeenCalledOnce()
})

it("asks Tailscale for a certificate when a phone would not trust the daemon", async () => {
  const tailnet = controller()
  const { onIssueCode, user } = card({ tailnet })
  onIssueCode.mockResolvedValueOnce(issued({ pairingAddress: { problem: "This daemon's certificate could not be read at /x, so there is no name to put in a pairing code." } }))
  await user.click(screen.getByRole("button", { name: "Show a pairing code" }))
  await user.click(await screen.findByRole("button", { name: "Get it from Tailscale" }))
  expect(tailnet.turnOn).toHaveBeenCalledOnce()
})

it("says what runs while Tailscale is asked, and keeps the code button until it ends", async () => {
  const onIssueCode = vi.fn(async () => issued({ pairingAddress: { problem: "No certificate." } }))
  const props = { connected: true, onIssueCode, onCopy: vi.fn(async () => {}) }
  const { rerender } = render(<PairingCard {...props} tailnet={controller()} />)
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  await user.click(screen.getByRole("button", { name: "Show a pairing code" }))
  await screen.findByRole("button", { name: "Get it from Tailscale" })
  rerender(<PairingCard {...props} tailnet={controller({ running: { direction: "on", renew: false } })} />)
  expect(screen.getByText("Asking Tailscale for a certificate")).toBeTruthy()
  expect(screen.getByText("tailscale cert mac-mini-m4.tail4c2e.ts.net")).toBeTruthy()
  expect(screen.getByText("The daemon restarts once the certificate is stored.")).toBeTruthy()
  expect(screen.getByText("The code button comes back when the certificate arrives.")).toBeTruthy()
  expect((screen.getByRole("button", { name: "Show another" }) as HTMLButtonElement).disabled).toBe(true)
})

it("says HTTPS certificates are off when Tailscale's status lists none", async () => {
  const tailnet = controller({ failure: { direction: "on", outcome: { ok: false, reason: "https-off", step: "certificate", message: "HTTPS certificates are off for tail4c2e.ts.net." } } })
  const { onIssueCode, user } = card({ tailnet })
  onIssueCode.mockResolvedValueOnce(issued({ pairingAddress: { problem: "No certificate." } }))
  await user.click(screen.getByRole("button", { name: "Show a pairing code" }))
  expect(await screen.findByText("No code: HTTPS certificates are off for this tailnet")).toBeTruthy()
  expect(screen.getByText("Domovoi stopped and changed nothing.")).toBeTruthy()
  expect(screen.getByText("A tailnet admin turns on HTTPS Certificates on the DNS page of the Tailscale admin console.")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Try again" }))
  expect(tailnet.turnOn).toHaveBeenCalledOnce()
})

it("offers neither action without the desktop's switch", async () => {
  const { onIssueCode, user } = card()
  onIssueCode.mockResolvedValueOnce(issued({ pairingAddress: { url: "ws://127.0.0.1:47831/rpc", loopback: true } }))
  await user.click(screen.getByRole("button", { name: "Show a pairing code" }))
  expect(await screen.findByText("No code: a phone cannot reach this daemon")).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Go to the tailnet setting" })).toBeNull()
})

it("names the chosen kind and drops the command-line tail when no code can be shown", async () => {
  const { onIssueCode, user } = card()
  await user.click(screen.getByRole("button", { name: "Web browser" }))
  onIssueCode.mockResolvedValueOnce(issued({ pairingAddress: { url: "ws://127.0.0.1:47831/rpc", loopback: true } }))
  await user.click(screen.getByRole("button", { name: "Show a pairing code" }))
  expect(await screen.findByText("No code: a browser on another device cannot reach this daemon")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Tablet" }))
  onIssueCode.mockResolvedValueOnce(issued({ pairingAddress: { problem: "This daemon serves no certificate, so a device has no address it can verify. Give it a DNS name with a certificate, then run this again." } }))
  await user.click(screen.getByRole("button", { name: /Show (a pairing code|another)/ }))
  expect(await screen.findByText("No code: a tablet would not trust this daemon")).toBeTruthy()
  expect(screen.getByText("This daemon serves no certificate, so a device has no address it can verify. Give it a DNS name with a certificate.")).toBeTruthy()
  expect(screen.queryByText(/run this again/)).toBeNull()
})

it("keeps naming the kind the code was issued for when the picker changes", async () => {
  const { onIssueCode, user } = card()
  onIssueCode.mockResolvedValueOnce(issued({ pairingAddress: { url: "ws://127.0.0.1:47831/rpc", loopback: true } }))
  await user.click(screen.getByRole("button", { name: "Show a pairing code" }))
  expect(await screen.findByText("No code: a phone cannot reach this daemon")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Tablet" }))
  expect(screen.getByText("No code: a phone cannot reach this daemon")).toBeTruthy()
  expect(screen.queryByText("No code: a tablet cannot reach this daemon")).toBeNull()
})
