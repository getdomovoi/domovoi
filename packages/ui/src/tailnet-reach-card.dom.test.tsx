import type { TailnetListenerStatus } from "@getdomovoi/protocol"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { StrictMode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { TailnetReachCard, tailnetReachDesktopDeadlineMs, useTailnetReach, type TailnetReachController, type TailnetReachSource } from "./tailnet-reach-card"

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

async function card(answers: Partial<Record<"status" | "on" | "off", unknown | (() => Promise<unknown>)>>, options: { inApp?: boolean; listener?: TailnetListenerStatus | "unknown"; listenerWhileOff?: TailnetListenerStatus } = {}) {
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
  // The daemon follows the switch: listener while it is on, listenerWhileOff
  // (no listener unless a test says otherwise) while it is off. "unknown":
  // the daemon did not answer tailnet.status.
  const listener = vi.fn(async () => {
    if (options.listener === "unknown") throw new Error("Daemon connection is not open")
    if ((status as { state?: string } | undefined)?.state !== "on") return options.listenerWhileOff ?? { state: "off" as const }
    return options.listener ?? { state: "off" as const }
  })
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

// Q436 B: past its deadline the desktop refuses the status read instead of
// answering no tailnet. With no report the card says Not known in the
// refusal's words, which the desktop bridge passes on without Electron's
// prefix; with a report it keeps that report and leaves the switch as it was.
it("says Not known when the desktop refuses the first read, and keeps a known report when a later read is refused", async () => {
  const reads = [
    () => Promise.reject(new Error("The desktop did not answer.")),
    () => Promise.resolve(off),
    () => Promise.reject(new Error("The desktop did not answer.")),
  ]
  const ask = vi.fn(async (action: "status" | "on" | "off") => {
    if (action !== "status") throw new Error("Nothing changes here")
    return reads.shift()!()
  })
  render(<Harness source={{ act: ask, listener: async () => ({ state: "off" as const }), inApp: true }} />)
  await settle()
  expect(within(region()).getByText("Not known")).toBeTruthy()
  expect(within(region()).getByText("The desktop did not answer.")).toBeTruthy()
  expect(region().textContent).not.toContain("Error invoking remote method")
  expect((toggle() as HTMLButtonElement).disabled).toBe(true)
  await userEvent.setup().click(within(region()).getByRole("button", { name: "Check again" }))
  await settle()
  expect(within(region()).getByText("Off")).toBeTruthy()
  await act(async () => { window.dispatchEvent(new Event("focus")) })
  await settle()
  expect(ask).toHaveBeenCalledTimes(3)
  expect(within(region()).getByText("Off")).toBeTruthy()
  expect(within(region()).queryByText("Not known")).toBeNull()
  expect(within(region()).queryByText("The desktop did not answer.")).toBeNull()
  expect((toggle() as HTMLButtonElement).disabled).toBe(false)
})

// Codex review round 1 (P3-6): "Only this computer" is said only when it is
// known: not beside a hand-set DOMOVOI_HOST beyond loopback, and not while
// the daemon's tailnet listener is not known, set by hand or not.
it.each([
  ["a hand-set DOMOVOI_HOST", { ...off, ignored: "DOMOVOI_HOST is set to 0.0.0.0 in this app's environment, so the daemon inside this app listens there and starts without the tailnet listener." }, undefined, "Off. The daemon also listens where DOMOVOI_HOST says, beyond this computer."],
  ["the tailnet listener not known", off, "unknown" as const, "Off. Whether the daemon answers anywhere but this computer is not known from here."],
  ["a hand-set listener not known", { ...off, handSet: "The tailnet listener comes from DOMOVOI_TAILNET_ADDRESS set by hand in this app's environment, and the switch cannot clear it." }, "unknown" as const, "Off. Whether the daemon answers anywhere but this computer is not known from here."],
])("does not say only this computer reaches the daemon with %s", async (_label, status, listener, line) => {
  await card({ status }, listener ? { listener } : {})
  const view = within(region())
  expect(view.getByText(line)).toBeTruthy()
  expect(view.queryByText("Off. Only this computer can reach the daemon.")).toBeNull()
})

// Codex review round 2 (P3): tailnet.status speaks for the second listener
// only. A daemon this app did not start may listen beyond this computer on its
// first, and the app's environment says nothing about that one.
it("does not say only this computer reaches a daemon this app did not start, with no tailnet listener", async () => {
  await card({ status: off }, { inApp: false })
  const view = within(region())
  expect(view.getByText("Off")).toBeTruthy()
  expect(view.getByText("Off. Whether the daemon answers anywhere but this computer is not known from here.")).toBeTruthy()
  expect(view.queryByText("Off. Only this computer can reach the daemon.")).toBeNull()
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
  // Review of 049b1383 (P3-a): the desktop renews, so only while it is open.
  expect(view.getByText("Renews on its own while this app is open.")).toBeTruthy()
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
  expect(alert.getByText("Domovoi also tries again on its own while this app is open.")).toBeTruthy()
  expect(view.getByText("Renewal failed. Retrying on its own while this app is open.")).toBeTruthy()
  await user.click(alert.getByRole("button", { name: "Renew now" }))
  expect(ask).toHaveBeenLastCalledWith("on")
  expect(view.getByText("Renewing")).toBeTruthy()
  expect(view.getByText("Renewing. Tailscale is asked for the certificate again, then the daemon restarts once.")).toBeTruthy()
  renewing.resolve({ ok: true, report: on })
  await settle()
  expect(view.getByText("On")).toBeTruthy()
})

// Re-review of 10dba4a2 (P3-2): a turn-on that ended installed-not-attached
// leaves the service listening while the desktop's record is gone. Off is not
// "only this computer" then; the card says so and offers turning off again.
it("says the daemon still answers on the tailnet while the switch is off, and turns it off again", async () => {
  const turning = deferred<unknown>()
  const { act: ask, user } = await card({ status: off, off: () => turning.promise }, { listenerWhileOff: listening })
  const view = within(region())
  expect(view.getByText("Still answering")).toBeTruthy()
  expect(view.getByText("The switch is off, but the daemon still answers on the tailnet.")).toBeTruthy()
  expect(view.queryByText("Off. Only this computer can reach the daemon.")).toBeNull()
  expect(view.getByText("Turning it off again clears the setting from the daemon and restarts it on 127.0.0.1 only.")).toBeTruthy()
  await user.click(view.getByRole("button", { name: "Turn it off again" }))
  expect(ask).toHaveBeenCalledWith("off")
  expect(view.getByText("Turning off")).toBeTruthy()
})

// Round 3 re-review (P3-3): previous files a change could not put back stay
// in a pending directory, and the card says where until someone moves them.
it.each([["off", off], ["on", on]] as const)("says where kept previous files are with the switch %s", async (_state, report) => {
  await card({ status: { ...report, kept: "~/.domovoi/tls/.pending-Ab3xYz" } }, { listener: listening })
  expect(within(region()).getByText("The previous certificate and key could not be put back and are in ~/.domovoi/tls/.pending-Ab3xYz.")).toBeTruthy()
})

// Round 4 review (P3-3): a directory found when the app started may be from a
// put-back that failed or from a change cut off before it finished, so the
// card says what it knows and no more.
it.each([["off", off], ["on", on]] as const)("says where an earlier set-aside certificate is with the switch %s", async (_state, report) => {
  await card({ status: { ...report, setAside: "~/.domovoi/tls/.pending-Ab3xYz" } }, { listener: listening })
  expect(within(region()).getByText("Domovoi found an earlier certificate and key it set aside in ~/.domovoi/tls/.pending-Ab3xYz. They may be from a change that did not finish.")).toBeTruthy()
  expect(within(region()).queryByText(/could not be put back/u)).toBeNull()
})

// Q417 A: turned off, the record gone, but the files set aside could not be
// deleted. Said at once, in the set-aside line's warning style.
it("says where the files a turn-off could not delete are", async () => {
  await card({ status: { ...off, undeleted: "~/.domovoi/tls/.pending-Ab3xYz" } })
  const line = within(region()).getByText("The certificate and key were set aside in ~/.domovoi/tls/.pending-Ab3xYz and could not be deleted.")
  expect(line.className).toContain("bg-warn-background")
  expect(within(region()).queryByText(/could not be put back/u)).toBeNull()
  expect(within(region()).getByText("Off")).toBeTruthy()
})

// Codex review round 6 (P3-1): turning off does not need Tailscale, so the
// files it could not delete are named with no tailnet too, as are the other
// directories still holding files.
it("says where retained files are when there is no tailnet", async () => {
  const none = { state: "none", detail: "Tailscale is not running on this computer (Stopped)." } as const
  await card({ status: { ...none, undeleted: "~/.domovoi/tls/.pending-Ab3xYz", kept: "~/.domovoi/tls/.pending-Cd4wXy", setAside: "~/.domovoi/tls/.pending-Ef5vWx" } })
  const view = within(region())
  expect(view.getByText("No tailnet")).toBeTruthy()
  expect(view.getByText("The certificate and key were set aside in ~/.domovoi/tls/.pending-Ab3xYz and could not be deleted.")).toBeTruthy()
  expect(view.getByText("The previous certificate and key could not be put back and are in ~/.domovoi/tls/.pending-Cd4wXy.")).toBeTruthy()
  expect(view.getByText("Domovoi found an earlier certificate and key it set aside in ~/.domovoi/tls/.pending-Ef5vWx. They may be from a change that did not finish.")).toBeTruthy()
})

// Codex review round 6 (P3-2): the restart failed after a turn-off deleted
// the record but could not delete the files it set aside. The deletion step
// is not drawn as done, and the next read names the directory.
it("does not mark the deletion done when the restart fails with files retained", async () => {
  const none = { state: "none", detail: "Tailscale is not running on this computer (Stopped)." } as const
  let status: unknown = on
  const ask = vi.fn(async (action: "status" | "on" | "off") => {
    if (action === "status") return status
    status = { ...none, undeleted: "~/.domovoi/tls/.pending-Ab3xYz" }
    return { ok: false, reason: "failed", step: "restart", message: "The daemon did not restart.", undeleted: "~/.domovoi/tls/.pending-Ab3xYz" }
  })
  render(<Harness source={{ act: ask, listener: async () => listening, inApp: true }} />)
  await settle()
  await userEvent.setup().click(toggle())
  await settle()
  const view = within(region())
  expect(view.queryByText("done")).toBeNull()
  expect(view.getAllByText("failed")).toHaveLength(2)
  expect(view.getByText("Could not turn it off")).toBeTruthy()
  expect(view.getByText("The daemon did not restart.")).toBeTruthy()
  expect(view.getByText("The certificate and key were set aside in ~/.domovoi/tls/.pending-Ab3xYz and could not be deleted.")).toBeTruthy()
  expect(toggle().getAttribute("aria-checked")).toBe("false")
})

// Round 3 re-review (P3-2): when the listener comes from DOMOVOI_TAILNET_*
// set by hand in this app's environment, turning off does not clear it, so
// the card says where it comes from instead of offering that.
it("says a hand-set listener is not the switch's to clear", async () => {
  const handSet = "The tailnet listener comes from DOMOVOI_TAILNET_ADDRESS set by hand in this app's environment, and the switch cannot clear it."
  await card({ status: { ...off, handSet } }, { listenerWhileOff: listening })
  const view = within(region())
  expect(view.getByText("The switch is off, but the daemon still answers on the tailnet.")).toBeTruthy()
  expect(view.getByText(handSet)).toBeTruthy()
  expect(view.queryByText("Turning it off again clears the setting from the daemon and restarts it on 127.0.0.1 only.")).toBeNull()
  expect(view.queryByRole("button", { name: "Turn it off again" })).toBeNull()
})

// Review of 049b1383 (P2-3): the switch on is not the daemon listening. A
// hand-set DOMOVOI_HOST, a service installed without the setting or a daemon
// this window did not reach all leave the record on and the listener off.
it("says the daemon is not answering on the tailnet when it reports no listener", async () => {
  await card({ status: on }, { listener: { state: "off" } })
  const view = within(region())
  expect(view.getByText("Not answering")).toBeTruthy()
  expect(view.getByText("On, but the daemon is not answering on the tailnet.")).toBeTruthy()
  expect(view.queryByText("Devices on your tailnet can reach the daemon. Each one still has to pair.")).toBeNull()
  expect(view.getByText("127.0.0.1 only")).toBeTruthy()
})

it("does not claim reach when the daemon has not said", async () => {
  await card({ status: on }, { listener: "unknown" })
  const view = within(region())
  expect(view.getByText("On. Whether the daemon answers on the tailnet is not known from here.")).toBeTruthy()
  expect(view.queryByText("Devices on your tailnet can reach the daemon. Each one still has to pair.")).toBeNull()
  expect(view.getByText("127.0.0.1 · the tailnet not confirmed")).toBeTruthy()
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

// Codex review of PR #722 (P3-2), Q439 B: the turn-off is done, but the
// desktop's status read after it did not answer by its deadline. The card
// says the switch was turned off and that what it reads now is not known,
// without a failure and without the Tailscale hint, keeps naming the files the
// turn-off could not delete, and draws the next answered read as usual.
it("says a turn-off is done and the switch not known when the desktop does not answer after it", async () => {
  const undeleted = "~/.domovoi/tls/.pending-Ab3xYz"
  const reads: (() => Promise<unknown>)[] = [
    () => Promise.resolve(on),
    () => Promise.reject(new Error("The desktop did not answer.")),
    () => Promise.resolve({ ...off, undeleted }),
  ]
  const ask = vi.fn(async (action: "status" | "on" | "off") => {
    if (action === "off") return { ok: true, statusUnanswered: true, undeleted }
    if (action === "on") throw new Error("Nothing turns on here")
    return reads.shift()!()
  })
  render(<Harness source={{ act: ask, listener: async () => ({ state: "off" as const }), inApp: true }} />)
  await settle()
  const user = userEvent.setup()
  await user.click(toggle())
  await settle()
  const view = within(region())
  expect(view.getByText("Not known")).toBeTruthy()
  expect(view.getByText("Turned off. The desktop did not answer when asked what the switch reads now.")).toBeTruthy()
  expect(view.queryByText("The desktop did not answer.")).toBeNull()
  expect(view.queryByText("Bring Tailscale up yourself, then check again.")).toBeNull()
  expect(view.queryByRole("alert")).toBeNull()
  expect(view.queryByText("Could not turn it off")).toBeNull()
  expect(view.getByText(`The certificate and key were set aside in ${undeleted} and could not be deleted.`)).toBeTruthy()
  await user.click(view.getByRole("button", { name: "Check again" }))
  await settle()
  expect(view.getByText("Off")).toBeTruthy()
  expect(view.queryByText("Not known")).toBeNull()
  expect(view.queryByText("Turned off. The desktop did not answer when asked what the switch reads now.")).toBeNull()
  expect(view.getByText(`The certificate and key were set aside in ${undeleted} and could not be deleted.`)).toBeTruthy()
})

// Codex review of PR #722, round 2 (P3-R2-2), Q441 A: the turn-off is done,
// but the desktop's status read after it failed in its own words. The card
// says so as it does for the deadline, with those words and one final period,
// and draws the next answered read as usual.
it.each([
  ["spawn tailscale EACCES", "Turned off. Reading what the switch reads now failed: spawn tailscale EACCES."],
  ["The tailscale command could not be started.", "Turned off. Reading what the switch reads now failed: The tailscale command could not be started."],
])("says a turn-off is done and the switch not known when the status read after it fails: %s", async (message, line) => {
  const undeleted = "~/.domovoi/tls/.pending-Ab3xYz"
  const reads: (() => Promise<unknown>)[] = [
    () => Promise.resolve(on),
    () => Promise.reject(new Error("The desktop did not answer.")),
    () => Promise.resolve({ ...off, undeleted }),
  ]
  const ask = vi.fn(async (action: "status" | "on" | "off") => {
    if (action === "off") return { ok: true, statusFailed: message, undeleted }
    if (action === "on") throw new Error("Nothing turns on here")
    return reads.shift()!()
  })
  render(<Harness source={{ act: ask, listener: async () => ({ state: "off" as const }), inApp: true }} />)
  await settle()
  const user = userEvent.setup()
  await user.click(toggle())
  await settle()
  const view = within(region())
  expect(view.getByText("Not known")).toBeTruthy()
  expect(view.getByText(line)).toBeTruthy()
  expect(region().textContent).not.toContain("..")
  expect(view.queryByText("Turned off. The desktop did not answer when asked what the switch reads now.")).toBeNull()
  expect(view.queryByText("Bring Tailscale up yourself, then check again.")).toBeNull()
  expect(view.queryByRole("alert")).toBeNull()
  expect(view.queryByText("Could not turn it off")).toBeNull()
  expect(view.getByText(`The certificate and key were set aside in ${undeleted} and could not be deleted.`)).toBeTruthy()
  expect(toggle().getAttribute("aria-checked")).toBe("false")
  expect((toggle() as HTMLButtonElement).disabled).toBe(true)
  await user.click(view.getByRole("button", { name: "Check again" }))
  await settle()
  expect(view.getByText("Off")).toBeTruthy()
  expect(view.queryByText("Not known")).toBeNull()
  expect(view.queryByText(line)).toBeNull()
  expect(view.getByText(`The certificate and key were set aside in ${undeleted} and could not be deleted.`)).toBeTruthy()
  expect((toggle() as HTMLButtonElement).disabled).toBe(false)
})

// The desktop's refusal of a change while another holds the switch
// (apps/desktop/src/main/tailnet-reach.ts #exclusive).
const busy = { ok: false, reason: "busy", step: "status", message: "The switch is already changing." } as const

// A card whose controller the test also calls directly, as a caller of turnOn
// or turnOff outside the card could. Every control that starts a change is
// disabled while one runs, so only such a caller can ask for two at once.
function controlled(source: TailnetReachSource): () => TailnetReachController {
  let controller: TailnetReachController | undefined
  function Shared() {
    controller = useTailnetReach(source)
    return controller ? <TailnetReachCard controller={controller} /> : null
  }
  render(<Shared />)
  return () => controller!
}

const statusReads = (ask: { mock: { calls: unknown[][] } }) => ask.mock.calls.filter(([action]) => action === "status").length

// Codex review of PR #722, round 2 (P3-R2-1) and round 3 (P3-R3-1): with
// Q439 B the desktop releases the switch before a turn-off's status read, so
// a turn-on asked for while that turn-off waits would reach the desktop. The
// controller runs one change at a time instead: until the turn-off and the
// read after it have ended, a turn-on is refused as busy, as the desktop
// refuses one, and never reaches the desktop. Round 2's scenario, a turn-on
// that starts and ends while the turn-off waits, is therefore no longer
// reachable from one controller; this is the one that is. The turn-off's
// answer stands, and a failed read after it does not bring back the earlier
// report.
it("refuses a turn-on while a turn-off is still under way, and keeps the turn-off's answer", async () => {
  const turningOff = deferred<unknown>()
  const reads: (() => Promise<unknown>)[] = [() => Promise.resolve(on), () => Promise.resolve(off)]
  const ask = vi.fn(async (action: "status" | "on" | "off") => {
    if (action === "off") return turningOff.promise
    if (action === "on") return { ok: true, report: on }
    return (reads.shift() ?? (() => Promise.reject(new Error("The desktop did not answer."))))()
  })
  const controller = controlled({ act: ask, listener: async () => { throw new Error("Daemon connection is not open") }, inApp: true })
  await settle()
  const user = userEvent.setup()
  await user.click(toggle())
  const view = within(region())
  expect(view.getByText("Turning off")).toBeTruthy()
  const before = statusReads(ask)
  let refused: unknown
  await act(async () => { refused = await controller().turnOn() })
  await settle()
  expect(refused).toEqual(busy)
  expect(ask).not.toHaveBeenCalledWith("on")
  expect(statusReads(ask)).toBe(before)
  expect(view.getByText("Turning off")).toBeTruthy()
  expect(view.queryByRole("alert")).toBeNull()
  await act(async () => { turningOff.resolve({ ok: true, report: off }) })
  await settle()
  expect(view.getByText("Off")).toBeTruthy()
  expect(view.queryByText("On")).toBeNull()
  expect(toggle().getAttribute("aria-checked")).toBe("false")
  expect(view.queryByRole("alert")).toBeNull()
  // A read that fails keeps the turn-off's answer.
  await act(async () => { window.dispatchEvent(new Event("focus")) })
  await settle()
  expect(view.getByText("Off")).toBeTruthy()
  expect(toggle().getAttribute("aria-checked")).toBe("false")
})

// Codex review of PR #722, round 3 (P3-R3-1): a change refused as busy does
// not end the change that is running. It changes nothing on the card, and the
// running change's answer is drawn when it comes.
it("refuses a turn-off while a turn-on runs, and draws the turn-on's answer", async () => {
  const turningOn = deferred<unknown>()
  let status: unknown = off
  const ask = vi.fn(async (action: "status" | "on" | "off") => {
    if (action === "status") return status
    if (action === "off") return busy
    const outcome = await turningOn.promise
    status = on
    return outcome
  })
  const controller = controlled({ act: ask, listener: async () => (status === on ? listening : { state: "off" as const }), inApp: true })
  await settle()
  const view = within(region())
  expect(view.getByText("Off")).toBeTruthy()
  let first: Promise<unknown> | undefined
  await act(async () => { first = controller().turnOn() })
  await settle()
  expect(view.getByText("Turning on")).toBeTruthy()
  const before = statusReads(ask)
  let refused: unknown
  await act(async () => { refused = await controller().turnOff() })
  await settle()
  expect(refused).toEqual(busy)
  expect(ask).not.toHaveBeenCalledWith("off")
  expect(statusReads(ask)).toBe(before)
  expect(view.getByText("Turning on")).toBeTruthy()
  expect((toggle() as HTMLButtonElement).disabled).toBe(true)
  expect(view.queryByRole("alert")).toBeNull()
  await act(async () => { turningOn.resolve({ ok: true, report: on }) })
  await settle()
  expect(await first).toEqual({ ok: true, report: on })
  expect(view.getByText("On")).toBeTruthy()
  expect(toggle().getAttribute("aria-checked")).toBe("true")
  expect((toggle() as HTMLButtonElement).disabled).toBe(false)
  expect(view.queryByRole("alert")).toBeNull()
})

// A change runs until the status read after it has ended; the next change is
// asked of the desktop as usual once it has.
it("refuses a change until the read after the last one ends, then runs the next one", async () => {
  const afterOn = deferred<unknown>()
  const reads: (() => Promise<unknown>)[] = [() => Promise.resolve(off), () => afterOn.promise, () => Promise.resolve(off)]
  // The daemon follows the switch, as the last change left it.
  let switched: unknown = off
  const ask = vi.fn(async (action: "status" | "on" | "off") => {
    if (action === "on") { switched = on; return { ok: true, report: on } }
    if (action === "off") { switched = off; return { ok: true, report: off } }
    return reads.shift()!()
  })
  const controller = controlled({ act: ask, listener: async () => (switched === on ? listening : { state: "off" as const }), inApp: true })
  await settle()
  const view = within(region())
  let first: Promise<unknown> | undefined
  await act(async () => { first = controller().turnOn() })
  await settle()
  expect(statusReads(ask)).toBe(2)
  expect(view.getByText("Turning on")).toBeTruthy()
  let refused: unknown
  await act(async () => { refused = await controller().turnOff() })
  expect(refused).toEqual(busy)
  expect(ask).not.toHaveBeenCalledWith("off")
  await act(async () => { afterOn.resolve(on) })
  await settle()
  expect(await first).toEqual({ ok: true, report: on })
  expect(view.getByText("On")).toBeTruthy()
  let second: unknown
  await act(async () => { second = await controller().turnOff() })
  await settle()
  expect(second).toEqual({ ok: true, report: off })
  expect(ask).toHaveBeenCalledWith("off")
  expect(statusReads(ask)).toBe(3)
  expect(view.getByText("Off")).toBeTruthy()
  expect(toggle().getAttribute("aria-checked")).toBe("false")
})

// Review of PR #713 (P2): a renewal fails, or the daemon refuses the tailnet
// listener at the certificate's expiry, with Settings open and nothing
// clicked. The card reads the switch and tailnet.status again when the window
// is focused or shown again, and every minute while it is shown.
describe("reading again while Settings stays open", () => {
  const expired: TailnetListenerStatus = { state: "refused", address: "100.101.102.103", retrying: false, reason: "The tailnet certificate expired on 2026-12-20, so the daemon answers on this computer only.", certificateExpiresAt: "2026-12-20T12:00:00.000Z" }
  const failedOn = { ...on, renewalFailed: { at: "2026-10-02T12:00:00.000Z", message: `Tailscale did not renew the certificate for ${name}: tailscaled did not answer.` } }

  function changing(initial: { status: unknown; listener: TailnetListenerStatus }) {
    const now = { ...initial }
    const ask = vi.fn(async () => now.status)
    const listener = vi.fn(async () => now.listener)
    render(<Harness source={{ act: ask, listener, inApp: true }} />)
    return { now, ask, listener }
  }

  afterEach(() => { vi.useRealTimers() })

  it("when the window is focused again", async () => {
    const { now } = changing({ status: on, listener: listening })
    await settle()
    expect(within(region()).getByText("Devices on your tailnet can reach the daemon. Each one still has to pair.")).toBeTruthy()
    now.listener = expired
    await act(async () => { window.dispatchEvent(new Event("focus")) })
    await settle()
    expect(within(region()).getByText("Not answering")).toBeTruthy()
    expect(within(region()).getByText(expired.reason)).toBeTruthy()
  })

  it("when the window is shown again", async () => {
    const { now } = changing({ status: on, listener: listening })
    await settle()
    now.status = failedOn
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")) })
    await settle()
    expect(within(region()).getByText("Renewal failed")).toBeTruthy()
  })

  it("every minute while the window is shown", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    const { now, ask } = changing({ status: on, listener: listening })
    await settle()
    expect(ask).toHaveBeenCalledTimes(1)
    now.status = failedOn
    await act(async () => { vi.advanceTimersByTime(59_999) })
    await settle()
    expect(ask).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(1) })
    await settle()
    expect(ask).toHaveBeenCalledTimes(2)
    expect(within(region()).getByText("Renewal failed")).toBeTruthy()
  })

  it("not while a change runs", async () => {
    const turning = deferred<unknown>()
    const ask = vi.fn(async (action: "status" | "on" | "off") => action === "off" ? turning.promise : on)
    render(<Harness source={{ act: ask, listener: async () => listening, inApp: true }} />)
    await settle()
    await userEvent.setup().click(toggle())
    expect(ask).toHaveBeenCalledTimes(2)
    await act(async () => { window.dispatchEvent(new Event("focus")) })
    await settle()
    expect(ask).toHaveBeenCalledTimes(2)
    turning.resolve({ ok: true, report: off })
    await settle()
  })

  // Codex review round 5 (P3): each status read off runs tailscale status, so
  // reads that come in while one waits do not start more. One read at a time;
  // what came in meanwhile is one more read once it ends, answered or not.
  function waiting() {
    const reads: { resolve(value: unknown): void; reject(cause: Error): void }[] = []
    const ask = vi.fn((action: "status" | "on" | "off"): Promise<unknown> => {
      if (action !== "status") return Promise.resolve({ ok: true, report: off })
      return new Promise((resolve, reject) => { reads.push({ resolve, reject }) })
    })
    render(<Harness source={{ act: ask, listener: async () => ({ state: "off" as const }), inApp: true }} />)
    return { reads, ask }
  }
  const all = () => {
    window.dispatchEvent(new Event("focus"))
    document.dispatchEvent(new Event("visibilitychange"))
    vi.advanceTimersByTime(60_000)
    window.dispatchEvent(new Event("focus"))
  }
  const hidden = (value: boolean) => {
    if (value) Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
    else Reflect.deleteProperty(document, "visibilityState")
  }
  afterEach(() => { hidden(false) })

  it("one at a time, and one more for what came in meanwhile", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    const { reads } = waiting()
    await settle()
    expect(reads).toHaveLength(1)
    await act(async () => { all() })
    await settle()
    expect(reads).toHaveLength(1)
    reads[0]!.resolve(on)
    await settle()
    expect(reads).toHaveLength(2)
    reads[1]!.resolve(on)
    await settle()
    expect(reads).toHaveLength(2)
  })

  it("one more after a read that failed, and the next once that ends", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    const { reads } = waiting()
    await settle()
    await act(async () => { all() })
    reads[0]!.reject(new Error("The desktop did not answer."))
    await settle()
    expect(reads).toHaveLength(2)
    reads[1]!.reject(new Error("The desktop did not answer."))
    await settle()
    await act(async () => { window.dispatchEvent(new Event("focus")) })
    await settle()
    expect(reads).toHaveLength(3)
  })

  it("none while the window is hidden, not even one that came in before", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    const { reads } = waiting()
    await settle()
    await act(async () => { window.dispatchEvent(new Event("focus")) })
    hidden(true)
    reads[0]!.resolve(on)
    await settle()
    await act(async () => { all() })
    await settle()
    expect(reads).toHaveLength(1)
    hidden(false)
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")) })
    await settle()
    expect(reads).toHaveLength(2)
  })

  // Codex review round 7 (P3): a desktop status that never answers must not
  // hold automatic reads forever. Past the deadline the listener is read again
  // on each trigger; the desktop is not asked again while its answer is still
  // pending, and is asked once more after it settles.
  it("reads the listener again past the desktop's deadline, and asks the desktop once more only after it answers", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] })
    const reads: { resolve(value: unknown): void }[] = []
    const now = { listener: { state: "off" } as TailnetListenerStatus }
    const ask = vi.fn((action: "status" | "on" | "off"): Promise<unknown> => {
      if (action !== "status") return Promise.resolve({ ok: true, report: off })
      return new Promise((resolve) => { reads.push({ resolve }) })
    })
    const listener = vi.fn(async () => now.listener)
    render(<Harness source={{ act: ask, listener, inApp: true }} />)
    await settle()
    expect(reads).toHaveLength(1)
    expect(listener).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(tailnetReachDesktopDeadlineMs - 1) })
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(1) })
    await settle()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(reads).toHaveLength(1)
    expect(within(region()).getByText("Not known")).toBeTruthy()
    expect(within(region()).getByText("The desktop did not answer.")).toBeTruthy()
    // The next read shares the pending desktop answer and ends at its own
    // deadline; a trigger meanwhile is one more read after it.
    now.listener = expired
    await act(async () => { window.dispatchEvent(new Event("focus")) })
    await settle()
    expect(listener).toHaveBeenCalledTimes(2)
    await act(async () => { vi.advanceTimersByTime(tailnetReachDesktopDeadlineMs) })
    await settle()
    expect(listener).toHaveBeenCalledTimes(3)
    expect(reads).toHaveLength(1)
    reads[0]!.resolve(on)
    await settle()
    expect(within(region()).getByText("Not answering")).toBeTruthy()
    expect(within(region()).getByText(expired.reason)).toBeTruthy()
    await act(async () => { window.dispatchEvent(new Event("focus")) })
    await settle()
    expect(reads).toHaveLength(2)
    expect(listener).toHaveBeenCalledTimes(4)
  })

  // Codex review round 8 (P3): an explicit check runs its own desktop call
  // beside the automatic one still pending, and must not make the automatic
  // reads lose track of it: past the next deadline the listener is read again
  // and the old call is still shared, so no third call starts. The explicit
  // check's answer is the newer one; the old call's late answer does not
  // replace it.
  it("keeps sharing the pending automatic desktop call across an explicit check", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] })
    const reads: { resolve(value: unknown): void }[] = []
    const ask = vi.fn((action: "status" | "on" | "off"): Promise<unknown> => {
      if (action !== "status") return Promise.resolve({ ok: true, report: off })
      return new Promise((resolve) => { reads.push({ resolve }) })
    })
    const listener = vi.fn(async () => ({ state: "off" as const }))
    render(<Harness source={{ act: ask, listener, inApp: true }} />)
    await settle()
    expect(reads).toHaveLength(1)
    await act(async () => { vi.advanceTimersByTime(tailnetReachDesktopDeadlineMs) })
    await settle()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(reads).toHaveLength(1)
    await act(async () => { fireEvent.click(within(region()).getByRole("button", { name: "Check again" })) })
    await settle()
    expect(reads).toHaveLength(2)
    expect(listener).toHaveBeenCalledTimes(3)
    reads[1]!.resolve(on)
    await settle()
    expect(toggle().getAttribute("aria-checked")).toBe("true")
    await act(async () => { vi.advanceTimersByTime(tailnetReachDesktopDeadlineMs) })
    await settle()
    expect(listener).toHaveBeenCalledTimes(4)
    expect(reads).toHaveLength(2)
    expect(toggle().getAttribute("aria-checked")).toBe("true")
    // The first call's late answer is older than the check's, so it is not drawn.
    reads[0]!.resolve(off)
    await settle()
    expect(toggle().getAttribute("aria-checked")).toBe("true")
    expect(within(region()).queryByText("Off")).toBeNull()
    // Once it has settled, the next trigger asks the desktop again.
    await act(async () => { window.dispatchEvent(new Event("focus")) })
    await settle()
    expect(reads).toHaveLength(3)
    expect(listener).toHaveBeenCalledTimes(5)
  })

  // Codex review round 7 (P3): a read queued while Settings was open starts
  // nothing once it is closed; Settings opened again reads on its own.
  it("starts no queued read after Settings closes, and reads again when it opens", async () => {
    const reads: { resolve(value: unknown): void }[] = []
    const ask = vi.fn((action: "status" | "on" | "off"): Promise<unknown> => {
      if (action !== "status") return Promise.resolve({ ok: true, report: off })
      return new Promise((resolve) => { reads.push({ resolve }) })
    })
    const source: TailnetReachSource = { act: ask, listener: async () => ({ state: "off" as const }), inApp: true }
    const first = render(<Harness source={source} />)
    await settle()
    expect(reads).toHaveLength(1)
    await act(async () => { window.dispatchEvent(new Event("focus")) })
    first.unmount()
    reads[0]!.resolve(on)
    await settle()
    expect(reads).toHaveLength(1)
    render(<Harness source={source} />)
    await settle()
    expect(reads).toHaveLength(2)
    reads[1]!.resolve(off)
    await settle()
    expect(reads).toHaveLength(2)
    expect(within(region()).getByText("Off")).toBeTruthy()
  })

  it("asks the desktop once when React replays the effect", async () => {
    const reads: { resolve(value: unknown): void }[] = []
    const ask = vi.fn((action: "status" | "on" | "off"): Promise<unknown> => {
      if (action !== "status") return Promise.resolve({ ok: true, report: off })
      return new Promise((resolve) => { reads.push({ resolve }) })
    })
    render(<StrictMode><Harness source={{ act: ask, listener: async () => ({ state: "off" as const }), inApp: true }} /></StrictMode>)
    await settle()
    expect(reads).toHaveLength(1)
    reads[0]!.resolve(off)
    await settle()
    expect(reads).toHaveLength(1)
    expect(within(region()).getByText("Off")).toBeTruthy()
    await act(async () => { window.dispatchEvent(new Event("focus")) })
    await settle()
    expect(reads).toHaveLength(2)
  })

  it("keeps what a change read over a read that started before it", async () => {
    const { reads, ask } = waiting()
    await settle()
    reads[0]!.resolve(on)
    await settle()
    await act(async () => { window.dispatchEvent(new Event("focus")) })
    await settle()
    expect(reads).toHaveLength(2)
    await userEvent.setup().click(toggle())
    await settle()
    expect(ask).toHaveBeenCalledWith("off")
    expect(reads).toHaveLength(3)
    reads[2]!.resolve(off)
    await settle()
    reads[1]!.resolve(on)
    await settle()
    expect(within(region()).getByText("Off")).toBeTruthy()
    expect(toggle().getAttribute("aria-checked")).toBe("false")
  })
})
