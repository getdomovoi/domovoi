import { describe, expect, it } from "vitest"

import { daemonRefusalReasons, type DaemonRefusalReason } from "../../shared/daemon-acquisition.js"
import { daemonConnectionCopy, daemonRefusalCopy, type DesktopDaemonCopy } from "./desktop-daemon-copy.js"

const daemonMessages: Record<DaemonRefusalReason, string> = {
  "owner-busy": "The local daemon owner changed during discovery. Try connecting again; no second daemon was started.",
  "owner-unreachable": "The profile has no reachable owner. Wait for the daemon to restart, or start it explicitly. No fallback daemon was started.",
  "owner-incompatible": "The local daemon uses an incompatible protocol. Update the daemon and Desktop, then reconnect.",
  "owner-unverified": "The local daemon could not prove its identity or accept this profile's credential. Check the running daemon and its profile; no fallback daemon was started.",
  "profile-invalid": "The local daemon profile is invalid or inaccessible. Check its owner record, private key and credential file before retrying.",
}

function expectPlainPunctuation(copy: DesktopDaemonCopy): void {
  for (const text of [copy.title, copy.detail]) {
    expect(text).not.toMatch(/[—!]/u)
    expect(text.trim()).toBe(text)
    expect(text.length).toBeGreaterThan(0)
  }
}

describe("daemonConnectionCopy", () => {
  it("says the daemon runs inside this app when Desktop owns it", () => {
    const copy = daemonConnectionCopy({ kind: "owned" })

    expect(copy.title).toBe("Running Domovoi inside this app")
    expect(copy.detail).toMatch(/quits/u)
    expectPlainPunctuation(copy)
  })

  it("says Desktop is connected to the installed service when a daemon owns the profile", () => {
    const copy = daemonConnectionCopy({ kind: "attached", owner: "daemon" })

    expect(copy.title).toBe("Connected to the installed Domovoi service")
    expect(copy.detail).toMatch(/keeps running/u)
    expectPlainPunctuation(copy)
  })

  it("names another Desktop as the owner without calling it a service", () => {
    const copy = daemonConnectionCopy({ kind: "attached", owner: "desktop" })

    expect(copy.title).toBe("Connected to the daemon another Domovoi Desktop started")
    expect(copy.title).not.toMatch(/service/u)
    expectPlainPunctuation(copy)
  })
})

describe("daemonRefusalCopy", () => {
  it.each(daemonRefusalReasons)("carries the daemon's own remedy for %s verbatim", (reason) => {
    const copy = daemonRefusalCopy({ reason, message: daemonMessages[reason] })

    expect(copy.detail).toBe(daemonMessages[reason])
    expect(copy.title).not.toBe(copy.detail)
    expectPlainPunctuation(copy)
  })

  it("names the remedy the daemon gives in each refusal", () => {
    expect(daemonRefusalCopy({ reason: "owner-busy", message: daemonMessages["owner-busy"] }).detail)
      .toMatch(/Try connecting again/u)
    expect(daemonRefusalCopy({ reason: "owner-unreachable", message: daemonMessages["owner-unreachable"] }).detail)
      .toMatch(/start it explicitly/u)
    expect(daemonRefusalCopy({ reason: "owner-incompatible", message: daemonMessages["owner-incompatible"] }))
      .toMatchObject({ title: expect.stringMatching(/update/iu), detail: expect.stringMatching(/Update the daemon and Desktop/u) })
  })

  it("gives every refusal reason a distinct title", () => {
    const titles = daemonRefusalReasons.map((reason) => daemonRefusalCopy({ reason, message: daemonMessages[reason] }).title)

    expect(new Set(titles).size).toBe(daemonRefusalReasons.length)
  })
})
