// The four the handoff offers. They are a starting sentence rather than the
// whole reply: tapping one writes it into the field so it can be finished, and
// tapping it again takes it back out.
export const denyReasons = [
  "Wrong environment",
  "After the release window",
  "Needs a second reviewer",
  "Run it on staging",
] as const

// A reason the daemon will refuse is a reason the person has to be told about
// here, not after the round trip. The schema takes 1 to 4096 characters after
// trimming, and a denial with nothing in it is the plain Deny it sits next to.
export const maximumExplanationCharacters = 4_096

export function explanationProblem(explanation: string): string | undefined {
  const trimmed = explanation.trim()
  if (trimmed.length === 0) {
    return "Write the reason the agent is given, or deny without one."
  }
  if (trimmed.length > maximumExplanationCharacters) {
    return `The reason is ${trimmed.length} characters. The daemon takes ${maximumExplanationCharacters}.`
  }
  return undefined
}

// Chips are joined onto whatever is already written rather than replacing it,
// so tapping two of them reads as one sentence instead of losing the first.
export function withReason(explanation: string, reason: string): string {
  const current = explanation.trim()
  if (current.length === 0) return reason
  return `${current}. ${reason}`
}

export function withoutReason(explanation: string, reason: string): string {
  return explanation
    .split(". ")
    .filter((part) => part.trim() !== reason)
    .join(". ")
}

export function reasonChosen(explanation: string, reason: string): boolean {
  return explanation.split(". ").some((part) => part.trim() === reason)
}
