import {
  comparable,
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
// dropped, ".." applied or not, "~" as the home directory, and backslash
// escapes removed.
//
// The text is not split into words before it is matched (round 13): a file
// name can hold any character a word would end at, such as a comma, a space, a
// quote or a colon. A hidden path is found where the text holds its last
// component, and the text before that is read back to the start that names
// it: the longest that names it as written, or else the nearest that names it
// once ".." is applied, so a ".." does not reach back over the words before
// the path. It is replaced only when it is not part of a longer path: the
// character before it is not a name character or a separator, and the text
// after it does not go on with the same component. A path that starts with a
// hidden directory has that directory replaced. A shell word the shell decodes
// into a hidden path, through quotes or escapes, is replaced whole when its
// written form does not show the path.

const hiddenMark = "[REDACTED]"

export type PathHider = Readonly<{
  // The text with every hidden path in it replaced.
  hide: (text: string) => string
  // Whether the text holds a hidden path.
  holds: (text: string) => boolean
}>

type Span = [start: number, end: number]

// A character that goes on with a path component: a letter, a mark, a digit,
// a connector such as "_", "-" or ".". Every other character, such as a space,
// a quote, a comma or "=", can stand next to a path in text, and a file name
// can hold any of them.
const nameCharacter = /^[\p{L}\p{M}\p{N}\p{Pc}.-]$/u
const readings: readonly ShellReading[] = ["posix", "backslash-literal"]
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function characterAt(text: string, index: number): string | undefined {
  const code = text.codePointAt(index)
  return code === undefined ? undefined : String.fromCodePoint(code)
}

// Whether the text at end goes on with the component a match ends in: a name
// character other than ".", or a "." before one, as ".env.example" goes on
// from ".env". A "." before anything else ends a sentence.
function continues(text: string, end: number): boolean {
  const next = characterAt(text, end)
  if (next === undefined) return false
  if (next !== ".") return nameCharacter.test(next)
  const after = characterAt(text, end + 1)
  return after !== undefined && after !== "." && nameCharacter.test(after)
}

// The ends a match whose last component ends at anchor can take, longest
// first: through any separators and "." steps after it, each only where the
// text does not go on with the component.
function matchEnds(text: string, anchor: number): number[] {
  const ends: number[] = []
  let end = anchor
  if (!continues(text, end)) ends.push(end)
  for (let next = characterAt(text, end); next !== undefined && (next === "." || isPathSeparator(next)); next = characterAt(text, end)) {
    end += next.length
    if (!continues(text, end)) ends.push(end)
  }
  return ends.reverse()
}

// A backslash escapes the character after it as the classifier reads escapes:
// any character but a line break.
const escapedCharacter = /^[^\n\r\u{2028}\u{2029}]$/u

// The card's text with backslash escapes removed, with where each of its code
// units sits in the card's text.
function unescapedView(text: string): { text: string; at: number[] } {
  let unescaped = ""
  const at: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    if (text.charAt(index) === "\\" && escapedCharacter.test(text.charAt(index + 1))) index += 1
    unescaped += text.charAt(index)
    at.push(index)
  }
  return { text: unescaped, at }
}

// Case folding one grapheme at a time cannot see the word around it, so a
// final sigma is read as a sigma on both sides.
function looseForm(text: string): string {
  return comparable(text).replace(/\u{3c2}/gu, "\u{3c3}")
}

// Text in the classifier's form, one grapheme at a time. NFKC composes only
// within a grapheme, so the projection holds each component the way the
// classifier writes it. starts and ends map offsets in the card's text, at
// grapheme boundaries, to offsets in the projection and back.
type Projection = Readonly<{
  text: string
  // Projection offset to the card's text offsets that end there.
  ends: ReadonlyMap<number, readonly number[]>
  // The card's text offset of a grapheme start, or its end, to the projection.
  starts: ReadonlyMap<number, number>
}>

function project(text: string, at: (index: number) => number): Projection {
  let projected = ""
  const ends = new Map<number, number[]>()
  const starts = new Map<number, number>()
  for (const { segment, index } of graphemes.segment(text)) {
    starts.set(at(index), projected.length)
    projected += looseForm(segment)
    const end = at(index + segment.length - 1) + 1
    ends.set(projected.length, [...ends.get(projected.length) ?? [], end])
  }
  starts.set(text.length === 0 ? 0 : at(text.length - 1) + 1, projected.length)
  return { text: projected, ends, starts }
}

// Offsets in the card's text just past each place the projection holds one of
// these components.
function componentEnds(projection: Projection, components: ReadonlySet<string>): number[] {
  const found: number[] = []
  for (const component of components) {
    for (let at = projection.text.indexOf(component); at !== -1; at = projection.text.indexOf(component, at + 1)) {
      found.push(...projection.ends.get(at + component.length) ?? [])
    }
  }
  return found
}

// What one component does to the path around it, read from the right: a name
// stays unless a ".." after it takes it away, "." and an empty component are
// dropped, and ".." takes away the name before it. A component that holds a
// backslash can be several components, or one once escapes are removed, so it
// is read as up to that many ".." steps and no name.
type Step = Readonly<{ names: number; up: number }>

function stepOf(component: string): Step {
  const form = comparable(component)
  if (form.includes("\\")) return { names: 0, up: form.split("\\").length }
  if (form === "" || form === ".") return { names: 0, up: 0 }
  if (form === "..") return { names: 0, up: 1 }
  return { names: 1, up: 0 }
}

// Where the text splits into components at a character the classifier reads
// as "/". A backslash stays inside a component, since an escape can join it.
function slashComponents(text: string): Span[] {
  const components: Span[] = []
  let start = 0
  let index = 0
  for (const character of text) {
    if (/^\/+$/u.test(comparable(character))) {
      components.push([start, index])
      start = index + character.length
    }
    index += character.length
  }
  components.push([start, text.length])
  return components
}

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
  const keyComponents = [...keys].map((key) => key.split("/").filter((part) => part !== "").map(looseForm))
  const lastComponents = new Set(keyComponents.flatMap((parts) => parts.slice(-1)))
  // Any component of a hidden path, and the most components one has.
  const components = new Set(keyComponents.flat())
  const longestComponent = Math.max(0, ...[...components].map((part) => part.length))
  const mostComponents = Math.max(0, ...keyComponents.map((parts) => parts.length))

  // How a candidate names a hidden path: as written, only once ".." is
  // applied, or not at all. Each candidate is also read without backslash
  // escapes.
  const naming = (candidate: string): "written" | "collapsed" | undefined => {
    let kind: "collapsed" | undefined
    for (const form of [candidate, candidate.replace(/\\(.)/gu, "$1")]) {
      const forms = pathKeys(form)
      if (forms.length === 0) continue
      if (keys.has(forms[0]!)) return "written"
      if (keys.has(forms.at(-1)!)) kind = "collapsed"
    }
    return kind
  }
  const names = (candidate: string): boolean => candidate !== "" && naming(candidate) !== undefined

  const literalSpans = (text: string): Span[] => {
    const written = project(text, (index) => index)
    const unescaped = unescapedView(text)
    const anchors = new Set([
      ...componentEnds(written, lastComponents),
      ...(unescaped.text === text ? [] : componentEnds(project(unescaped.text, (index) => unescaped.at[index]!), lastComponents)),
    ])
    const pieces = slashComponents(text)

    // Where a path can start: the start of the text, or right after a
    // character that is neither a name character nor a separator.
    const starts: number[] = [0]
    let offset = 0
    for (const character of text) {
      offset += character.length
      if (offset < text.length && !nameCharacter.test(character) && !isPathSeparator(character)) starts.push(offset)
    }

    // Whether a candidate that starts at start, in the component from start
    // to end, can name a hidden path, read cheaply from the projection: a
    // first component that no ".." after it takes away is a component of a
    // hidden path, "." or empty, or "~". A component that holds a ".." step
    // or a backslash is read in full.
    const firstMayName = (start: number, end: number, up: number, steps: boolean): boolean => {
      if (up > 0 || steps) return true
      const from = written.starts.get(start)
      const to = written.starts.get(end)
      if (from === undefined || to === undefined) return true
      if (to - from > longestComponent) return false
      const first = written.text.slice(from, to)
      return first === "" || first === "." || first === "~" || components.has(first)
    }

    // The starts a path ending at end can have, oldest first. Components are
    // read from the end leftward; once more names stay than any hidden path
    // has, no start further left can name one.
    const candidateStarts = (end: number): number[] => {
      const found: number[] = []
      let piece = pieces.findLastIndex(([from]) => from < end || (from === end && end === 0))
      let names = 0
      let up = 0
      while (piece >= 0 && names <= mostComponents) {
        const [from, to] = pieces[piece]!
        const stop = Math.min(to, end)
        const step = stepOf(text.slice(from, stop))
        for (let index = starts.length - 1; index >= 0; index -= 1) {
          const start = starts[index]!
          if (start >= stop) continue
          if (start < from - 1) break
          // A start at the "/" before the component is a root.
          if (start === from - 1 || firstMayName(start, stop, up, step.up > 0)) found.push(start)
        }
        const taken = Math.min(up, step.names)
        names += step.names - taken
        up += step.up - taken
        piece -= 1
      }
      return found.reverse()
    }

    // The start of the hidden path that ends at end, if any.
    const startFor = (end: number): number | undefined => {
      let collapsed: number | undefined
      for (const start of candidateStarts(end)) {
        const kind = naming(text.slice(start, end))
        if (kind === "written") return start
        if (kind === "collapsed") collapsed = start
      }
      return collapsed
    }

    const spans: Span[] = []
    for (const anchor of anchors) {
      let best: Span | undefined
      for (const end of matchEnds(text, anchor)) {
        const start = startFor(end)
        if (start !== undefined && (best === undefined || start < best[0])) best = [start, end]
      }
      if (best !== undefined) spans.push(best)
    }
    return spans
  }

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
