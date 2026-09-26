// Desktop V2's effort scales, as the design writes them: each harness's own
// name for the scale and, per level it names, the shared word and one line.
// "One vocabulary across harnesses, so switching model does not change the
// word you reach for." The levels a session can choose still come from what
// its model reports; this table only supplies the words the design draws for
// a level it names. A reported level the design does not name shows the value
// the harness reported and no line.
type EffortScale = {
  kind: string
  // claimsDefault: the line says this level is the default. Each model
  // reports its own default, so the line shows only on that level.
  levels: readonly { id: string, label: string, note: string, claimsDefault?: true }[]
}

const effortScales: Readonly<Record<string, EffortScale>> = {
  "claude-code": {
    kind: "thinking budget",
    levels: [
      { id: "think", label: "Low", note: "A short budget. Enough for a single-file edit or a question with one answer." },
      { id: "think-hard", label: "Medium", note: "The default here. Holds a multi-file change in view while it plans.", claimsDefault: true },
      { id: "ultrathink", label: "High", note: "The longest budget this harness offers. Slow and dear, and worth it on a plan you cannot check yourself." },
    ],
  },
  codex: {
    kind: "reasoning effort",
    levels: [
      { id: "low", label: "Low", note: "Answers quickly and stops reasoning early. Fine for triage." },
      { id: "medium", label: "Medium", note: "The default. Balances the time it spends against what it catches.", claimsDefault: true },
      { id: "high", label: "High", note: "Reasons longer before acting. Noticeably slower per turn." },
    ],
  },
  opencode: {
    kind: "reasoning effort",
    levels: [
      { id: "default", label: "Default", note: "Whatever the model does unprompted. The only level that is not a choice.", claimsDefault: true },
      { id: "low", label: "Low", note: "Stops reasoning early. Fine for triage and single-file edits." },
      { id: "medium", label: "Medium", note: "Balances the time it spends against what it catches." },
      { id: "high", label: "High", note: "Reasons longer before acting. Noticeably slower per turn." },
      { id: "max", label: "Max", note: "The longest this model will reason. Slow and dear, and worth it on a plan you cannot check yourself." },
    ],
  },
  kilo: {
    kind: "reasoning effort",
    levels: [
      { id: "default", label: "Default", note: "Whatever the model does unprompted. The only level that is not a choice.", claimsDefault: true },
      { id: "low", label: "Low", note: "Stops reasoning early. Fine for triage and single-file edits." },
      { id: "medium", label: "Medium", note: "Balances the time it spends against what it catches." },
      { id: "high", label: "High", note: "Reasons longer before acting. Noticeably slower per turn." },
      { id: "max", label: "Max", note: "The longest this model will reason. Slow and dear, and worth it on a plan you cannot check yourself." },
    ],
  },
}

// The design's shared words. A reported value that is one of them, in any
// case, reads as that word, so claude-code's "max" is "Max" as it is on kilo.
const sharedWords = ["Default", "Low", "Medium", "High", "Max"] as const

export type EffortLevel = { id: string, label: string | undefined, note: string | undefined }

export function effortScaleKind(provider: string): string | undefined {
  return effortScales[provider]?.kind
}

// A line that says the level is the default shows only when the model
// reports that level as its default; elsewhere the level has no line rather
// than a false claim.
export function effortLevel(provider: string, id: string, modelDefault?: string): EffortLevel {
  const named = effortScales[provider]?.levels.find((level) => level.id === id)
  if (named) return { id, label: named.label, note: named.claimsDefault && id !== modelDefault ? undefined : named.note }
  return { id, label: sharedWords.find((word) => word.toLowerCase() === id.toLowerCase()), note: undefined }
}

// What the chip and the clamp note call a level: the shared word, or the
// reported value when the design has no word for it.
export function effortName(provider: string, id: string): string {
  return effortLevel(provider, id).label ?? id
}
