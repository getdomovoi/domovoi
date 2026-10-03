import type { ApprovalRequest, ClientKind, PolicyRefusalThreadItem } from "@getdomovoi/protocol"

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
  & { toolServer?: Pick<NonNullable<ApprovalRequest["toolServer"]>, "name">; step?: GateStep }

type Choice = { key: "a" | "r" | "d"; label: string; hint: string }

// Allow once and Deny always; Always here only for an ordinary gate that is
// not a tool-server call. A hard gate asks every time, and a tool's arguments
// fit no execution record (ruled 2026-09-26).
function choices(gate: GateView): Choice[] {
  const always = gate.risk === "normal" && gate.toolServer === undefined
  return [
    { key: "a", label: "Allow once", hint: "" },
    ...(always ? [{ key: "r" as const, label: "Always here", hint: `${gate.operation} in ${gate.directory} on ${gate.machine}` }] : []),
    { key: "d", label: "Deny", hint: "" },
  ]
}

export function renderGate(gate: GateView, options: { columns?: number; prompt?: boolean } = {}): string {
  const columns = options.columns ?? 80
  const prompt = options.prompt ?? true
  const offered = choices(gate)
  const lines = [
    header(gate.risk === "hard-gate" ? "hard gate · waiting on your decision" : "waiting on your decision", gate.id, columns),
    `  ${placed(gate.step, `${gate.agent} · ${gate.mode}`)}`,
    "",
    `  ${gate.command}`,
    "",
    fact("machine", gate.machine),
    fact("working dir", gate.directory),
    fact("affects", gate.affects),
    fact("network", gate.network),
    fact("estimated", gate.estimatedDuration),
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
// receipt on the wire names the client kind but not the label; the caller
// supplies it. An Always decision has no line in the design, so it has none
// here either.
export type ReceiptView = {
  decision: "allow-once" | "deny" | "deny-explain"
  decidedBy: { label: string; client: ClientKind }
  machine: string
  at: string
}

export function renderReceipt(receipt: ReceiptView): string {
  const who = `${receipt.decidedBy.label} · ${receipt.decidedBy.client} on ${receipt.machine} · ${receipt.at}`
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
    header("refused by policy, there is nothing to approve", refusal.id, columns),
    `  ${placed(options.step, "refused by the daemon before it ran")}`,
    "",
    `  ${refusal.command}`,
    `  ${refusal.operation}`,
    "",
    fact("rule", refusal.rule),
    fact("set by", refusal.setBy),
    fact("applies to", refusal.scope),
    fact("override", "none, not even with approval"),
    "",
    "  what you can do instead",
    `    ${refusal.remedy}`,
  ]
  return `${lines.join("\n")}\n`
}
