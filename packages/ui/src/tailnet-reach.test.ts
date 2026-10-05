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
    for (const action of ["on", "off"] as const) {
      expect(parseTailnetReachOutcome({ ok: true, report: on }, action)).toEqual({ ok: true, report: on })
      const failed = { ok: false, reason: "https-off", step: "certificate", message: "HTTPS certificates are off for tail4c2e.ts.net.", detail: "x" }
      expect(parseTailnetReachOutcome(failed, action)).toEqual(failed)
    }
    // Codex review round 6 (P3-2): a restart that failed after files could not be deleted names their directory.
    const retained = { ok: false, reason: "failed", step: "restart", message: "The daemon did not restart.", undeleted: "~/.domovoi/tls/.pending-Ab3xYz" }
    expect(parseTailnetReachOutcome(retained, "off")).toEqual(retained)
  })

  // Codex review of PR #722 (P3-2), Q439 B: a turn-off done whose status read
  // did not answer by its deadline, with the files it could not delete.
  it("reads a turn-off done without its status", () => {
    expect(parseTailnetReachOutcome({ ok: true, statusUnanswered: true }, "off")).toEqual({ ok: true, statusUnanswered: true })
    const left = { ok: true, statusUnanswered: true, undeleted: "~/.domovoi/tls/.pending-Ab3xYz" }
    expect(parseTailnetReachOutcome(left, "off")).toEqual(left)
  })

  // Codex review of PR #722, round 2 (P3-R2-2), Q441 A: a turn-off done whose
  // status read failed, in the read's own words.
  it("reads a turn-off done whose status read failed", () => {
    const failed = { ok: true, statusFailed: "spawn tailscale EACCES" }
    expect(parseTailnetReachOutcome(failed, "off")).toEqual(failed)
    const left = { ok: true, statusFailed: "spawn tailscale EACCES", undeleted: "~/.domovoi/tls/.pending-Ab3xYz" }
    expect(parseTailnetReachOutcome(left, "off")).toEqual(left)
    const longest = { ok: true, statusFailed: "x".repeat(4_096) }
    expect(parseTailnetReachOutcome(longest, "off")).toEqual(longest)
  })

  // Codex review of PR #722, round 2 (P3-2): a turn-on done whose status read
  // did not answer by its deadline, or failed in its own words.
  it("reads a turn-on done without its status or whose status read failed", () => {
    expect(parseTailnetReachOutcome({ ok: true, statusUnanswered: true }, "on")).toEqual({ ok: true, statusUnanswered: true })
    const failed = { ok: true, statusFailed: "spawn tailscale EACCES" }
    expect(parseTailnetReachOutcome(failed, "on")).toEqual(failed)
  })

  // Only a turn-off leaves files it set aside and could not delete, so only
  // its answer names them.
  it.each([
    { ok: true, statusUnanswered: true, undeleted: "~/.domovoi/tls/.pending-Ab3xYz" },
    { ok: true, statusFailed: "spawn tailscale EACCES", undeleted: "~/.domovoi/tls/.pending-Ab3xYz" },
    { ok: false, reason: "failed", step: "restart", message: "The daemon did not restart.", undeleted: "~/.domovoi/tls/.pending-Ab3xYz" },
  ])("refuses a turn-on outcome that names files a turn-off left: %j", (outcome) => {
    expect(() => parseTailnetReachOutcome(outcome, "on")).toThrow("The desktop sent an unreadable tailnet answer")
  })

  it.each([
    { ok: true, statusFailed: "" },
    { ok: true, statusFailed: "x".repeat(4_097) },
    { ok: true, statusFailed: true },
    { ok: true, statusFailed: { message: "x" } },
    { ok: true, statusFailed: "x", statusUnanswered: true },
    { ok: true, statusFailed: "x", report: on },
    { ok: true, statusFailed: "x", detail: "y" },
    { ok: true, statusFailed: "x", kept: "~/.domovoi/tls/.pending-Ab3xYz" },
    { ok: true, statusFailed: "x", undeleted: "" },
    { ok: true, report: on, undeleted: "~/.domovoi/tls/.pending-Ab3xYz" },
    { ok: false, reason: "failed", step: "delete", message: "x", statusFailed: "x" },
  ])("refuses a failed-read outcome %j", (outcome) => {
    for (const action of ["on", "off"] as const) expect(() => parseTailnetReachOutcome(outcome, action)).toThrow("The desktop sent an unreadable tailnet answer")
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
    for (const action of ["on", "off"] as const) expect(() => parseTailnetReachOutcome(outcome, action)).toThrow("The desktop sent an unreadable tailnet answer")
  })
})
