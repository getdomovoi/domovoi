import type { ProviderPromptDelivery } from "@getdomovoi/protocol"

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
  if (sent.length === 0 && omissions.length === 0) return null

  return (
    <p
      role="note"
      aria-label="Prompt delivery"
      className="mt-1.5 flex flex-col gap-0.5 font-machine text-[9.5px] text-faint"
    >
      {sent.length > 0 ? <span>Sent with {sent.join(", ")}</span> : null}
      {omissions.map(({ label, reason }) => (
        <span key={`${reason}-${label}`} className="text-warning">
          {label} omitted before send: {omissionCopy[reason]}
        </span>
      ))}
    </p>
  )
}
