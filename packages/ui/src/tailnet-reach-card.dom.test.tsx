import type { TailnetListenerStatus } from "@getdomovoi/protocol"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { TailnetReachCard, useTailnetReach, type TailnetReachSource } from "./tailnet-reach-card"

// TailnetReach (Q404 A), the card in desktop Settings, from TailnetReach in
// the v2 handoff. Every state is drawn from what the desktop and the daemon
// answer; nothing here runs Tailscale or a daemon.

afterEach(cleanup)
const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() })

const name = "studio.tail4c2e.ts.net"
const stored = `~/.domovoi/tls/${name}.crt, .key`
const off = { state: "off", name, address: "100.101.102.103", stored, httpsCertificates: true } as const
const on = { ...off, state: "on", certificateExpiresAt: "2026-12-20T12:00:00.000Z" } as const
const listening: TailnetListenerStatus = { state: "listening", address: "100.101.102.103", port: 47831, certificateExpiresAt: "2026-12-20T12:00:00.000Z" }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function Harness({ source }: { source: TailnetReachSource }) {
  const controller = useTailnetReach(source)
  return controller ? <TailnetReachCard controller={controller} /> : null
}

async function card(answers: Partial<Record<"status" | "on" | "off", unknown | (() => Promise<unknown>)>>, options: { inApp?: boolean; listener?: TailnetListenerStatus } = {}) {
  // A change that succeeds is what the next status read reports, as the desktop's is.
  let status = answers.status
  const act = vi.fn(async (action: "status" | "on" | "off") => {
    if (action === "status") return status
    const answer = answers[action]
    const outcome: unknown = typeof answer === "function" ? await (answer as () => Promise<unknown>)() : answer
    const settled = outcome as { ok?: boolean; report?: unknown }
    if (settled.ok === true) status = settled.report
    return outcome
  })
  const listener = vi.fn(async () => options.listener ?? { state: "off" as const })
  render(<Harness source={{ act, listener, inApp: options.inApp ?? true }} />)
  await settle()
  return { act, listener, user: userEvent.setup() }
}

const region = () => screen.getByRole("region", { name: "Reach this machine from my tailnet" })
const toggle = () => within(region()).getByRole("switch", { name: "Reach this machine from my tailnet" })

it("says there is no tailnet in Tailscale's words, and checks again on request", async () => {
  const { act: ask, user } = await card({ status: { state: "none", detail: "Domovoi found no tailscale command on this computer." } })
  expect(within(region()).getByText("No tailnet")).toBeTruthy()
  expect(within(region()).getByText("No tailnet interface found on this machine. Domovoi does not set one up for you.")).toBeTruthy()
  expect(within(region()).getByText("Domovoi found no tailscale command on this computer.")).toBeTruthy()
  expect((toggle() as HTMLButtonElement).disabled).toBe(true)
  expect(within(region()).getByText("Bring Tailscale up yourself, then check again.")).toBeTruthy()
  await user.click(within(region()).getByRole("button", { name: "Check again" }))
  await settle()
  expect(ask).toHaveBeenCalledTimes(2)
})

it("lists what turning it on changes and what Domovoi never touches while off", async () => {
  await card({ status: off })
  const view = within(region())
  expect(view.getByText("Off")).toBeTruthy()
  expect(view.getByText("Off. Only this computer can reach the daemon.")).toBeTruthy()
  expect(view.getByText(`${name} · read from Tailscale, not changed`)).toBeTruthy()
  expect(toggle().getAttribute("aria-checked")).toBe("false")
  expect(view.getByText("TURNING IT ON CHANGES")).toBeTruthy()
  expect(view.getByText("Asks Tailscale for a certificate for this machine's own name")).toBeTruthy()
  expect(view.getByText(`tailscale cert ${name}`)).toBeTruthy()
  expect(view.getByText("Stores the certificate and key in the Domovoi profile")).toBeTruthy()
  expect(view.getByText(stored)).toBeTruthy()
  expect(view.getByText("Restarts the service once so it answers on the tailnet")).toBeTruthy()
  expect(view.getByText("the daemon inside this app restarts")).toBeTruthy()
  expect(view.getByText("DOMOVOI NEVER TOUCHES")).toBeTruthy()
  for (const line of ["Tailnet settings, access rules or DNS entries", "Whether Tailscale is up, or who is signed in to it", "Any other machine on the tailnet"]) {
    expect(view.getByText(line)).toBeTruthy()
  }
  expect(view.getByText("Every certificate is recorded in public logs, so this machine's tailnet name becomes public.")).toBeTruthy()
  expect(view.getByText("Turning it off deletes those files and restarts the service on 127.0.0.1 only.")).toBeTruthy()
})

it("names the login service restart when the app runs on the service", async () => {
  await card({ status: off }, { inApp: false })
  expect(within(region()).getByText("the login service is updated and restarted")).toBeTruthy()
})

it("says when the tailnet has HTTPS certificates off before anything is tried", async () => {
  await card({ status: { ...off, httpsCertificates: false } })
  expect(within(region()).getByText("HTTPS certificates are off for tail4c2e.ts.net.")).toBeTruthy()
  expect(within(region()).getByText("A tailnet admin turns on HTTPS Certificates on the DNS page of the Tailscale admin console.")).toBeTruthy()
})

it("says why a hand-set DOMOVOI_HOST keeps the settings out of this app's daemon", async () => {
  const ignored = "DOMOVOI_HOST is set to 0.0.0.0 in this app's environment, so the daemon inside this app listens there and starts without the tailnet listener."
  await card({ status: { ...off, ignored } })
  expect(within(region()).getByText(ignored)).toBeTruthy()
  // The daemon would not use the settings, so the switch does not offer to turn on.
  expect((toggle() as HTMLButtonElement).disabled).toBe(true)
})

it("still turns off beside a hand-set DOMOVOI_HOST", async () => {
  const ignored = "DOMOVOI_HOST is set to 0.0.0.0 in this app's environment, so the daemon inside this app listens there and starts without the tailnet listener."
  await card({ status: { ...on, ignored } })
  expect((toggle() as HTMLButtonElement).disabled).toBe(false)
})

it("lists the steps while it turns on, then draws the name, the expiry and where it answers", async () => {
  const turning = deferred<unknown>()
  const { act: ask, user } = await card({ status: off, on: () => turning.promise }, { listener: listening })
  await user.click(toggle())
  const view = within(region())
  expect(ask).toHaveBeenCalledWith("on")
  expect(view.getByText("Turning on")).toBeTruthy()
  expect(view.getByText("Turning on. The steps run in this order.")).toBeTruthy()
  for (const step of ["Read the tailnet status", "Ask Tailscale for a certificate for this machine's own name", "Store the certificate and key in the Domovoi profile", "Restart the service so it answers on the tailnet"]) {
    expect(view.getByText(step)).toBeTruthy()
  }
  expect(view.getByText("tailscale status --json · reads only")).toBeTruthy()
  expect((toggle() as HTMLButtonElement).disabled).toBe(true)
  turning.resolve({ ok: true, report: on })
  await settle()
  expect(view.getByText("On")).toBeTruthy()
  expect(view.getByText("Devices on your tailnet can reach the daemon. Each one still has to pair.")).toBeTruthy()
  expect(toggle().getAttribute("aria-checked")).toBe("true")
  expect(view.getByText("Tailnet name")).toBeTruthy()
  expect(view.getByText("expires 20 Dec 2026")).toBeTruthy()
  expect(view.getByText("Renews on its own.")).toBeTruthy()
  expect(view.getByText("Stored in")).toBeTruthy()
  expect(view.getByText(`127.0.0.1 · ${name}`)).toBeTruthy()
})

it("stops at the certificate when HTTPS certificates are off, and tries again on request", async () => {
  const { act: ask, user } = await card({ status: { ...off, httpsCertificates: false }, on: { ok: false, reason: "https-off", step: "certificate", message: "HTTPS certificates are off for tail4c2e.ts.net." } })
  await user.click(toggle())
  await settle()
  const view = within(region())
  expect(view.getByText("Stopped")).toBeTruthy()
  expect(view.getByText("Stopped before storing or restarting anything.")).toBeTruthy()
  const alert = within(view.getByRole("alert"))
  expect(alert.getByText("HTTPS certificates are off for tail4c2e.ts.net")).toBeTruthy()
  expect(alert.getByText("A tailnet admin turns on HTTPS Certificates on the DNS page of the Tailscale admin console. Domovoi never falls back to plain HTTP or a self-signed certificate.")).toBeTruthy()
  expect(alert.getByText("The switch stays off. Nothing was stored and nothing restarted.")).toBeTruthy()
  expect(view.getAllByText("done")).toHaveLength(1)
  expect(view.getAllByText("failed")).toHaveLength(1)
  expect(view.getAllByText("not run")).toHaveLength(2)
  await user.click(alert.getByRole("button", { name: "Try again" }))
  await settle()
  expect(ask.mock.calls.filter(([action]) => action === "on")).toHaveLength(2)
})

it("carries the desktop's words when turning on fails", async () => {
  const { user } = await card({ status: off, on: { ok: false, reason: "failed", step: "certificate", message: `Tailscale did not issue a certificate for ${name}: context deadline exceeded. Nothing was stored and nothing restarted.`, detail: "context deadline exceeded" } })
  await user.click(toggle())
  await settle()
  const alert = within(within(region()).getByRole("alert"))
  expect(alert.getByText("Could not turn it on")).toBeTruthy()
  expect(alert.getByText(`Tailscale did not issue a certificate for ${name}: context deadline exceeded. Nothing was stored and nothing restarted.`)).toBeTruthy()
  expect(alert.getByText("context deadline exceeded")).toBeTruthy()
  expect(within(region()).getByText("The switch stays off.")).toBeTruthy()
})

it("draws a failed renewal with its expiry, and renews on request", async () => {
  const renewing = deferred<unknown>()
  const failedOn = { ...on, renewalFailed: { at: "2026-10-02T12:00:00.000Z", message: `Tailscale did not renew the certificate for ${name}: tailscaled did not answer.` } }
  const { act: ask, user } = await card({ status: failedOn, on: () => renewing.promise }, { listener: listening })
  const view = within(region())
  expect(view.getByText("Renewal failed")).toBeTruthy()
  expect(view.getByText("Still on. The certificate did not renew and expires on 20 Dec 2026.")).toBeTruthy()
  const alert = within(view.getByRole("alert"))
  expect(alert.getByText("The certificate did not renew")).toBeTruthy()
  expect(alert.getByText("Until 20 Dec 2026 paired devices keep connecting and new ones can pair. After that the daemon answers on this computer only until a renewal succeeds.")).toBeTruthy()
  // When it failed, in this computer's time, then the desktop's words.
  expect(alert.getByText(new RegExp(`^2 Oct \\d{2}:\\d{2} · Tailscale did not renew the certificate for ${name.replaceAll(".", "\\.")}: tailscaled did not answer\\.$`, "u"))).toBeTruthy()
  expect(alert.getByText("Domovoi also tries again on its own.")).toBeTruthy()
  expect(view.getByText("Renewal failed. Retrying on its own.")).toBeTruthy()
  await user.click(alert.getByRole("button", { name: "Renew now" }))
  expect(ask).toHaveBeenLastCalledWith("on")
  expect(view.getByText("Renewing")).toBeTruthy()
  expect(view.getByText("Renewing. Tailscale is asked for the certificate again, then the daemon restarts once.")).toBeTruthy()
  renewing.resolve({ ok: true, report: on })
  await settle()
  expect(view.getByText("On")).toBeTruthy()
})

it("says when the daemon does not answer on the tailnet, in the daemon's words", async () => {
  const refused: TailnetListenerStatus = { state: "refused", address: "100.101.102.103", retrying: true, reason: "The tailnet address 100.101.102.103 is not on this machine (EADDRNOTAVAIL)." }
  await card({ status: on }, { listener: refused })
  const view = within(region())
  expect(view.getByText("Not answering")).toBeTruthy()
  expect(view.getByText("On, but the daemon is not answering on the tailnet.")).toBeTruthy()
  const alert = within(view.getByRole("alert"))
  expect(alert.getByText("The daemon is not answering on the tailnet")).toBeTruthy()
  expect(alert.getByText(refused.reason)).toBeTruthy()
  expect(alert.getByText("The daemon tries the address again on its own.")).toBeTruthy()
  expect(alert.getByRole("button", { name: "Renew now" })).toBeTruthy()
})

it("turns off through the switch, listing the two steps", async () => {
  const turning = deferred<unknown>()
  const { act: ask, user } = await card({ status: on, off: () => turning.promise }, { listener: listening })
  await user.click(toggle())
  const view = within(region())
  expect(ask).toHaveBeenCalledWith("off")
  expect(view.getByText("Turning off")).toBeTruthy()
  expect(view.getByText("Delete the certificate and key from the Domovoi profile")).toBeTruthy()
  expect(view.getByText("Restart the service on this computer only")).toBeTruthy()
  turning.resolve({ ok: true, report: off })
  await settle()
  expect(view.getByText("Off")).toBeTruthy()
})
