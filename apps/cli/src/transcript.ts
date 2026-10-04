import type { ApprovalRequest, ClientKind, PolicyRefusalThreadItem, ThreadItem } from "@getdomovoi/protocol"

import { terminalSafe } from "./terminal-text.js"

// The lines a session transcript prints for a gate, a receipt and a policy
// refusal, laid out as the signed CLI transcripts design draws them (J44) and
// as rulings Q392 to Q394 settle them. The session commands that will print
// these are not built yet; the layout is fixed here so they inherit it.
//
// Q394 A: facts one per line, never a boxed card. Every state is also a word,
// so a line keeps its meaning without colour, survives a narrow column, and
// stays greppable in a CI log.
//
// Only what the wire carries is drawn. An approval has no "outside project"
// or "hard because" fact and no plan step, and a refusal has no "target it
// saw" or "recorded as"; those lines are left out rather than guessed.

const factWidth = 17
const choiceWidth = 13

// The header puts the id at the right edge, at least two spaces after the
// label, so a narrow terminal wraps nothing and loses nothing.
function header(label: string, id: string, columns: number): string {
  return `${label}${" ".repeat(Math.max(2, columns - label.length - id.length))}${id}`
}

// Every free-text value on these lines comes from the wire, so each is drawn
// through terminalSafe: a newline, an escape sequence or a directional
// override in one cannot add a line, restyle the terminal or reorder the
// facts after it. The permission mode is a validated enum and the step
// numbers are formatted here, so they are drawn as they are. Receipt fields
// are not isolated: right-to-left text in one field can still move a
// neighbouring number, such as the time, in a viewer that applies bidi
// ordering. Wrapping each field in renderer-owned isolates is the fix once a
// command prints this line.

function fact(key: string, value: string): string {
  return `  ${key.padEnd(factWidth)}${value}`
}

function placed(step: GateStep | undefined, rest: string): string {
  if (step === undefined) return rest
  if (step === "not-in-plan") return `asked by the agent, not in the plan · ${rest}`
  return `step ${step.n} of ${step.of} · ${rest}`
}

// Where the gate sits in the plan, when the caller knows: a step, a request
// the agent made outside the plan, or nothing, which prints nothing.
export type GateStep = { n: number; of: number } | "not-in-plan"

export type GateView = Pick<ApprovalRequest, "id" | "risk" | "operation" | "command" | "machine" | "agent" | "mode" | "directory" | "affects" | "network" | "estimatedDuration">
  & { execution: Pick<ApprovalRequest["execution"], "state">; toolServer?: Pick<NonNullable<ApprovalRequest["toolServer"]>, "name">; step?: GateStep }

type Choice = { key: "a" | "r" | "d"; label: string; hint: string }

// Allow once and Deny always; Always here only for an ordinary gate whose
// command the daemon resolved and that is not a tool-server call. A hard gate
// asks every time, the daemon refuses a standing rule for a command it could
// not resolve (ruled 2026-09-24), and a tool's arguments fit no execution
// record (ruled 2026-09-26).
function choices(gate: GateView): Choice[] {
  const always = gate.risk === "normal" && gate.execution.state === "resolved" && gate.toolServer === undefined
  return [
    { key: "a", label: "Allow once", hint: "" },
    ...(always ? [{ key: "r" as const, label: "Always here", hint: `${terminalSafe(gate.operation)} in ${terminalSafe(gate.directory)} on ${terminalSafe(gate.machine)}` }] : []),
    { key: "d", label: "Deny", hint: "" },
  ]
}

export function renderGate(gate: GateView, options: { columns?: number; prompt?: boolean } = {}): string {
  const columns = options.columns ?? 80
  const prompt = options.prompt ?? true
  const offered = choices(gate)
  const lines = [
    header(gate.risk === "hard-gate" ? "hard gate · waiting on your decision" : "waiting on your decision", terminalSafe(gate.id), columns),
    `  ${placed(gate.step, `${terminalSafe(gate.agent)} · ${gate.mode}`)}`,
    "",
    `  ${terminalSafe(gate.command)}`,
    "",
    fact("machine", terminalSafe(gate.machine)),
    fact("working dir", terminalSafe(gate.directory)),
    fact("affects", terminalSafe(gate.affects)),
    fact("network", terminalSafe(gate.network)),
    fact("estimated", terminalSafe(gate.estimatedDuration)),
  ]
  if (!prompt) lines.push(fact("offered", offered.map((choice) => choice.label).join(" · ")))
  if (prompt) {
    lines.push("")
    for (const choice of offered) lines.push(`  ${choice.key}  ${choice.label.padEnd(choiceWidth)}${choice.hint}`)
  }
  if (gate.risk === "hard-gate" && prompt) lines.push("  Always here is not offered. A hard gate asks every time.")
  return `${lines.join("\n")}\n`
}

// The prompt that follows the choices, naming only the keys on offer.
renderGate.ask = (gate: GateView): string => {
  const keys = choices(gate).map((choice) => choice.key)
  return `choose ${keys.slice(0, -1).join(", ")} or ${keys[keys.length - 1]}: `
}

// Q392 A: there are no accounts in M1, so the person is the paired device's
// label, beside the client kind and the machine the decision reached. The
// label comes from the device the daemon wrote on the receipt (ruling Q424 A),
// in the order the web and desktop receipt reads it: label, then client kind.
// A receipt without a device (the daemon credential, or a row written before
// the field) takes the label the caller supplies, and with none names the
// client kind alone, as the web and desktop receipt does. An Always decision
// has no line in the design, so it has none here either.
export type ReceiptView = {
  decision: "allow-once" | "deny" | "deny-explain"
  decidedBy: { label?: string; client: ClientKind }
  machine: string
  at: string
} & Pick<Extract<ThreadItem, { kind: "receipt" }>, "device">

export function renderReceipt(receipt: ReceiptView): string {
  const label = receipt.device?.label ?? receipt.decidedBy.label
  const decider = label === undefined ? receipt.decidedBy.client : `${terminalSafe(label)} · ${receipt.decidedBy.client}`
  const who = `${decider} on ${terminalSafe(receipt.machine)} · ${terminalSafe(receipt.at)}`
  if (receipt.decision === "allow-once") return `allowed once by ${who}\n`
  return `denied by ${who}\nThe agent was told and continues without it.\n`
}

// Q393 A: the local fields only. The design's "set by" and "applies to" name
// an org owner and an account, which are M4; in M1 the daemon fills them
// with the permission mode and the session, and that is what is drawn. The
// org-owner note is not drawn.
export type PolicyRefusalView = Pick<PolicyRefusalThreadItem, "id" | "operation" | "command" | "rule" | "setBy" | "scope" | "remedy">

export function renderPolicyRefusal(refusal: PolicyRefusalView, options: { columns?: number; step?: { n: number; of: number } } = {}): string {
  const columns = options.columns ?? 80
  const lines = [
    header("refused by policy, there is nothing to approve", terminalSafe(refusal.id), columns),
    `  ${placed(options.step, "refused by the daemon before it ran")}`,
    "",
    `  ${terminalSafe(refusal.command)}`,
    `  ${terminalSafe(refusal.operation)}`,
    "",
    fact("rule", terminalSafe(refusal.rule)),
    fact("set by", terminalSafe(refusal.setBy)),
    fact("applies to", terminalSafe(refusal.scope)),
    fact("override", "none, not even with approval"),
    "",
    "  what you can do instead",
    `    ${terminalSafe(refusal.remedy)}`,
  ]
  return `${lines.join("\n")}\n`
}
