import { describe, expect, it } from "vitest"

import { renderGate, renderPolicyRefusal, renderReceipt } from "./transcript.js"

const gate = {
  id: "apr_7f2c", risk: "normal" as const, operation: "prisma migrate", command: "pnpm -w prisma migrate deploy",
  machine: "mac-mini-m4", agent: "claude-code", mode: "build" as const, directory: "~/src/acme-api",
  affects: "dev database acme_dev · 1 migration", network: "localhost:5432 only", estimatedDuration: "~40s",
  execution: { state: "resolved" as const },
}

describe("renderGate (ruling Q394 A: facts one per line)", () => {
  it("draws the header, the command, then one fact per line, then the choices", () => {
    const text = renderGate({ ...gate, step: { n: 3, of: 4 } }, { columns: 80 })
    expect(text.split("\n")).toEqual([
      "waiting on your decision" + " ".repeat(80 - "waiting on your decision".length - "apr_7f2c".length) + "apr_7f2c",
      "  step 3 of 4 · claude-code · build",
      "",
      "  pnpm -w prisma migrate deploy",
      "",
      "  machine          mac-mini-m4",
      "  working dir      ~/src/acme-api",
      "  affects          dev database acme_dev · 1 migration",
      "  network          localhost:5432 only",
      "  estimated        ~40s",
      "",
      "  a  Allow once   ",
      "  r  Always here  prisma migrate in ~/src/acme-api on mac-mini-m4",
      "  d  Deny         ",
      "",
    ])
    expect(text).not.toMatch(/[│┌└├─]/)
  })

  it("names a hard gate, offers no Always here, and says why", () => {
    const text = renderGate({ ...gate, id: "apr_8b31", risk: "hard-gate", command: "rm -rf ~/.cache/prisma", step: "not-in-plan" }, { columns: 80 })
    expect(text).toMatch(/^hard gate · waiting on your decision +apr_8b31$/m)
    expect(text).toMatch(/^ {2}asked by the agent, not in the plan · claude-code · build$/m)
    expect(text).not.toContain("Always here  ")
    expect(text).toMatch(/^ {2}a {2}Allow once {3}$/m)
    expect(text).toMatch(/^ {2}d {2}Deny {9}$/m)
    expect(text).toMatch(/^ {2}Always here is not offered\. A hard gate asks every time\.$/m)
  })

  it("prints the offered line instead of the choices when nobody will be asked", () => {
    const text = renderGate({ ...gate, step: { n: 3, of: 4 } }, { columns: 80, prompt: false })
    expect(text).toMatch(/^ {2}offered {10}Allow once · Always here · Deny$/m)
    expect(text).not.toMatch(/^ {2}a {2}Allow once/m)
  })

  it("offers Allow once and Deny only for a tool server call", () => {
    const text = renderGate({ ...gate, toolServer: { name: "github" } }, { columns: 80 })
    expect(text).not.toContain("Always here")
    expect(text).toMatch(/^ {2}claude-code · build$/m)
    expect(text).toMatch(/^ {2}a {2}Allow once/m)
    expect(text).toMatch(/^ {2}d {2}Deny/m)
  })

  it("offers Allow once and Deny only when the daemon could not resolve the command (ruled 2026-09-24)", () => {
    const unresolved = { ...gate, execution: { state: "unresolved" as const } }
    const text = renderGate(unresolved, { columns: 80 })
    expect(text).not.toContain("Always here")
    expect(text).toMatch(/^ {2}a {2}Allow once {3}$/m)
    expect(text).toMatch(/^ {2}d {2}Deny {9}$/m)
    expect(renderGate(unresolved, { columns: 80, prompt: false })).toMatch(/^ {2}offered {10}Allow once · Deny$/m)
    expect(renderGate.ask(unresolved)).toBe("choose a or d: ")
  })

  it("asks for the keys it offers", () => {
    expect(renderGate(gate, { columns: 80 }).endsWith("\n")).toBe(true)
    expect(renderGate.ask({ ...gate })).toBe("choose a, r or d: ")
    expect(renderGate.ask({ ...gate, risk: "hard-gate" })).toBe("choose a or d: ")
  })

  it("keeps the id on the header line at any width, with at least two spaces before it", () => {
    const text = renderGate(gate, { columns: 20 })
    expect(text.split("\n")[0]).toBe("waiting on your decision  apr_7f2c")
  })
})

describe("renderReceipt (ruling Q392 A: the device label and client kind)", () => {
  it("names the decider by device label, client kind and machine", () => {
    expect(renderReceipt({ decision: "allow-once", decidedBy: { label: "dana", client: "cli" }, machine: "mac-mini-m4", at: "14:07:11" }))
      .toBe("allowed once by dana · cli on mac-mini-m4 · 14:07:11\n")
    expect(renderReceipt({ decision: "deny", decidedBy: { label: "dana", client: "cli" }, machine: "ci-runner-03", at: "14:21:03" }))
      .toBe("denied by dana · cli on ci-runner-03 · 14:21:03\nThe agent was told and continues without it.\n")
    expect(renderReceipt({ decision: "deny-explain", decidedBy: { label: "iPhone", client: "phone" }, machine: "mac-mini-m4", at: "14:21:03" }))
      .toMatch(/^denied by iPhone · phone on mac-mini-m4 · 14:21:03$/m)
  })
})

describe("renderPolicyRefusal (ruling Q393 A: local fields only)", () => {
  const refusal = {
    id: "ref_2e90", sessionId: "ses_4k2p9", kind: "policy-refusal" as const,
    operation: "Ask mode is read-only, so the daemon refused this write before it ran.",
    command: "pnpm -w prisma migrate deploy", rule: "Ask mode is read-only", setBy: "Domovoi permission mode",
    scope: "This session", remedy: "Switch to Plan or Build mode before asking the agent to write files.", createdAt: "2026-10-03T14:07:11.000Z",
  }

  it("draws the refusal with the fields the daemon sent and no org-owner line", () => {
    const text = renderPolicyRefusal(refusal, { columns: 80 })
    expect(text.split("\n")).toEqual([
      "refused by policy, there is nothing to approve" + " ".repeat(80 - "refused by policy, there is nothing to approve".length - "ref_2e90".length) + "ref_2e90",
      "  refused by the daemon before it ran",
      "",
      "  pnpm -w prisma migrate deploy",
      "  Ask mode is read-only, so the daemon refused this write before it ran.",
      "",
      "  rule             Ask mode is read-only",
      "  set by           Domovoi permission mode",
      "  applies to       This session",
      "  override         none, not even with approval",
      "",
      "  what you can do instead",
      "    Switch to Plan or Build mode before asking the agent to write files.",
      "",
    ])
    expect(text).not.toMatch(/org owner|org policy|account/)
  })

  it("places the refusal in the plan when the step is known", () => {
    expect(renderPolicyRefusal(refusal, { columns: 80, step: { n: 3, of: 4 } })).toMatch(/^ {2}step 3 of 4 · refused by the daemon before it ran$/m)
  })
})
