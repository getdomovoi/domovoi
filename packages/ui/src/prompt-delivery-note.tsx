import type { ProviderPromptDelivery } from "@getdomovoi/protocol"

import { formatTokenCount } from "./session-usage"

type OmissionReason = keyof ProviderPromptDelivery["skills"]["omitted"]

// Domovoi knows what it sent. It does not know what the provider did with it,
// so this copy never says a skill was used, followed, or applied.
const omissionCopy: Record<OmissionReason, string> = {
  budget: "no room in the prompt",
  limit: "too many skills for one turn",
  unavailable: "the file could not be read",
  reviewChanged: "its review changed",
  policy: "the session's permission mode excludes it",
}

function skillLabel(skillId: string, skillNames: Record<string, string>): string {
  return skillNames[skillId] ?? skillId
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`
}

function verb(total: number): string {
  return total === 1 ? "was" : "were"
}

function joinClauses(clauses: string[]): string {
  if (clauses.length < 3) return clauses.join(" and ")
  return `${clauses.slice(0, -1).join(", ")}, and ${clauses.slice(-1).join("")}`
}

// The composer drops open annotations for the total budget only. A handoff's
// counts also cover its own newest-items and size caps, so that line says
// "the prompt" rather than naming the budget.
function trimLines(delivery: ProviderPromptDelivery): string[] {
  const lines: string[] = []
  const { budget, limit } = delivery.annotations.omitted
  if (budget > 0) {
    lines.push(`${count(budget, "open annotation")} ${verb(budget)} trimmed to fit the prompt budget`)
  }
  if (limit > 0) {
    lines.push(`${count(limit, "open annotation")} ${verb(limit)} over the per-turn limit`)
  }
  if (delivery.handoff.status === "delivered") {
    const { threadItems, annotations, artifacts } = delivery.handoff.omitted
    const clauses = ([
      [threadItems, "older thread item"],
      [annotations, "annotation"],
      [artifacts, "artifact"],
    ] as const)
      .filter(([dropped]) => dropped > 0)
      .map(([dropped, noun]) => count(dropped, noun))
    if (clauses.length > 0) {
      const total = threadItems + annotations + artifacts
      lines.push(`${joinClauses(clauses)} from the handoff context ${verb(total)} trimmed to fit the prompt`)
    }
  }
  return lines
}

export function PromptDeliveryNote({
  delivery,
  skillNames,
}: {
  delivery: ProviderPromptDelivery | undefined
  skillNames: Record<string, string>
}) {
  // An absent record means the turn predates delivery tracking, which is not
  // the same fact as a turn that carried no skills.
  if (!delivery) return null

  const sent = delivery.skills.delivered.map((skill) => skillLabel(skill.id, skillNames))
  const omissions = (Object.keys(omissionCopy) as OmissionReason[]).flatMap((reason) => (
    delivery.skills.omitted[reason].map((skillId) => ({
      label: skillLabel(skillId, skillNames),
      reason,
    }))
  ))
  const trims = trimLines(delivery)
  if (sent.length === 0 && omissions.length === 0 && trims.length === 0) return null

  const { used, limit } = delivery.budget
  return (
    <p
      role="note"
      aria-label="Prompt delivery"
      title={`Prompt used ${formatTokenCount(used)} of ${formatTokenCount(limit)} code units`}
      className="mt-1.5 flex flex-col gap-0.5 font-machine text-[9.5px] text-faint"
    >
      {sent.length > 0 ? <span>Sent with {sent.join(", ")}</span> : null}
      {omissions.map(({ label, reason }) => (
        <span key={`${reason}-${label}`} className="text-warning">
          {label} omitted before send: {omissionCopy[reason]}
        </span>
      ))}
      {trims.map((line) => (
        <span key={line} className="text-warning">{line}</span>
      ))}
    </p>
  )
}
