import { describe, expect, it } from "vitest"

import { parseTailnetReachOutcome, parseTailnetReachReport } from "./tailnet-reach.js"

// TailnetReach (Q404 A): the desktop's answer, parsed to its exact shape
// before the Settings card or the pairing card draws anything from it.
describe("the TailnetReach answer", () => {
  const on = {
    state: "on", name: "studio.tail4c2e.ts.net", address: "100.101.102.103",
    stored: "~/.domovoi/tls/studio.tail4c2e.ts.net.crt, .key", httpsCertificates: true,
  }

  it.each([
    { state: "none", detail: "Domovoi found no tailscale command on this computer." },
    { ...on, state: "off" },
    on,
    { ...on, certificateExpiresAt: "2026-12-20T04:12:00.000Z" },
    { ...on, renewalFailed: { at: "2026-10-02T12:00:00.000Z", message: "Tailscale did not renew the certificate." } },
    { ...on, ignored: "DOMOVOI_HOST is set to 0.0.0.0 in this app's environment." },
    { ...on, state: "off", handSet: "The tailnet listener comes from DOMOVOI_TAILNET_ADDRESS set by hand in this app's environment, and the switch cannot clear it." },
    { ...on, kept: "~/.domovoi/tls/.pending-Ab3xYz" },
    { ...on, state: "off", setAside: "~/.domovoi/tls/.pending-Ab3xYz" },
    { ...on, state: "off", undeleted: "~/.domovoi/tls/.pending-Ab3xYz" },
    // Codex review round 6 (P3-1): named with no tailnet too.
    { state: "none", detail: "Tailscale is not running on this computer (Stopped).", undeleted: "~/.domovoi/tls/.pending-Ab3xYz" },
    { state: "none", detail: "Tailscale is not running on this computer (Stopped).", kept: "~/.domovoi/tls/.pending-Ab3xYz", setAside: "~/.domovoi/tls/.pending-Cd4wXy" },
  ])("reads a report: %j", (report) => {
    expect(parseTailnetReachReport(report)).toEqual(report)
  })

  it.each([
    ["no state", { detail: "x" }],
    ["an unknown state", { ...on, state: "renewing" }],
    ["a missing name", { ...on, name: undefined }],
    ["a none report with a name", { state: "none", detail: "x", name: "a" }],
    ["an extra key", { ...on, path: "/etc" }],
    ["a date that is not one", { ...on, certificateExpiresAt: "20 Dec 2026" }],
    ["a renewal failure without a message", { ...on, renewalFailed: { at: "2026-10-02T12:00:00.000Z" } }],
    ["a string for a boolean", { ...on, httpsCertificates: "true" }],
  ])("refuses a report with %s", (_label, report) => {
    expect(() => parseTailnetReachReport(report)).toThrow("The desktop sent an unreadable tailnet answer")
  })

  it("reads outcomes", () => {
    expect(parseTailnetReachOutcome({ ok: true, report: on })).toEqual({ ok: true, report: on })
    const failed = { ok: false, reason: "https-off", step: "certificate", message: "HTTPS certificates are off for tail4c2e.ts.net.", detail: "x" }
    expect(parseTailnetReachOutcome(failed)).toEqual(failed)
    // Codex review round 6 (P3-2): a restart that failed after files could not be deleted names their directory.
    const retained = { ok: false, reason: "failed", step: "restart", message: "The daemon did not restart.", undeleted: "~/.domovoi/tls/.pending-Ab3xYz" }
    expect(parseTailnetReachOutcome(retained)).toEqual(retained)
  })

  // Codex review of PR #722 (P3-2), Q439 B: a turn-off done whose status read
  // did not answer by its deadline, with the files it could not delete.
  it("reads a turn-off done without its status", () => {
    expect(parseTailnetReachOutcome({ ok: true, statusUnanswered: true })).toEqual({ ok: true, statusUnanswered: true })
    const left = { ok: true, statusUnanswered: true, undeleted: "~/.domovoi/tls/.pending-Ab3xYz" }
    expect(parseTailnetReachOutcome(left)).toEqual(left)
  })

  it.each([
    { ok: true },
    { ok: true, statusUnanswered: false },
    { ok: true, statusUnanswered: "yes" },
    { ok: true, statusUnanswered: true, report: on },
    { ok: true, statusUnanswered: true, kept: "~/.domovoi/tls/.pending-Ab3xYz" },
    { ok: true, statusUnanswered: true, undeleted: "" },
    { ok: true, undeleted: "~/.domovoi/tls/.pending-Ab3xYz" },
    { ok: false, reason: "failed", step: "restart", message: "x", statusUnanswered: true },
    { ok: false, reason: "lost", step: "status", message: "x" },
    { ok: false, reason: "failed", step: "renew", message: "x" },
    { ok: false, reason: "failed", step: "status" },
    { ok: true, report: { state: "on" } },
  ])("refuses outcome %j", (outcome) => {
    expect(() => parseTailnetReachOutcome(outcome)).toThrow("The desktop sent an unreadable tailnet answer")
  })
})
