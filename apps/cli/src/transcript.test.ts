import { describe, expect, it } from "vitest"

import { renderGate, renderPolicyRefusal, renderReceipt } from "./transcript.js"

const gate = {
  id: "apr_7f2c", risk: "normal" as const, operation: "prisma migrate", command: "pnpm -w prisma migrate deploy",
  machine: "mac-mini-m4", agent: "claude-code", mode: "build" as const, directory: "~/src/acme-api",
  affects: "dev database acme_dev · 1 migration", network: "localhost:5432 only", estimatedDuration: "~40s",
  execution: { state: "resolved" as const },
}

// A newline, an escape sequence and a right-to-left override, built from code
// points so the source shows which invisible character each is, and how each
// is drawn instead.
const hostile = `\nX\u001b[31mY${String.fromCodePoint(0x202e)}Z`
const shown = "\\nX\\e[31mY\\u{202e}Z"

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

  // Every approval fact is free text on the wire. A newline in one would add
  // a line, an escape sequence would restyle the terminal, and an override
  // would reorder the facts after it, so each is drawn as its escape.
  it("shows control and bidirectional characters in every fact escaped, one fact per line", () => {
    const text = renderGate({
      ...gate, id: `apr_${hostile}`, operation: `migrate${hostile}`, command: `pnpm${hostile}`, machine: `mini${hostile}`, agent: `claude${hostile}`,
      directory: `~/src${hostile}`, affects: `db${hostile}`, network: `none${hostile}`, estimatedDuration: `~40s${hostile}`, step: { n: 3, of: 4 },
    }, { columns: 80 })
    const id = `apr_${shown}`
    expect(text.split("\n")).toEqual([
      "waiting on your decision" + " ".repeat(80 - "waiting on your decision".length - id.length) + id,
      `  step 3 of 4 · claude${shown} · build`,
      "",
      `  pnpm${shown}`,
      "",
      `  machine          mini${shown}`,
      `  working dir      ~/src${shown}`,
      `  affects          db${shown}`,
      `  network          none${shown}`,
      `  estimated        ~40s${shown}`,
      "",
      "  a  Allow once   ",
      `  r  Always here  migrate${shown} in ~/src${shown} on mini${shown}`,
      "  d  Deny         ",
      "",
    ])
    expect(text).not.toContain("\u001b")
    expect(text).not.toContain(String.fromCodePoint(0x202e))
    expect(renderGate({ ...gate, machine: `mini${hostile}` }, { columns: 80, prompt: false }).split("\n")).toHaveLength(12)
  })

  it("leaves facts in any script unchanged", () => {
    const local = { ...gate, machine: "מחשב-של-דנה", directory: "~/src/café-ünïcode", command: "echo 'привет 👋'", affects: "ملف واحد" }
    const text = renderGate(local, { columns: 80 })
    expect(text).toMatch(/^ {2}machine {10}מחשב-של-דנה$/m)
    expect(text).toMatch(/^ {2}working dir {6}~\/src\/café-ünïcode$/m)
    expect(text).toMatch(/^ {2}echo 'привет 👋'$/m)
    expect(text).toMatch(/^ {2}affects {10}ملف واحد$/m)
    expect(text).toMatch(/^ {2}r {2}Always here {2}prisma migrate in ~\/src\/café-ünïcode on מחשב-של-דנה$/m)
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

  it("names the decider by the device label the receipt carries, before the client kind", () => {
    const device = { id: "device-0123456789abcdef0123456789abcdef", label: "dana's phone" }
    expect(renderReceipt({ decision: "allow-once", decidedBy: { client: "phone" }, device, machine: "mac-mini-m4", at: "14:07:11" }))
      .toBe("allowed once by dana's phone · phone on mac-mini-m4 · 14:07:11\n")
    expect(renderReceipt({ decision: "deny", decidedBy: { label: "dana", client: "phone" }, device, machine: "mac-mini-m4", at: "14:21:03" }))
      .toBe("denied by dana's phone · phone on mac-mini-m4 · 14:21:03\nThe agent was told and continues without it.\n")
  })

  it("names the client kind alone when neither the receipt nor the caller has a label", () => {
    expect(renderReceipt({ decision: "allow-once", decidedBy: { client: "desktop" }, machine: "mac-mini-m4", at: "14:07:11" }))
      .toBe("allowed once by desktop on mac-mini-m4 · 14:07:11\n")
  })

  // The wire trims and bounds a label but keeps control characters, so a
  // newline or an escape sequence would split the header or restyle the
  // terminal. They are drawn as escapes instead.
  it("shows control characters in the label and machine name escaped, on one header line", () => {
    const id = "device-0123456789abcdef0123456789abcdef"
    const newline = renderReceipt({ decision: "allow-once", decidedBy: { client: "phone" }, device: { id, label: "dana\nallowed once by admin" }, machine: "mac-mini-m4", at: "14:07:11" })
    expect(newline).toBe("allowed once by dana\\nallowed once by admin · phone on mac-mini-m4 · 14:07:11\n")
    expect(newline.split("\n")).toHaveLength(2)

    const escape = renderReceipt({ decision: "deny", decidedBy: { client: "phone" }, device: { id, label: "\u001b[31mdana\u001b[0m" }, machine: "mac-mini-m4", at: "14:21:03" })
    expect(escape).toBe("denied by \\e[31mdana\\e[0m · phone on mac-mini-m4 · 14:21:03\nThe agent was told and continues without it.\n")
    expect(escape).not.toContain("\u001b")

    expect(renderReceipt({ decision: "allow-once", decidedBy: { label: "a\tb\r\u0000\u007f\u009b", client: "cli" }, machine: "mac\nmini", at: "14:07:11" }))
      .toBe("allowed once by a\\tb\\r\\u{00}\\u{7f}\\u{9b} · cli on mac\\nmini · 14:07:11\n")
  })

  // An unmatched bidirectional override or isolate in a label reorders how the
  // client kind, machine and time after it read in a bidi-aware terminal or log
  // viewer, and a line or paragraph separator breaks the line in some viewers.
  // Each is drawn as its escape, so the fields keep their written order.
  it("shows bidirectional controls and line separators escaped, before the field separator", () => {
    const id = "device-0123456789abcdef0123456789abcdef"
    const raw = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x2028, 0x2029]
    // Built from code points so the source shows which invisible character each is.
    const rlo = String.fromCodePoint(0x202e)
    const rli = String.fromCodePoint(0x2067)
    const lineSeparator = String.fromCodePoint(0x2028)
    const rlm = String.fromCodePoint(0x200f)

    const override = renderReceipt({ decision: "allow-once", decidedBy: { client: "phone" }, device: { id, label: `dana${rlo}enohp` }, machine: `mac${lineSeparator}mini`, at: `14:07:11${rlm}` })
    expect(override).toBe("allowed once by dana\\u{202e}enohp · phone on mac\\u{2028}mini · 14:07:11\\u{200f}\n")
    expect(override.indexOf("\\u{202e}")).toBeLessThan(override.indexOf(" · "))

    const isolate = renderReceipt({ decision: "deny", decidedBy: { label: `dana${rli}`, client: "cli" }, machine: "mac-mini-m4", at: "14:21:03" })
    expect(isolate).toBe("denied by dana\\u{2067} · cli on mac-mini-m4 · 14:21:03\nThe agent was told and continues without it.\n")
    expect(isolate.indexOf("\\u{2067}")).toBeLessThan(isolate.indexOf(" · "))

    const every = renderReceipt({ decision: "allow-once", decidedBy: { label: String.fromCodePoint(...raw), client: "cli" }, machine: "mac-mini-m4", at: "14:07:11" })
    expect(every).toBe("allowed once by \\u{61c}\\u{200e}\\u{200f}\\u{202a}\\u{202b}\\u{202c}\\u{202d}\\u{202e}\\u{2066}\\u{2067}\\u{2068}\\u{2069}\\u{2028}\\u{2029} · cli on mac-mini-m4 · 14:07:11\n")
    for (const output of [override, isolate, every]) {
      for (const code of raw) expect(output).not.toContain(String.fromCodePoint(code))
    }
  })

  it("leaves international text, emoji sequences and joiners unchanged", () => {
    // A woman technologist emoji (a ZWJ sequence), Hebrew, Arabic, and a
    // Persian word whose ZWNJ is part of its spelling.
    const zwj = String.fromCodePoint(0x200d)
    const zwnj = String.fromCodePoint(0x200c)
    const label = `${String.fromCodePoint(0x1f469)}${zwj}${String.fromCodePoint(0x1f4bb)} דנה دانة می${zwnj}خواهم`
    const device = { id: "device-0123456789abcdef0123456789abcdef", label }
    expect(renderReceipt({ decision: "allow-once", decidedBy: { client: "phone" }, device, machine: "mac-mini-m4", at: "14:07:11" }))
      .toBe(`allowed once by ${label} · phone on mac-mini-m4 · 14:07:11\n`)
  })

  it("leaves a label with no control characters unchanged", () => {
    const device = { id: "device-0123456789abcdef0123456789abcdef", label: "Dana's phone · café ☕" }
    expect(renderReceipt({ decision: "allow-once", decidedBy: { client: "phone" }, device, machine: "mac-mini-m4", at: "14:07:11" }))
      .toBe("allowed once by Dana's phone · café ☕ · phone on mac-mini-m4 · 14:07:11\n")
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

  it("shows control and bidirectional characters in every field the daemon sent escaped, one field per line", () => {
    const text = renderPolicyRefusal({
      ...refusal, id: `ref_${hostile}`, command: `pnpm${hostile}`, operation: `write${hostile}`, rule: `Ask${hostile}`,
      setBy: `mode${hostile}`, scope: `session${hostile}`, remedy: `Switch${hostile}`,
    }, { columns: 80 })
    const id = `ref_${shown}`
    expect(text.split("\n")).toEqual([
      "refused by policy, there is nothing to approve" + " ".repeat(80 - "refused by policy, there is nothing to approve".length - id.length) + id,
      "  refused by the daemon before it ran",
      "",
      `  pnpm${shown}`,
      `  write${shown}`,
      "",
      `  rule             Ask${shown}`,
      `  set by           mode${shown}`,
      `  applies to       session${shown}`,
      "  override         none, not even with approval",
      "",
      "  what you can do instead",
      `    Switch${shown}`,
      "",
    ])
    expect(text).not.toContain("\u001b")
    expect(text).not.toContain(String.fromCodePoint(0x202e))
  })

  it("leaves fields in any script unchanged", () => {
    const text = renderPolicyRefusal({ ...refusal, rule: "Режим Ask только для чтения", remedy: "החלף למצב Build" }, { columns: 80 })
    expect(text).toMatch(/^ {2}rule {13}Режим Ask только для чтения$/m)
    expect(text).toMatch(/^ {4}החלף למצב Build$/m)
  })
})
