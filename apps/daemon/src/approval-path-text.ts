import {
  isPathSeparator,
  operandPieces,
  pathKeys,
  shellWords,
  shellWordSpans,
  type ShellReading,
} from "./credential-stores.js"

// When a card hides a path, that path is replaced with "[REDACTED]" in the
// card's operation and command lines, and the rest of the agent's text stays.
// A path in the text matches a hidden path as written, at its real path when
// the card gives one, and in the forms the path classifier compares: Unicode
// NFKC with full case folding, either slash, repeated separators and "."
// dropped, ".." applied or not, and "~" as the home directory. A path that
// starts with a hidden directory has that directory replaced. A shell word
// the shell decodes into a hidden path, through quotes or escapes, is
// replaced whole when its written form does not show the path.

const hiddenMark = "[REDACTED]"

export type PathHider = Readonly<{
  // The text with every hidden path in it replaced.
  hide: (text: string) => string
  // Whether the text holds a hidden path.
  holds: (text: string) => boolean
}>

type Span = [start: number, end: number]

// A run of text read as one path: it ends at whitespace, a quote, a shell
// control operator, or a comma.
const literalRun = /[^\s'"`;|&<>(),]+/gu
const operandPiece = /[^=:]+/gu
const trailingPunctuation = /[.,;:!?]+$/u
const readings: readonly ShellReading[] = ["posix", "backslash-literal"]

function replaced(text: string, spans: readonly Span[]): string {
  const merged: Span[] = []
  for (const [start, end] of [...spans].sort((left, right) => left[0] - right[0] || right[1] - left[1])) {
    const last = merged.at(-1)
    if (last !== undefined && start < last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  let output = ""
  let cursor = 0
  for (const [start, end] of merged) {
    output += `${text.slice(cursor, start)}${hiddenMark}`
    cursor = end
  }
  return output + text.slice(cursor)
}

export function pathHider(paths: Iterable<string>): PathHider {
  const keys = new Set<string>()
  for (const path of paths) {
    if (path === "" || path.includes(hiddenMark)) continue
    for (const key of pathKeys(path)) keys.add(key)
  }

  const names = (candidate: string): boolean => candidate !== ""
    && [candidate, candidate.replace(/\\(.)/gu, "$1")].some((form) => pathKeys(form).some((key) => keys.has(key)))

  // The length of the longest start of the candidate that ends at a
  // component boundary and names a hidden path, the whole candidate first;
  // 0 when none does.
  const hiddenPrefix = (candidate: string): number => {
    const ends: number[] = []
    let position = 0
    for (const character of candidate) {
      if (position > 0 && isPathSeparator(character)) ends.push(position)
      position += character.length
    }
    for (const end of [candidate.length, ...ends.reverse()]) {
      if (names(candidate.slice(0, end))) return end
    }
    return 0
  }

  // A literal candidate, whole or without the punctuation prose puts after a
  // path.
  const hiddenIn = (candidate: string): number => (
    names(candidate) ? candidate.length : hiddenPrefix(candidate.replace(trailingPunctuation, ""))
  )

  const literalSpans = (text: string): Span[] => {
    const spans: Span[] = []
    for (const run of text.matchAll(literalRun)) {
      const token = run[0]
      const whole = hiddenIn(token)
      if (whole > 0) {
        spans.push([run.index, run.index + whole])
        continue
      }
      // An option's value after "=", or a path after ":".
      for (const piece of token.matchAll(operandPiece)) {
        if (piece[0] === token) continue
        const length = hiddenIn(piece[0])
        if (length > 0) spans.push([run.index + piece.index, run.index + piece.index + length])
      }
    }
    return spans
  }

  const decodedHolds = (word: string) => operandPieces(word).some((piece) => hiddenPrefix(piece) > 0)

  const hide = (text: string): string => {
    if (keys.size === 0) return text
    const spans = literalSpans(text)
    for (const reading of readings) {
      for (const word of shellWordSpans(text, reading)) {
        const written = text.slice(word.start, word.end)
        if (written === word.text || !decodedHolds(word.text)) continue
        const inside = spans
          .filter(([start, end]) => start >= word.start && end <= word.end)
          .map(([start, end]): Span => [start - word.start, end - word.start])
        if (shellWords(replaced(written, inside), reading).some(decodedHolds)) spans.push([word.start, word.end])
      }
    }
    return spans.length === 0 ? text : replaced(text, spans)
  }

  return { hide, holds: (text) => hide(text) !== text }
}
