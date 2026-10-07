// Desktop V2's effort scales, as the design writes them: each harness's own
// name for the scale and, per level it names, the shared word and one line.
// "One vocabulary across harnesses, so switching model does not change the
// word you reach for." The levels a session can choose still come from what
// its model reports; this table only supplies the words the design draws for
// a level it names. The model's default is marked in the menu from what the
// model reports, so no line here claims to be the default.
type EffortScale = {
  kind: string
  levels: readonly { id: string, label: string, note: string }[]
}

// Maps rather than object literals: provider ids and level values come from
// the daemon, and a value such as "constructor" must not read a prototype
// member.
const effortScales: ReadonlyMap<string, EffortScale> = new Map([
  ["claude-code", {
    kind: "effort",
    levels: [
      { id: "low", label: "Low", note: "Short thinking. Enough for a single-file edit or a question with one answer." },
      { id: "medium", label: "Medium", note: "Holds a multi-file change in view while it plans." },
      { id: "high", label: "High", note: "Thinks longer before acting. Slower per turn." },
      { id: "max", label: "Max", note: "The longest this model will think. Slow and dear, for a plan you cannot check yourself." },
    ],
  }],
  ["codex", {
    kind: "reasoning effort",
    levels: [
      { id: "none", label: "None", note: "No reasoning before it answers. Fastest, and it misses things." },
      { id: "minimal", label: "Minimal", note: "The least reasoning that still plans. Fine for renames and lookups." },
      { id: "low", label: "Low", note: "Stops reasoning early. Fine for triage." },
      { id: "medium", label: "Medium", note: "Balances the time it spends against what it catches." },
      { id: "high", label: "High", note: "Reasons longer before acting. Noticeably slower per turn." },
      { id: "xhigh", label: "Extra high", note: "The longest codex will reason. Slow, for a plan you cannot check yourself." },
    ],
  }],
  ["opencode", {
    kind: "reasoning effort",
    levels: [
      { id: "unset", label: "Model's own", note: "Sends no effort value, so the model uses its own setting." },
      { id: "low", label: "Low", note: "Stops reasoning early. Fine for triage and single-file edits." },
      { id: "medium", label: "Medium", note: "Balances the time it spends against what it catches." },
      { id: "high", label: "High", note: "Reasons longer before acting. Noticeably slower per turn." },
      { id: "max", label: "Max", note: "The longest this model will reason. Slow and dear, for a plan you cannot check yourself." },
    ],
  }],
  ["kilo", {
    kind: "reasoning effort",
    levels: [
      { id: "unset", label: "Model's own", note: "Sends no effort value, so the model uses its own setting." },
      { id: "low", label: "Low", note: "Stops reasoning early. Fine for triage and single-file edits." },
      { id: "medium", label: "Medium", note: "Balances the time it spends against what it catches." },
      { id: "high", label: "High", note: "Reasons longer before acting. Noticeably slower per turn." },
      { id: "max", label: "Max", note: "The longest this model will reason. Slow and dear, for a plan you cannot check yourself." },
    ],
  }],
])

// The design's shared words by the value sent. A reported value that is one
// of them, in any case, reads as that word on any harness, so claude-code's
// "xhigh" is "Extra high" as it is on codex (ruling Q31). "unset" is not
// here: only the harnesses whose scale names it send no value for it.
const sharedWords: ReadonlyMap<string, string> = new Map([
  ["none", "None"],
  ["minimal", "Minimal"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Max"],
])

// The design's rank of its words, lowest first.
export const effortRank: readonly string[] = ["Model's own", "None", "Minimal", "Low", "Medium", "High", "Extra high", "Max"]

export type EffortLevel = { id: string, label: string | undefined, note: string | undefined }

export function effortScaleKind(provider: string): string | undefined {
  return effortScales.get(provider)?.kind
}

// A level the harness's scale names gets its word and line; a value that is
// a shared word gets the word and no line; any other value has no word.
export function effortLevel(provider: string, id: string): EffortLevel {
  const named = effortScales.get(provider)?.levels.find((level) => level.id === id)
  if (named) return { id, label: named.label, note: named.note }
  return { id, label: sharedWords.get(id.toLowerCase()), note: undefined }
}

// What the chip and the clamp note call a level: the shared word, or the
// reported value when Domovoi has no word for it.
export function effortName(provider: string, id: string): string {
  return effortLevel(provider, id).label ?? id
}
