const replacement = "[REDACTED]"

export const maximumDurableCommandLength = 8_192
export const maximumDurableOutputLength = 65_536
export const maximumDurableTextLength = 65_536
export const maximumStreamingOutputBufferLength = 8_192

export type RedactedText = {
  value: string
  redacted: boolean
  truncated: boolean
}

const sensitiveName = String.raw`(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|passwd|secret[_-]?key|secret|client[_-]?secret|credentials?|cookie|private[_-]?key|aws[_-]?secret[_-]?access[_-]?key|github[_-]?token|openai[_-]?api[_-]?key|azure[_-]?client[_-]?secret)`

// Where an unquoted value ends, and where a JSON or `name:` value ends.
const valueDelimiter = /[\s;&|\r\n]/u
const closedValueDelimiter = /[\s;&|,}\r\n]/u

// The shell's grouping constructs, which a value is read through. Each runs
// from its opener to its closer, across spaces and line breaks.
// at: where it opens outside every other construct. "start": only where a
// value starts, and the value is then a quoted value. "quote": anywhere in a
// word, as bash reads ab"c d" as one word, and where the value starts it makes
// the value a quoted value. "word": anywhere in a word. "inside": only within
// a construct that lists it. After any of them closes, the word goes on to its
// delimiter, as ab"c d"ef is one word; a quoted value keeps its quotes when it
// is hidden.
// inside: what opens within it. Anything else there is plain text, so a quote
// that is not listed does not open.
// escapes: a backslash escapes the next character within it. '…' takes
// escapes too, as the quoted value always has here.
// brokenAs: a closer of two characters whose second does not follow is read
// as this construct instead, as bash reads $((a) b) as $( (a) b).
// The reader and the differential fuzz both draw from this table, so a
// construct added here is read and fuzzed.
export type GroupingName =
  | "commandSubstitution" | "arithmetic" | "processInput" | "processOutput" | "parameter" | "backtick"
  | "doubleQuote" | "dollarDoubleQuote" | "singleQuote" | "dollarSingleQuote" | "array" | "parenthesis" | "brace"

export type GroupingConstruct = {
  opener: string
  closer: string
  at: "start" | "quote" | "word" | "inside"
  inside: readonly GroupingName[]
  escapes: boolean
  brokenAs?: GroupingName
}

// Within a substitution, every construct that opens in a word or where a
// value starts opens too.
const withinSubstitution: readonly GroupingName[] = [
  "commandSubstitution", "arithmetic", "processInput", "processOutput", "parameter", "backtick",
  "doubleQuote", "dollarDoubleQuote", "singleQuote", "dollarSingleQuote",
]
const withinDoubleQuote: readonly GroupingName[] = ["commandSubstitution", "arithmetic", "parameter", "backtick"]

export const groupingConstructs: Readonly<Record<GroupingName, GroupingConstruct>> = {
  commandSubstitution: { opener: "$(", closer: ")", at: "word", inside: [...withinSubstitution, "parenthesis"], escapes: true },
  arithmetic: { opener: "$((", closer: "))", at: "word", inside: [...withinSubstitution, "parenthesis"], escapes: true, brokenAs: "commandSubstitution" },
  processInput: { opener: "<(", closer: ")", at: "word", inside: [...withinSubstitution, "parenthesis"], escapes: true },
  processOutput: { opener: ">(", closer: ")", at: "word", inside: [...withinSubstitution, "parenthesis"], escapes: true },
  parameter: { opener: "${", closer: "}", at: "word", inside: [...withinSubstitution, "brace"], escapes: true },
  backtick: { opener: "`", closer: "`", at: "word", inside: [], escapes: true },
  doubleQuote: { opener: "\"", closer: "\"", at: "quote", inside: withinDoubleQuote, escapes: true },
  dollarDoubleQuote: { opener: "$\"", closer: "\"", at: "quote", inside: withinDoubleQuote, escapes: true },
  singleQuote: { opener: "'", closer: "'", at: "quote", inside: [], escapes: true },
  dollarSingleQuote: { opener: "$'", closer: "'", at: "quote", inside: [], escapes: true },
  // An array assignment, NAME=(a b).
  array: { opener: "(", closer: ")", at: "start", inside: withinSubstitution, escapes: true },
  parenthesis: { opener: "(", closer: ")", at: "inside", inside: [...withinSubstitution, "parenthesis"], escapes: true },
  brace: { opener: "{", closer: "}", at: "inside", inside: [...withinSubstitution, "brace"], escapes: true },
}

// The openers that may come next in one place: whole, and the starts of those
// longer than one character.
type Openers = { exact: ReadonlyMap<string, GroupingName>, starts: ReadonlySet<string> }

function openersOf(names: readonly GroupingName[]): Openers {
  const exact = new Map<string, GroupingName>()
  const starts = new Set<string>()
  for (const name of names) {
    const { opener } = groupingConstructs[name]
    exact.set(opener, name)
    for (let length = 1; length < opener.length; length += 1) starts.add(opener.slice(0, length))
  }
  return { exact, starts }
}

const groupingNames = Object.keys(groupingConstructs) as GroupingName[]
const quoteNames = groupingNames
  .filter((name) => groupingConstructs[name].at === "start" || groupingConstructs[name].at === "quote")
  .sort((left, right) => groupingConstructs[right].opener.length - groupingConstructs[left].opener.length)
// Outside every construct: what opens anywhere in a word, and what opens
// where a value starts.
const wordOpeners = openersOf(groupingNames.filter((name) => groupingConstructs[name].at === "word" || groupingConstructs[name].at === "quote"))
const valueStartOpeners = openersOf(groupingNames.filter((name) => groupingConstructs[name].at !== "inside"))
const openersInside = Object.fromEntries(groupingNames.map((name) => [name, openersOf(groupingConstructs[name].inside)])) as Record<GroupingName, Openers>
// Text holding none of these can hold no open value.
const anyValueOpener = new RegExp(
  [...valueStartOpeners.exact.keys()].map((opener) => opener.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"),
  "u",
)

// What a text starts with that opens only where a value starts, a quote or an
// array's (, as a value would open with it: $'…' and $"…" before '…' and "…".
function quoteAt(text: string, at = 0): GroupingConstruct | undefined {
  const name = quoteNames.find((quote) => text.startsWith(groupingConstructs[quote].opener, at))
  return name === undefined ? undefined : groupingConstructs[name]
}

// A value is read as shell syntax, one character at a time, through the
// constructs in groupingConstructs, so a value split across reads is followed
// from where the last read left it.
// - A value is a word, which runs to a delimiter. A construct that opens in
//   it, such as "…", $'…', $(…), ${…} or <(…), runs to its closer first,
//   across spaces and line breaks, and the word goes on after it.
// - A value that opens with a quote, "…", '…', $'…' or $"…", or with an
//   array's (, is a quoted value: hidden, it keeps its quotes.
// - Within a construct, what its entry lists opens, a backslash escapes the
//   next character, and its closer closes it.
// When the text ends first, the value runs to the end of the text; to: where
// to stop reading, as if the text ended there.
// A value inside a quote opened right before its name, as in set "NAME=value"
// or echo 'NAME=a b', starts inside that quote: it is read with the escapes of
// the table's entry for that quote, and as one shell word, so it goes on past
// the quote's closer to its delimiter (echo "NAME=a"b is NAME=ab).
// Where what came before a name is out of view, the value is still read as
// one shell word, so a quote in it opens, failing closed (ruled by fetzy
// 2026-09-24): a closing quote there may belong to a quote opened before the
// name, as in set "NAME=value" split by an idle flush, and then what follows
// is hidden until another quote arrives.
// The state is changed in place by each read, so a value nested however deep
// costs each read only what that read holds. A state belongs to one reading.
// stack: what is still open, innermost last. escaped: the last character was
// an escaping backslash. pending: the start of a longer opener read so far,
// such as $ or <. opened: the last character completed the innermost
// construct's opener, which the next may still lengthen, as ( turns $( into
// $((. closing: how much of the innermost construct's closer has been read,
// when it is longer than one character. word: the value is a word rather than
// a quoted value. fresh: nothing of the value has been read but a pending
// opener start, so a quote next opens a quoted value. nested: a construct has
// been opened.
type ValueState = {
  stack: GroupingName[]
  escaped: boolean
  pending: string
  opened: boolean
  closing: number
  word: boolean
  fresh: boolean
  nested: boolean
  delimiter: RegExp
}

function startValue(delimiter: RegExp): ValueState {
  return { stack: [], escaped: false, pending: "", opened: false, closing: 0, word: true, fresh: true, nested: false, delimiter }
}

// A value already inside a quote: one that opened it, or one inside a quote
// opened right before its name.
function quotedValueState(quote: GroupingName, delimiter: RegExp = valueDelimiter): ValueState {
  return { stack: [quote], escaped: false, pending: "", opened: false, closing: 0, word: false, fresh: false, nested: true, delimiter }
}

function quoteNamed(quote: string): GroupingName {
  return quote === "'" ? "singleQuote" : "doubleQuote"
}

// A character that opens, closes, escapes and delimits nothing: a letter, a
// digit or _ . - / @ + %, and inside a construct also a space. Anything else
// is read one character at a time.
function isPlainCharacter(code: number, inside: boolean): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39)
    || code === 0x5f || code === 0x2e || code === 0x2d || code === 0x2f || code === 0x40 || code === 0x2b || code === 0x25
    || (inside && code === 0x20)
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39
}

// [A-Za-z0-9_.-], and / with slash, tested on a character code.
function isNameCharacter(code: number, slash: boolean): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || isDigit(code)
    || code === 0x5f || code === 0x2e || code === 0x2d || (slash && code === 0x2f)
}

// Where a terminal control sequence at `at` ends, such as the colour ESC[1m:
// ESC [, parameter and intermediate bytes, then a final byte. -1 when there is
// none, or it does not end before `to`.
function controlSequenceEnd(text: string, at: number, to: number): number {
  if (text[at] !== "\u001b" || text[at + 1] !== "[") return -1
  for (let index = at + 2; index < to; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0x40 && code <= 0x7e) return index + 1
    if (code < 0x20 || code > 0x3f) return -1
  }
  return -1
}

// Reads a value from `from`. end: the index of the delimiter that ends the
// value, or -1 when the text ends first; state: where the reading stands.
function readValue(text: string, from: number, state: ValueState, to = text.length): { end: number, state: ValueState } {
  const stack = state.stack
  let { escaped, pending, opened, closing, word, fresh, nested } = state
  const finish = (end: number) => {
    Object.assign(state, { escaped, pending, opened, closing, word, fresh, nested })
    return { end, state }
  }
  const open = (name: GroupingName) => {
    stack.push(name)
    pending = ""
    opened = true
    nested = true
    // A quote or an array's ( where the value starts makes it a quoted value.
    if (stack.length === 1 && fresh && groupingConstructs[name].at !== "word") word = false
    fresh = false
  }
  for (let at = from; at < to; at += 1) {
    // A run of plain characters changes nothing once the value has started
    // and nothing is pending, so it is passed over in one step.
    if (!fresh && !escaped && !opened && closing === 0 && pending === "") {
      const inside = stack.length > 0
      let next = at
      while (next < to && isPlainCharacter(text.charCodeAt(next), inside)) next += 1
      if (next > at) {
        at = next - 1
        continue
      }
    }
    const character = text[at]!
    if (escaped) {
      escaped = false
      continue
    }
    if (closing > 0) {
      const construct = groupingConstructs[stack.at(-1)!]
      if (character === construct.closer[closing]) {
        closing += 1
        if (closing < construct.closer.length) continue
        closing = 0
        stack.pop()
        continue
      }
      // The closer broke off: what it closed was nested inside, and this
      // character is read within what the construct is read as instead.
      closing = 0
      if (construct.brokenAs !== undefined) stack[stack.length - 1] = construct.brokenAs
    }
    if (opened) {
      opened = false
      const top = stack.at(-1)!
      const within = stack.length > 1 ? openersInside[stack.at(-2)!] : wordOpeners
      const longer = within.exact.get(`${groupingConstructs[top].opener}${character}`)
      if (longer !== undefined) {
        stack[stack.length - 1] = longer
        opened = true
        continue
      }
    }
    const top = stack.at(-1)
    if (top === undefined) {
      if (state.delimiter.test(character)) return finish(at)
      // A doubled separator or terminal formatting where the value starts,
      // as in TOKEN==(a b) or TOKEN=ESC[1m(a b), leaves it starting, so what
      // opens only there still opens after it.
      if (fresh && pending === "") {
        if (character === "=" || character === ":") continue
        const formattingEnd = controlSequenceEnd(text, at, to)
        if (formattingEnd > 0) {
          at = formattingEnd - 1
          continue
        }
      }
      if (pending !== "") {
        const joined = `${pending}${character}`
        const pendingOpeners = fresh ? valueStartOpeners : wordOpeners
        const name = pendingOpeners.exact.get(joined)
        if (name !== undefined) {
          open(name)
          continue
        }
        if (pendingOpeners.starts.has(joined)) {
          pending = joined
          continue
        }
        // What was pending opened nothing: it is part of the word.
        pending = ""
        fresh = false
      }
      const openers = fresh ? valueStartOpeners : wordOpeners
      const name = openers.exact.get(character)
      if (name !== undefined) open(name)
      else if (openers.starts.has(character)) pending = character
      else fresh = false
      continue
    }
    const construct = groupingConstructs[top]
    if (construct.escapes && character === "\\") {
      escaped = true
      pending = ""
      continue
    }
    const openers = openersInside[top]
    if (pending !== "") {
      const joined = `${pending}${character}`
      const name = openers.exact.get(joined)
      if (name !== undefined) {
        open(name)
        continue
      }
      pending = openers.starts.has(joined) ? joined : ""
      if (pending !== "") continue
    }
    if (character === construct.closer[0]) {
      if (construct.closer.length > 1) {
        closing = 1
        continue
      }
      stack.pop()
      continue
    }
    const name = openers.exact.get(character)
    if (name !== undefined) open(name)
    else if (openers.starts.has(character)) pending = character
  }
  return finish(-1)
}

// A pattern that finds where a value starts: its name, the name's syntax, and
// a lookahead for the value's first character. The value itself is read by
// readValue, up to its delimiter.
type ValuePattern = { start: RegExp, delimiter: RegExp }
const valueStart = String.raw`(?=[^\s;&|\r\n])`
const structuredValueStart = String.raw`(?=[^\s,;&|}\r\n])`

// A sensitive name may carry an identifier prefix, as in NPM_TOKEN, db.password,
// npm's :_authToken or npm_config__authToken (a segment may be only its
// separator). It may not carry a suffix: TOKEN_BUDGET names a number.
const namePrefix = String.raw`(?:[A-Za-z0-9]*[_.-])*`
const prefixedName = String.raw`(?<![A-Za-z0-9_.-])${namePrefix}${sensitiveName}\b`
const assignment: ValuePattern = {
  start: new RegExp(String.raw`(?:\$env:|\bset\s+)?["']?${prefixedName}["']?\s*=\s*${valueStart}`, "giu"),
  delimiter: valueDelimiter,
}
const structuredAssignment: ValuePattern = {
  start: new RegExp(String.raw`["']?${prefixedName}["']?\s*:\s*${structuredValueStart}`, "giu"),
  delimiter: closedValueDelimiter,
}
// A prefixed flag starts where a name cannot continue, so a run of dashes
// starts one prefix walk rather than one at every position. A bare -- or /
// followed directly by the sensitive name matches anywhere, as before
// prefixes were added; it walks nothing, so it stays linear. A negated flag
// takes no value: when any segment of the whole flag name is no, skip or
// without (--no-password, --no-auth-token, --db-skip-client-secret), the
// prefixed branch does not match. The check walks the name once, from the
// one start the lookbehind allows. One dash starts a flag as two do (-token,
// -db-password), as Go and Java tools write them. Its value is read as an
// assignment's is, so an escaped quote does not end it.
const secretFlag: ValuePattern = {
  start: new RegExp(
    String.raw`(?:(?<![A-Za-z0-9_.-])--?(?!(?:[A-Za-z0-9]*[_.-])*?(?:no|skip|without)[_.-])${namePrefix}|--|/)${sensitiveName}(?:\s*=\s*|\s+|:)${valueStart}`,
    "giu",
  ),
  delimiter: valueDelimiter,
}
// Ruled 2026-09-24: after a prefixed sensitive name, the value shows only
// when the word right before the name counts or switches and the value is a
// plain number or true/false, as in total_token=5 or has_secret=false. Every
// other value stays hidden: DB_PASSWORD=123456 and limit_token=5 among them.
const countingWords = ["total", "has", "max", "min", "count", "is", "enable"] as const
const countingName = new RegExp(String.raw`(?:^|[_.-])(?:${countingWords.join("|")})[_.-]${sensitiveName}$`, "iu")
const plainValue = /^(?:\d+(?:\.\d+)?|true|false)$/iu

// The name is the last identifier run in the matched prefix, without the
// dashes of a flag or the -D of a Java property. A -D property can also be
// matched as a plain assignment, so -D is dropped whichever pattern found it.
function nameOf(prefix: string): { name: string, run: string, runStart: number } {
  const run = prefix.match(/[A-Za-z0-9_.-]+/gu)?.at(-1) ?? ""
  const name = run.startsWith("-D") ? run.slice(2) : run.replace(/^-+/u, "")
  return { name, run, runStart: prefix.lastIndexOf(run) }
}

// A quote opened right before the name that does not close before the
// separator, as in set "NAME=5", is still open: it closes after the value.
// When the name starts the match, the quote is the character before it.
function openNameQuote(prefix: string, before = ""): string | undefined {
  const { run, runStart } = nameOf(prefix)
  const preceding = runStart > 0 ? prefix[runStart - 1] : before
  const nameQuote = preceding === '"' || preceding === "'" ? preceding : undefined
  return nameQuote !== undefined && !prefix.slice(runStart + run.length).includes(nameQuote) ? nameQuote : undefined
}

function showsPlainValue(prefix: string, secret: string, before = ""): boolean {
  const { name } = nameOf(prefix)
  // A quoted value must be closed by the same quote. A quote opened before the
  // name, as in set "NAME=5", must close right after the value. Otherwise the
  // value holds no quote at all.
  const openQuote = openNameQuote(prefix, before)
  const quote = secret[0] === '"' || secret[0] === "'" ? secret[0] : undefined
  let value = secret
  if (quote !== undefined) {
    if (openQuote !== undefined || secret.length < 2 || !secret.endsWith(quote)) return false
    value = secret.slice(1, -1)
  } else if (openQuote !== undefined) {
    if (!secret.endsWith(openQuote)) return false
    value = secret.slice(0, -1)
  }
  return countingName.test(name) && plainValue.test(value)
}

const lostContextAssignment: ValuePattern = {
  start: new RegExp(String.raw`${sensitiveName}["']?\s*[:=]\s*${valueStart}`, "giu"),
  delimiter: valueDelimiter,
}
// cmd's set "NAME=value": where the name starts. The quote before the name
// encloses the value, which readValue reads as it reads any value inside
// that quote: with the table's escapes for it (so set "NAME=a\"b" does not
// end at \"), across line breaks, and on past the closer to its delimiter.
// When the quote never closes, the value runs to the end. As with the other
// patterns, a name with nothing after it yet has no value to read.
const quotedCmdAssignment = new RegExp(
  String.raw`(\bset\s+)(["'])(${namePrefix}${sensitiveName}\s*=)(?=[\s\S])`,
  "giu",
)

// A set "NAME=value" found in text. set, quote, name: what comes before the
// value, the name with its =; secret: the value as written, the closer included; closed: its quote
// closed; open: where the reading stood when the text ended inside the value.
type CmdMatch = { index: number, set: string, quote: string, name: string, secret: string, closed: boolean, open: ValueState | undefined }

function cmdMatches(text: string): CmdMatch[] {
  const matches: CmdMatch[] = []
  const start = quotedCmdAssignment
  start.lastIndex = 0
  for (let match = start.exec(text); match !== null; match = start.exec(text)) {
    const quote = match[2] ?? "\""
    const valueAt = match.index + match[0].length
    const read = readValue(text, valueAt, quotedValueState(quoteNamed(quote)))
    const end = read.end < 0 ? text.length : read.end
    matches.push({
      index: match.index, set: match[1] ?? "", quote, name: match[3] ?? "", secret: text.slice(valueAt, end),
      closed: read.state.stack.length === 0, open: read.end < 0 ? read.state : undefined,
    })
    start.lastIndex = Math.max(end, valueAt + 1)
  }
  return matches
}
// Spaces may follow the =, as they may an assignment's: java -DPassword= value
// is hidden as main hid it once a read left -D behind.
const javaSystemProperty: ValuePattern = {
  start: new RegExp(String.raw`(?:(?<![A-Za-z0-9_.-])-D${namePrefix}|-D)${sensitiveName}\s*=\s*${valueStart}`, "giu"),
  delimiter: valueDelimiter,
}

// A value found by a pattern. prefix: the name and its syntax; secret: the
// value; open: where the reading stood when the text ended inside the value,
// undefined when the value ended within the text. enclosing: a quote opened
// right before the name and still open at the value, as in set "NAME=value"
// or echo "NAME=a b": the value is read inside it and ends at its closer.
// delimiter: what ends the value. inner: names inside the value, each with a
// separator, whose own values run on past the value before them, in order;
// end: where the last of them ends, or the value's own end; open is then where
// the last one's reading stood. ties: other patterns' reads of a name found
// at the same place, as -max.secret_key :False is a flag and a name: at once.
type ValueMatch = {
  index: number, prefix: string, secret: string, open: ValueState | undefined, enclosing: GroupingName | undefined,
  delimiter: RegExp, inner: readonly ValueMatch[], end: number, ties: readonly ValueMatch[],
}

function valueStartState(delimiter: RegExp, enclosing: GroupingName | undefined): ValueState {
  return enclosing === undefined ? startValue(delimiter) : quotedValueState(enclosing, delimiter)
}

// The patterns whose names are looked for inside a value, each with its own
// copy of the pattern, so a search inside a value leaves the outer search's
// place alone.
const valuePatterns: readonly ValuePattern[] = [assignment, structuredAssignment, secretFlag, javaSystemProperty]
const innerStarts = valuePatterns.map((pattern) => ({ pattern, start: new RegExp(pattern.start.source, pattern.start.flags) }))

// One pattern's match, read to the end of its value.
function readMatch(pattern: ValuePattern, text: string, match: RegExpExecArray): ValueMatch {
  const valueAt = match.index + match[0].length
  // The whole name, from its first character: a pattern that starts at the
  // sensitive word, as where what came before is out of view, may begin in
  // the middle of it.
  let nameStart = match.index
  while (nameStart > 0 && match.index - nameStart < 1_024 && isNameCharacter(text.charCodeAt(nameStart - 1), false)) nameStart -= 1
  const quote = openNameQuote(`${text.slice(nameStart, match.index)}${match[0]}`, text[nameStart - 1])
  const enclosing = quote === undefined ? undefined : quoteNamed(quote)
  const read = readValue(text, valueAt, valueStartState(pattern.delimiter, enclosing))
  const end = read.end < 0 ? text.length : read.end
  return {
    index: match.index, prefix: match[0], secret: text.slice(valueAt, end), open: read.end < 0 ? read.state : undefined, enclosing,
    delimiter: pattern.delimiter, inner: [], end, ties: [],
  }
}

// Where each inner pattern next matches at or after a point, remembered for
// one search over a text: the points only move forward, so each pattern scans
// the text once.
type InnerSearch = Map<RegExp, { from: number, match: RegExpExecArray | null }>

function nextInner(search: InnerSearch, start: RegExp, text: string, from: number): RegExpExecArray | null {
  const known = search.get(start)
  if (known !== undefined && known.from <= from && (known.match === null || known.match.index >= from)) return known.match
  start.lastIndex = from
  const match = start.exec(text)
  search.set(start, { from, match })
  return match
}

// A name and separator inside a value whose own value runs on past the value,
// as in -DGITHUB_TOKEN ==Password: value, where the value is =Password: and
// Password's value comes after it (found by the differential fuzz of #598).
// Each such name extends what is hidden to its own value's end, and names
// inside that value are looked for in turn. Only a name outside every quote
// and construct of the value counts: one inside a quoted value, as in
// API_KEY="a token=b", is part of that quoted value and ends with it.
// Every inner name holds a sensitive word inside the value it sits in, so a
// value without one is not searched: most values are not, and the search
// would cost each of them a scan per pattern.
const sensitiveWord = new RegExp(sensitiveName, "iu")

function withInnerValues(outer: ValueMatch, text: string, search: InnerSearch): ValueMatch {
  if (outer.open !== undefined) return outer
  const inner: ValueMatch[] = []
  let region = outer
  let from = outer.index + outer.prefix.length
  let end = outer.end
  for (;;) {
    if (!sensitiveWord.test(text.slice(from, end))) break
    const names: Array<{ pattern: ValuePattern, match: RegExpExecArray }> = []
    for (const { pattern, start } of innerStarts) {
      for (let match = nextInner(search, start, text, from); match !== null && match.index < end; match = nextInner(search, start, text, match.index + 1)) {
        names.push({ pattern, match })
      }
    }
    names.sort((left, right) => left.match.index - right.match.index)
    // The value the names sit in is read up to each name, in order, to see
    // whether the name is outside its quotes and constructs.
    const valueAt = region.index + region.prefix.length
    const reading = valueStartState(region.delimiter, region.enclosing)
    let readTo = valueAt
    let furthest: ValueMatch | undefined
    for (const { pattern, match } of names) {
      if (match.index < valueAt) continue
      if (readValue(text, readTo, reading, match.index).end >= 0) break
      readTo = match.index
      if (reading.stack.length > 0 || reading.escaped) continue
      const read = readMatch(pattern, text, match)
      if (read.end > end && (furthest === undefined || read.end > furthest.end)) furthest = read
    }
    if (furthest === undefined) break
    inner.push(furthest)
    region = furthest
    from = end
    end = furthest.end
    if (furthest.open !== undefined) break
  }
  if (inner.length === 0) return outer
  return { ...outer, inner, end, open: inner.at(-1)!.open }
}

// Every value the value patterns find, read left to right as one scan: the
// match that starts first is taken, and a name inside a value already taken
// is part of that value, not a name of its own, whichever pattern finds it
// (a name in a -D property's quoted value, java -Dpassword="a API_KEY=b", is
// found by the assignment pattern). Only names withInnerValues takes let a
// value run on past it.
const scanStarts = valuePatterns.map((pattern) => ({ pattern, start: new RegExp(pattern.start.source, pattern.start.flags) }))

function scanValues(text: string): ValueMatch[] {
  const matches: ValueMatch[] = []
  const search: InnerSearch = new Map()
  const inner: InnerSearch = new Map()
  let from = 0
  for (;;) {
    const found = scanStarts
      .map(({ pattern, start }) => ({ pattern, match: nextInner(search, start, text, from) }))
      .filter((candidate): candidate is { pattern: ValuePattern, match: RegExpExecArray } => candidate.match !== null)
    if (found.length === 0) return matches
    const index = Math.min(...found.map(({ match }) => match.index))
    // Each pattern that finds a name here reads it; the read that runs
    // furthest stands for them all, and the others are kept as ties.
    const reads = found.filter(({ match }) => match.index === index)
      .map(({ pattern, match }) => withInnerValues(readMatch(pattern, text, match), text, inner))
    const read = reads.reduce((furthest, next) => next.end > furthest.end ? next : furthest)
    matches.push({ ...read, ties: reads.filter((other) => other !== read) })
    from = Math.max(read.end, index + 1)
  }
}

function valueMatches(pattern: ValuePattern, text: string): ValueMatch[] {
  const matches: ValueMatch[] = []
  const search: InnerSearch = new Map()
  const start = pattern.start
  start.lastIndex = 0
  for (let match = start.exec(text); match !== null; match = start.exec(text)) {
    const read = withInnerValues(readMatch(pattern, text, match), text, search)
    matches.push(read)
    start.lastIndex = read.end
  }
  return matches
}

// A hidden value keeps its quotes, and a value inside a quote opened before
// its name keeps that quote's closer. A value still open when the text ended
// ran to the end of the text, so the line break it ended on is kept.
function hiddenValue(prefix: string, secret: string, enclosing: GroupingName | undefined): string {
  const read = readValue(secret, 0, valueStartState(valueDelimiter, enclosing))
  const open = read.end < 0 && read.state.stack.length > 0
  const lineEnd = open ? /(?:\r\n|\r|\n)$/u.exec(secret)?.[0] ?? "" : ""
  if (enclosing !== undefined) return `${prefix}${replacement}${open ? "" : groupingConstructs[enclosing].closer}${lineEnd}`
  const quote = quoteAt(secret)
  if (!read.state.word && quote !== undefined) return `${prefix}${quote.opener}${replacement}${quote.closer}${lineEnd}`
  return `${prefix}${replacement}${lineEnd}`
}

// A match hidden whole: its value, then for each inner name whose value runs on
// past it, what lies between them (the inner name's separator and spaces,
// never value text) and the inner value hidden in turn. Where an inner value
// starts inside the value before it, the rest of it becomes one replacement.
function hiddenMatch(match: ValueMatch, text: string): string {
  let hidden = hiddenValue(match.prefix, match.secret, match.enclosing)
  let shownTo = match.index + match.prefix.length + match.secret.length
  for (const inner of match.inner) {
    const valueAt = inner.index + inner.prefix.length
    hidden += valueAt >= shownTo
      ? `${text.slice(shownTo, valueAt)}${hiddenValue("", inner.secret, inner.enclosing)}`
      : replacement
    shownTo = inner.end
  }
  return hidden
}

// A value these patterns hide that is still open at the end of the text: a
// quote or substitution that has not closed, or, with words, a word holding a
// substitution that no delimiter has ended yet. start: where its match
// starts; valueStart: where the value starts; shown: what stands for the
// value; state: where its reading stands.
type OpenValue = { start: number, valueStart: number, shown: string, state: ValueState }


// words: also count a word holding a substitution as open, as the terminal
// does, since the rest of that word may still arrive.
function openValue(text: string, words: boolean): OpenValue | undefined {
  if (!anyValueOpener.test(text)) return undefined
  let found: OpenValue | undefined
  // Only the last value can still be open: the scan takes no name inside it.
  const match = scanValues(text).at(-1)
  const state = match?.open
  if (match !== undefined && state !== undefined && (state.stack.length > 0 || (words && state.nested))) {
    // The value still open is the last inner one's, when a name inside the
    // value took its value on past it.
    const last = match.inner.at(-1) ?? match
    const quote = state.word ? undefined : quoteAt(last.secret)
    const shown = last.enclosing !== undefined
      ? `${replacement}${groupingConstructs[last.enclosing].closer}`
      : quote === undefined ? replacement : `${quote.opener}${replacement}${quote.closer}`
    found = { start: match.index, valueStart: text.length - last.secret.length, shown, state }
  }
  const cmd = cmdMatches(text).at(-1)
  const cmdState = cmd?.open
  if (cmd !== undefined && cmdState !== undefined && (cmdState.stack.length > 0 || words) && (found === undefined || cmd.index < found.start)) {
    const valueStart = cmd.index + cmd.set.length + cmd.quote.length + cmd.name.length
    found = { start: cmd.index, valueStart, shown: `${replacement}${cmd.quote}`, state: cmdState }
  }
  return found
}

export function redactDurableText(value: unknown): RedactedText {
  return redact(value, maximumDurableTextLength)
}

export function redactDurableCommand(value: unknown): RedactedText {
  return redact(value, maximumDurableCommandLength)
}

// A terminal read is shown, not stored, so it is redacted without the length
// bound the durable records carry: truncating what a terminal printed would
// lose output rather than protect anything.
// A read the terminal redactor emits before the rest arrives is incomplete: a
// value at its end may still be growing, so it is not taken as complete.
// exemptFrom: where the text's context is known again. Before it, a counting
// value is not shown, since what came before its name is not in view.
// following: the character that comes after the text, when the rest is held
// back; it decides whether a value at the very end is complete.
export function redactStreamText(value: string, complete = true, exemptFrom = 0, following?: string): string {
  return redact(value, Number.MAX_SAFE_INTEGER, complete, exemptFrom, following).value
}

export function redactDurableOutput(value: unknown): RedactedText {
  return redact(value, maximumDurableOutputLength)
}

export function appendDurableOutput(current: string | undefined, addition: string): string {
  const combined = `${current ?? ""}${addition}`
  if (combined.length <= maximumDurableOutputLength) return combined
  return `…${combined.slice(-(maximumDurableOutputLength - 1))}`
}

const longRecordOmitted = "[Long command output line omitted]\n"

// Whether a record ends with a name and its separator, its value still to
// come on a later line, as in X_TOKEN:\n or {"x-token":\n. The patterns read
// whitespace, line breaks included, between a separator and its value, so the
// durable redactors hide that value when they see the records together.
const awaitingValue = valuePatterns.map((pattern) => new RegExp(pattern.start.source, pattern.start.flags))

function awaitsValue(record: string): boolean {
  const last = record.trimEnd().at(-1)
  if (last === undefined || !/[=:A-Za-z0-9_.-]/u.test(last)) return false
  // A value would start where the record ends.
  const probe = `${record}x`
  return awaitingValue.some((start) => {
    start.lastIndex = 0
    for (let match = start.exec(probe); match !== null; match = start.exec(probe)) {
      if (match.index + match[0].length === record.length) return true
    }
    return false
  })
}

// A quoted value or substitution that is still open when its record ends goes
// on into the next record: that record is dropped up to where the value ends,
// its closing quote, or for a word, the delimiter after its substitutions
// close. The replacement has already been written for it.
export class DurableOutputRedactor {
  #pending = ""
  #droppingLongRecord = false
  #open: ValueState | undefined
  // The end of an omitted record's text, so a name split across reads of it
  // is still seen with its quoted value.
  #omittedTail = ""

  push(chunk: string): string {
    let input = chunk
    let emitted = ""
    while (input !== "") {
      if (this.#droppingLongRecord) {
        const newline = input.indexOf("\n")
        const end = newline < 0 ? input.length : newline + 1
        this.#omit(input.slice(0, end))
        if (newline < 0) return emitted
        this.#droppingLongRecord = false
        this.#omittedTail = ""
        input = input.slice(end)
        continue
      }
      if (this.#open) {
        const read = readValue(input, 0, this.#open)
        if (read.end < 0) {
          this.#open = read.state
          return emitted
        }
        this.#open = undefined
        input = input.slice(read.end)
        continue
      }

      let combined = `${this.#pending}${input}`
      this.#pending = ""
      input = ""
      let newline = combined.indexOf("\n")
      while (newline >= 0) {
        const record = combined.slice(0, newline + 1)
        // A record whose name awaits its value on a later line waits for the
        // records after it, and is redacted with them.
        if (record.length <= maximumStreamingOutputBufferLength && awaitsValue(record)) {
          newline = combined.indexOf("\n", newline + 1)
          continue
        }
        combined = combined.slice(newline + 1)
        if (record.length > maximumStreamingOutputBufferLength) {
          emitted = appendDurableOutput(emitted, longRecordOmitted)
          this.#omit(record)
          this.#omittedTail = ""
        } else {
          emitted = appendDurableOutput(emitted, redactDurableOutput(record).value)
          this.#open = openValue(record, false)?.state
        }
        if (this.#open) {
          input = combined
          combined = ""
          break
        }
        newline = combined.indexOf("\n")
      }

      if (combined.length > maximumStreamingOutputBufferLength) {
        emitted = appendDurableOutput(emitted, longRecordOmitted)
        this.#droppingLongRecord = true
        this.#omittedTail = ""
        this.#omit(combined)
      } else {
        this.#pending = combined
      }
    }
    return emitted
  }

  // Follows quoted values and substitutions through text that is omitted
  // rather than shown, so a value still open at the end of an omitted record
  // is dropped from the next record as well.
  #omit(text: string): void {
    let rest = text
    while (rest !== "") {
      if (this.#open) {
        const read = readValue(rest, 0, this.#open)
        if (read.end < 0) {
          this.#open = read.state
          return
        }
        this.#open = undefined
        this.#omittedTail = ""
        rest = rest.slice(read.end)
        continue
      }
      const view = `${this.#omittedTail}${rest}`
      const open = openValue(view, false)
      if (open) {
        this.#open = open.state
        this.#omittedTail = ""
      } else {
        this.#omittedTail = view.slice(-maximumStreamingOutputBufferLength)
      }
      return
    }
  }

  // The pending record has no newline yet, so its last value may still grow.
  peek(): string {
    return this.#droppingLongRecord ? "" : redact(this.#pending, maximumDurableOutputLength, false).value
  }

  flush(): string {
    const output = this.#droppingLongRecord ? "" : redactDurableOutput(this.#pending).value
    this.#droppingLongRecord = false
    this.#pending = ""
    this.#open = undefined
    this.#omittedTail = ""
    return output
  }
}

function redact(value: unknown, maximumLength: number, complete = true, exemptFrom = 0, following?: string): RedactedText {
  const bounded = boundedText(value, maximumLength)
  // The end of the text ends a value only when nothing more can follow it, or
  // when what follows is known and is a delimiter.
  const delimiter = /[\s;&|,}\r\n]/u
  const endIsDelimiter = !bounded.truncated && (following === undefined ? complete : delimiter.test(following))
  const delimitedAt = (whole: string, index: number) => index >= whole.length
    ? endIsDelimiter
    : delimiter.test(whole[index]!)
  let changed = false
  const replace = (input: string, pattern: RegExp, replacer: string | ((...args: string[]) => string)) =>
    input.replace(pattern, (...args: string[]) => {
      const matched = args[0]!
      const next = typeof replacer === "string"
        ? matched.replace(pattern, replacer)
        : replacer(...args)
      if (next !== matched || matched.includes(replacement)) changed = true
      return next
    })

  let output = bounded.value
  output = replace(
    output,
    /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/giu,
    `$1${replacement}@`,
  )
  output = replace(
    output,
    /(\b(?:proxy-)?authorization\b["']?\s*[:=]\s*["']?)(?:bearer|basic)\s+[^\s"',;\r\n]+/giu,
    `$1${replacement}`,
  )
  output = replace(
    output,
    /(\b(?:proxy-)?authorization\b["']?\s*[:=]\s*["']?)[^\s"',;\r\n]+/giu,
    `$1${replacement}`,
  )
  // Each value a pattern finds is replaced as a whole, read to its end by
  // readValue rather than by the pattern.
  const replaceValues = (input: string, matches: readonly ValueMatch[], replacer: (match: ValueMatch, whole: string) => string) => {
    if (matches.length === 0) return input
    let result = ""
    let from = 0
    for (const match of matches) {
      const matched = input.slice(match.index, match.end)
      const next = replacer(match, input)
      if (next !== matched || matched.includes(replacement)) changed = true
      result += `${input.slice(from, match.index)}${next}`
      from = match.index + matched.length
    }
    return `${result}${input.slice(from)}`
  }
  // The exemption applies only to a value that is complete: balanced quotes and
  // a delimiter, or the true end of the text, right after it.
  // A counting value shows only when every pattern that found its name reads
  // it as one.
  const showsValue = (match: ValueMatch, whole: string) => match.inner.length === 0 && match.index >= exemptFrom
    && showsPlainValue(match.prefix, match.secret, whole[match.index - 1])
    && delimitedAt(whole, match.index + match.prefix.length + match.secret.length)
  const valueReplacer = (match: ValueMatch, whole: string) => {
    if (showsValue(match, whole) && match.ties.every((tie) => showsValue(tie, whole))) return whole.slice(match.index, match.end)
    return hiddenMatch(match, whole)
  }
  // cmd's set "NAME=value" is read first, while its closing quote is still in
  // place: an assignment read first would take that quote as part of the
  // value.
  {
    const matches = cmdMatches(output)
    if (matches.length > 0) {
      let result = ""
      let from = 0
      for (const cmd of matches) {
        const matched = `${cmd.set}${cmd.quote}${cmd.name}${cmd.secret}`
        // A counting value shows only as set "NAME=5": its quote closed right
        // after it.
        const plain = cmd.closed && cmd.secret.endsWith(cmd.quote) && cmd.secret.indexOf(cmd.quote) === cmd.secret.length - 1
        const next = plain && cmd.index >= exemptFrom && showsPlainValue(cmd.name.replace(/\s*=$/u, ""), cmd.secret.slice(0, -1)) && delimitedAt(output, cmd.index + matched.length)
          ? matched
          // A quote that never closed ran to the end of the text; the line
          // break it ended on is kept.
          : `${cmd.set}${cmd.quote}${cmd.name}${replacement}${cmd.quote}${cmd.closed ? "" : /(?:\r\n|\r|\n)$/u.exec(cmd.secret)?.[0] ?? ""}`
        if (next !== matched || matched.includes(replacement)) changed = true
        result += `${output.slice(from, cmd.index)}${next}`
        from = cmd.index + matched.length
      }
      output = `${result}${output.slice(from)}`
    }
  }
  // Where what came before a name is out of view, a sensitive word counts as
  // a name wherever it starts, as it did before prefixes were read: main's
  // terminal redactor, holding only from the sensitive word, redacted
  // Dpassword=... after a flush left -D behind.
  if (exemptFrom > 0) {
    output = replaceValues(output, valueMatches(lostContextAssignment, output), (match, whole) => {
      if (match.index >= exemptFrom) return whole.slice(match.index, match.end)
      return hiddenMatch(match, whole)
    })
  }
  output = replaceValues(output, scanValues(output), valueReplacer)
  output = replace(
    output,
    /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/gu,
    replacement,
  )
  output = replace(
    output,
    /\b(?:sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gu,
    replacement,
  )
  if (bounded.truncated) {
    output = replace(
      output,
      /(https?:\/\/)[^\s/:@]+:[^\s/@]*$/gu,
      `$1${replacement}`,
    )
    output = replace(
      output,
      /(eyJ[A-Za-z0-9_-]{1,}(?:\.[A-Za-z0-9_-]*){0,2})$/gu,
      replacement,
    )
    output = replace(
      output,
      /((?:sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{1,})$/gu,
      replacement,
    )
  }

  if (bounded.truncated && !output.endsWith("…")) {
    output = `${output.slice(0, maximumLength - 1)}…`
  }
  return { value: output.slice(0, maximumLength), redacted: changed, truncated: bounded.truncated }
}

function boundedText(value: unknown, maximumLength: number): { value: string; truncated: boolean } {
  if (typeof value === "string") {
    return { value: value.slice(0, maximumLength), truncated: value.length > maximumLength }
  }
  try {
    const text = String(value)
    return { value: text.slice(0, maximumLength), truncated: text.length > maximumLength }
  } catch {
    return { value: "[Unprintable text]", truncated: false }
  }
}

// A terminal is not command output: it has no reliable newlines, its lines can
// be enormous, and what it shows has to keep up with typing. Redaction still
// has to see across reads, so the whole of what has been carried plus the new
// read is redacted together, and a tail is held back only while it could still
// be the beginning of a secret. Ordinary output is never delayed, and nothing
// is ever replaced wholesale.
export const terminalRedactionCarryCharacters = 256

// The start of an assignment this redactor would act on, left dangling at the
// end of a read: a sensitive name, or one followed by its separator and a value
// that may still be growing. The name's prefix, its flag dashes and the
// context before it are found by walking back from the sensitive word.
const danglingSecret = new RegExp(
  String.raw`${sensitiveName}\b(["']?\s*[:=]?\s*)([^\s;&|\r\n]*)$`,
  "iu",
)

// A name can itself be split, so a run of name characters still being typed at
// the end of a read, with any flag dashes, slash or dot in it, is held until
// the next read resolves it.
// Where the run of name characters at the end of a window starts, from its
// first character that is not a digit, as /[A-Za-z_./-][A-Za-z0-9_./-]*$/
// finds it; -1 when there is none. Walked back from the end rather than
// matched, which tries every start in a run of letters to its end.
function danglingNameStart(window: string): number {
  let start = window.length
  while (start > 0 && isNameCharacter(window.charCodeAt(start - 1), true)) start -= 1
  while (start < window.length && isDigit(window.charCodeAt(start))) start += 1
  return start < window.length ? start : -1
}
const nameCharacter = /[A-Za-z0-9_./-]/u
// What a pattern reads before a name: set, $env: and an opening quote.
const nameContext = /(?:\$env:|\bset\s+)?["']?$/iu
// That context alone at the end of a read, before any name has arrived. A
// quote counts only where it can open a name, not where it closes a value.
const danglingContext = /(?:\$env:|\bset\s+)["']?$|(?:^|[\s{,(])["']$/iu
const lineBreak = /[\r\n]/u

// Where a value ends after a name and its syntax: a name: or JSON value also
// ends at a comma or brace, unless the name is a flag. A colon after a quoted
// name is JSON even when the name starts with a dash, as in {"-db.secret":…}.
function valueDelimiterAfter(syntax: string, flag: boolean): RegExp {
  return syntax.includes(":") && (!flag || /["']/u.test(syntax)) ? closedValueDelimiter : valueDelimiter
}

// A quoted value that has ended, with something after it, is no longer
// growing. A closing quote at the very end may still be followed by more of
// the same shell word.
function closedQuote(value: string, delimiter: RegExp, enclosing: GroupingName | undefined): boolean {
  const read = readValue(value, 0, valueStartState(delimiter, enclosing))
  return !read.state.word && read.end >= 0 && read.end < value.length
}

// Text that ends inside an open value: what comes before the value is
// redacted as usual, and the value becomes the replacement, in its quotes
// when it is quoted.
function hideOpenValue(text: string, open: OpenValue, complete: boolean, exemptFrom: number): string {
  const before = redactStreamText(text.slice(0, open.valueStart), complete, exemptFrom, text[open.valueStart])
  return `${before}${open.shown}`
}

// What the terminal redactor is dropping once a value has outgrown the carry.
// value: a value being read to its end by readValue: a quoted value to its
// first unescaped closing quote, a word to its delimiter once any
// substitution in it has closed. A quote or substitution still open ends only
// where it closes, across spaces, line breaks and idle flushes.
// pending: the name alone outgrew the carry, so the value has not started.
// What still belongs to the name (its closing quote, the separator, spaces)
// is shown, and the first character of the value decides how it is dropped.
// A name written as a flag may take its value after spaces alone; any other
// name needs its separator first. word: the end of the name so far, since it
// may still grow (CREDENTIAL into CREDENTIALS, SECRET into SECRET_KEY); the
// drop goes on only while the name still ends in a sensitive name.
// enclosing: a quote opened right before the name, which the value is read
// inside.
type Dropping =
  | { kind: "value", state: ValueState }
  | {
    kind: "pending", separator: string | undefined, quoted: boolean, spaced: boolean, flag: boolean, word: string, grown: boolean,
    enclosing: GroupingName | undefined,
  }

const nameWordLength = 64
const endsInSensitiveName = new RegExp(String.raw`(?:^|[_.-])${sensitiveName}$`, "iu")

// The inner terminal redactor: this branch's rewrite of main's, plus the
// dropping getter the wrapper below reads. The exported redactor wraps it.
class HeldTailRedactor {
  #carry = ""
  // Set once an assignment has outgrown what can be carried. From then on the
  // value's bytes are dropped rather than held, until it ends, so a token of
  // any length is redacted without anything being buffered for it. A quoted
  // value's closing quote is dropped too, since the replacement's own closing
  // quote has already taken its place, and so is the rest of a substitution.
  #dropping: Dropping | undefined
  // The end of the value being dropped, as far as the carry reaches, so a
  // name and separator at its end (TOKEN=…Password: value) still hide the
  // value that follows it.
  #dropped = ""
  // Set when text before a name was emitted without the name. After a flush
  // in the middle of a line, a counting value is not shown until the next line
  // break; after a name that outgrew the carry, not within the rest of that
  // name. Whether such a value is complete depends on what is no longer in
  // view.
  #contextLost: "line" | "name" | undefined

  // Whether the rest of a value is being dropped rather than shown. A pending
  // name is not: its characters are still shown until its value starts, and
  // the wrapper keeps reading the line meanwhile, so it can only hide more.
  get dropping(): boolean {
    return this.#dropping?.kind === "value"
  }

  // Everything held back plus the new read is redacted as one string, so an
  // assignment split across two reads is seen whole.
  push(chunk: string): string {
    let input = chunk
    let lead = ""
    while (this.#dropping && input !== "") {
      const step = this.#drop(this.#dropping, input)
      lead += step.shown
      input = step.rest
    }
    if (this.#dropping) return lead

    const combined = `${this.#carry}${input}`
    const exemptFrom = this.#exemptFrom(combined)

    // A quoted value whose closing quote has not arrived, or a word holding a
    // substitution that has not ended, is held whole from its name, whatever
    // it holds so far: spaces and line breaks do not end it. Once it outgrows
    // the carry, the replacement stands for it and the rest is dropped up to
    // its end.
    const open = openValue(combined, true)
    if (open) {
      const start = Math.min(open.start, this.#contextStart(combined, this.#nameStart(combined, open.start, 0)))
      if (combined.length - start > terminalRedactionCarryCharacters) {
        this.#carry = ""
        this.#dropping = { kind: "value", state: open.state }
        this.#dropped = combined.slice(open.valueStart).slice(-terminalRedactionCarryCharacters)
        this.#settle(combined)
        return `${lead}${hideOpenValue(combined, open, false, exemptFrom)}`
      }
      const emitted = combined.slice(0, start)
      this.#carry = combined.slice(start)
      this.#settle(emitted)
      return `${lead}${redactStreamText(emitted, false, exemptFrom, this.#carry[0])}`
    }

    const hold = this.#holdFrom(combined)
    const held = combined.length - hold.start
    if (held > terminalRedactionCarryCharacters && hold.value !== undefined) {
      // The held text is an assignment whose value has already run past the
      // carry. Redact what there is, which turns the value seen so far into
      // the replacement, and drop the rest of it as it arrives.
      this.#carry = ""
      this.#dropping = this.#startDropping(hold.value, hold.syntax ?? "", hold.flag ?? false, hold.word ?? "", hold.enclosing)
      this.#dropped = hold.value.slice(-terminalRedactionCarryCharacters)
      this.#settle(combined)
      return `${lead}${redactStreamText(combined, false, exemptFrom)}`
    }

    const emitted = combined.slice(0, hold.start)
    this.#carry = combined.slice(hold.start)
    this.#settle(emitted)
    if (hold.cut && this.#contextLost === undefined) this.#contextLost = "name"
    return `${lead}${redactStreamText(emitted, false, exemptFrom, this.#carry[0])}`
  }

  #startDropping(value: string, syntax: string, flag: boolean, word: string, enclosing: GroupingName | undefined): Dropping {
    if (value === "") {
      return { kind: "pending", separator: /[:=]/u.exec(syntax)?.[0], quoted: /["']/u.test(syntax), spaced: /\s/u.test(syntax), flag, word, grown: false, enclosing }
    }
    const read = readValue(value, 0, valueStartState(valueDelimiterAfter(syntax, flag), enclosing))
    if (read.end < 0) return { kind: "value", state: read.state }
    // A value whose quote has closed ends at a delimiter or at the comma or
    // brace that follows a JSON string.
    return { kind: "value", state: { ...startValue(closedValueDelimiter), fresh: false } }
  }

  // Drops what belongs to the value in one read. shown: what is emitted for
  // it; rest: what follows the value, once it has ended.
  #drop(dropping: Dropping, input: string): { shown: string, rest: string } {
    const end = (at: number, shown = "") => {
      this.#dropping = undefined
      return { shown, rest: input.slice(at) }
    }
    if (dropping.kind === "value") {
      // A value that so far is only $ is quoted when a quote comes next, and
      // a substitution when ( does.
      const read = readValue(input, 0, dropping.state)
      this.#dropped = `${this.#dropped}${input.slice(0, read.end < 0 ? input.length : read.end)}`.slice(-terminalRedactionCarryCharacters)
      if (read.end >= 0) {
        // A name and separator at the value's end: its own value comes next,
        // and is dropped as the rest of a name that outgrew the carry is.
        const inner = this.#holdFrom(this.#dropped)
        this.#dropped = ""
        // A quote or construct character in what follows the separator may
        // close one opened before the name, as in "a token=b": the name is
        // then inside the value, and its value ended with it. A quote before
        // the separator is the name's own, as in "x-token":.
        if (inner.value === undefined || /["'`$(){}<>\\]/u.test(inner.value)) return end(read.end)
        this.#dropping = this.#startDropping(inner.value, inner.syntax ?? "", inner.flag ?? false, inner.word ?? "", inner.enclosing)
        this.#dropped = inner.value
        return { shown: "", rest: input.slice(read.end) }
      }
      this.#dropping = { kind: "value", state: read.state }
      return { shown: "", rest: "" }
    }

    let { separator, quoted, spaced, word, grown, enclosing } = dropping
    for (let at = 0; at < input.length; at += 1) {
      const character = input[at]!
      // The name is still being written: it goes on only while it still ends
      // in a sensitive name, and it is shown.
      if (separator === undefined && !quoted && !spaced && nameCharacter.test(character)) {
        word = `${word}${character}`.slice(-nameWordLength)
        grown = true
        continue
      }
      if (grown && !endsInSensitiveName.test(word)) return end(at, input.slice(0, at))
      grown = false
      // A line break is whitespace here, as the patterns read it: a name's
      // value may start on the next line (found by the differential fuzz of
      // #598).
      if (character === " " || character === "\t" || character === "\r" || character === "\n") {
        spaced = true
        continue
      }
      const isQuote = character === '"' || character === "'"
      if (separator === undefined) {
        if (character === ":" || character === "=") {
          separator = character
          continue
        }
        if (isQuote && !quoted && !spaced) {
          quoted = true
          // The name's closing quote closes a quote opened before it.
          if (enclosing !== undefined && character === groupingConstructs[enclosing].closer) enclosing = undefined
          continue
        }
        if (!(dropping.flag && spaced)) return end(at, input.slice(0, at))
      }
      // A colon after a quoted name is JSON, even when the name starts with a
      // dash.
      const structured = separator === ":" && (!dropping.flag || quoted)
      if ((structured ? closedValueDelimiter : valueDelimiter).test(character)) return end(at, input.slice(0, at))
      const shown = input.slice(0, at)
      const delimiter = structured ? closedValueDelimiter : valueDelimiter
      // A value inside a quote opened before its name is dropped up to that
      // quote's closer, which the replacement's closer stands for.
      this.#dropped = ""
      if (enclosing !== undefined) {
        this.#dropping = { kind: "value", state: quotedValueState(enclosing, delimiter) }
        return { shown: `${shown}${replacement}${groupingConstructs[enclosing].closer}`, rest: input.slice(at) }
      }
      // A quoted value, one that opens with a quote ($'…' and $"…" among
      // them) or an array's (, is dropped up to its closer and, read as one
      // shell word, on to its delimiter.
      const quoteName = quoteNames.find((name) => input.startsWith(groupingConstructs[name].opener, at))
      if (quoteName !== undefined) {
        const { opener, closer } = groupingConstructs[quoteName]
        this.#dropping = { kind: "value", state: quotedValueState(quoteName, delimiter) }
        return { shown: `${shown}${opener}${replacement}${closer}`, rest: input.slice(at + opener.length) }
      }
      // Any other value is a word, read from its first character: a $ at the
      // end of the read may still open $'…' or $(…).
      this.#dropping = { kind: "value", state: startValue(delimiter) }
      return { shown: `${shown}${replacement}`, rest: input.slice(at) }
    }
    this.#dropping = { ...dropping, separator, quoted, spaced, word, grown, enclosing }
    return { shown: input, rest: "" }
  }

  // Context is known again once what was lost has ended in emitted text.
  #settle(emitted: string): void {
    if (this.#contextLost === "line" && lineBreak.test(emitted)) this.#contextLost = undefined
    if (this.#contextLost === "name" && /[^A-Za-z0-9_./-]/u.test(emitted)) this.#contextLost = undefined
  }

  // A flush emits what is held. A quote or substitution still open at that
  // point is replaced, and what arrives after the flush is dropped up to where
  // it closes, as it would be had the value outgrown the carry. An unquoted
  // word ends at the flush.
  flush(): string {
    if (this.#dropping?.kind !== "value" || this.#dropping.state.stack.length === 0) this.#dropping = undefined
    const remainder = this.#carry
    this.#carry = ""
    const exemptFrom = this.#exemptFrom(remainder)
    const open = remainder === "" ? undefined : openValue(remainder, false)
    if (open) {
      this.#dropping = { kind: "value", state: open.state }
      this.#dropped = remainder.slice(open.valueStart).slice(-terminalRedactionCarryCharacters)
    }
    const output = remainder === ""
      ? ""
      : open
        ? hideOpenValue(remainder, open, true, exemptFrom)
        : redactStreamText(remainder, true, exemptFrom)
    // A flush in the middle of a line leaves the rest of the line without
    // what came before it.
    this.#settle(remainder)
    if (output !== "" && !/[\r\n]$/u.test(remainder)) this.#contextLost = "line"
    return output
  }

  #exemptFrom(text: string): number {
    if (this.#contextLost === undefined) return 0
    const end = (this.#contextLost === "line" ? lineBreak : /[^A-Za-z0-9_./-]/u).exec(text)
    return end ? end.index + 1 : Number.MAX_SAFE_INTEGER
  }

  // Only an end of text that could still become a secret is worth withholding,
  // so a terminal that is simply busy is never held up. A dangling name is held
  // from the start of the whole name, with the context a pattern reads before
  // it; a dangling assignment in full, since the point is to notice one that
  // has outgrown the bound. A name still being typed is held within the bound.
  // cut: the held name reaches back past the bound, so what came before it
  // was emitted without it.
  // syntax: what follows the sensitive word before its value; flag: the name
  // starts with a dash or a slash; word: the end of the name; enclosing: a
  // quote opened right before the name and not closed in its syntax.
  #holdFrom(combined: string): {
    start: number, value?: string, syntax?: string, flag?: boolean, word?: string, cut?: boolean,
    enclosing?: GroupingName,
  } {
    const assignment = danglingSecret.exec(combined)
    if (assignment) {
      const nameStart = this.#nameStart(combined, assignment.index, 0)
      const value = assignment[2] ?? ""
      const syntax = assignment[1] ?? ""
      const flag = combined[nameStart] === "-" || combined[nameStart] === "/"
      const before = combined[nameStart - 1]
      const enclosing = (before === '"' || before === "'") && !syntax.includes(before) ? quoteNamed(before) : undefined
      if (!closedQuote(value, valueDelimiterAfter(syntax, flag), enclosing)) {
        const wordEnd = assignment.index + assignment[0].length - syntax.length - value.length
        const held = {
          start: this.#contextStart(combined, nameStart),
          value,
          syntax,
          flag,
          word: combined.slice(Math.max(nameStart, wordEnd - nameWordLength), wordEnd),
        }
        return enclosing === undefined ? held : { ...held, enclosing }
      }
    }
    const floor = Math.max(0, combined.length - terminalRedactionCarryCharacters)
    const window = combined.slice(floor)
    const nameAt = danglingNameStart(window)
    if (nameAt < 0) {
      const context = danglingContext.exec(window)
      return { start: context ? floor + context.index : combined.length }
    }
    const nameStart = this.#nameStart(combined, floor + nameAt, floor)
    const contextStart = this.#contextStart(combined, nameStart)
    const start = Math.max(floor, contextStart)
    // Cut when the name, or the set " or quote read before it, goes on past
    // the bound.
    return { start, cut: start === floor && floor > 0 && (nameCharacter.test(combined[floor - 1]!) || contextStart < floor) }
  }

  #nameStart(combined: string, start: number, floor: number): number {
    let at = start
    while (at > floor && nameCharacter.test(combined[at - 1]!)) at -= 1
    return at
  }

  #contextStart(combined: string, start: number): number {
    const context = nameContext.exec(combined.slice(Math.max(0, start - 16), start))
    return context ? start - context[0].length : start
  }
}

// A name and its separator at the end of a line's text, and any part of the
// value already there.
// A bare name starts at a word boundary, as main's own patterns read it:
// total_token or has_secret is an ordinary identifier, not a name.
const valueAtEnd = new RegExp(
  String.raw`(?:(?:--|/)${sensitiveName}(?:\s*=\s*|\s+|:)|-D${sensitiveName}\s*=\s*|\b${sensitiveName}\b["']?\s*[:=]\s*)([^\s;&|]*)$`,
  "iu",
)

// What ends a value this redactor hides on its own: whitespace, a shell
// operator, a JSON comma or brace, or a quote. It hides only what main shows,
// so it reads a value narrowly: an unquoted word, or a quote it saw open, up
// to its closing quote.
const valueEnd = /[\s;&|,}"']/u

type ValueRead = { started: boolean, marked: boolean, quote: string | undefined, escaped: boolean }

function valueEndingText(text: string): ValueRead | undefined {
  const value = valueAtEnd.exec(text)
  if (!value) return undefined
  const partial = value[1] ?? ""
  const read: ValueRead = { started: partial.length > 0, marked: partial.includes(replacement), quote: undefined, escaped: false }
  // Main's replacement for a quoted value: the value ended with it.
  if (partial === `"${replacement}"` || partial === `'${replacement}'`) return undefined
  for (let index = 0; index < partial.length; index += 1) {
    const character = partial[index]!
    if (read.quote !== undefined) {
      if (read.escaped) read.escaped = false
      else if (character === "\\" && read.quote === '"') read.escaped = true
      else if (character === read.quote) return undefined
    } else if (index === 0 && !read.marked && (character === '"' || character === "'")) {
      read.quote = character
    } else if (valueEnd.test(character)) {
      return undefined
    }
  }
  return read
}

// Where a value typed on this line stands at its end, if one is still open.
// Values are read left to right, each from its name to its end, so a name
// inside an earlier value never starts one of its own.
const namesAndSeparators = new RegExp(
  String.raw`(?:--|/)${sensitiveName}(?:\s*=\s*|\s+|:)|-D${sensitiveName}\s*=\s*|\b${sensitiveName}\b["']?\s*[:=]\s*`,
  "giu",
)

function valueOpenInTypedLine(line: string): (ValueRead & { from: number }) | undefined {
  const starts = new RegExp(namesAndSeparators.source, namesAndSeparators.flags)
  for (let start = starts.exec(line); start; start = starts.exec(line)) {
    const from = start.index + start[0].length
    const read = { started: false, marked: false, quote: undefined as string | undefined, escaped: false, from }
    let index = from
    for (; index < line.length; index += 1) {
      const character = line[index]!
      if (read.quote !== undefined) {
        if (read.escaped) read.escaped = false
        else if (character === "\\" && read.quote === '"') read.escaped = true
        else if (character === read.quote) break
        continue
      }
      if (!read.started && (character === '"' || character === "'")) {
        read.started = true
        read.quote = character
        continue
      }
      if (valueEnd.test(character)) break
      read.started = true
    }
    if (index >= line.length) return read
    starts.lastIndex = Math.max(index, from)
  }
  return undefined
}

// The end of a line with more text: from its last line boundary, runs of
// spaces kept as one, and no more than the carry bound.
function keptLineEnd(line: string, text: string): string {
  const joined = `${line}${text}`
  const start = Math.max(joined.lastIndexOf("\n"), joined.lastIndexOf("\r")) + 1
  return collapseSpaces(joined.slice(start)).slice(-terminalRedactionCarryCharacters)
}

function collapseSpaces(text: string): string {
  return text.replace(/[ \t]{2,}/gu, " ")
}

// The index in text at which its collapsed form reaches the given length.
function collapsedIndex(text: string, length: number): number {
  let collapsed = 0
  for (let index = 0; index < text.length; index += 1) {
    if (collapsed >= length) return index
    const space = text[index] === " " || text[index] === "\t"
    const previousSpace = index > 0 && (text[index - 1] === " " || text[index - 1] === "\t")
    if (!(space && previousSpace)) collapsed += 1
  }
  return text.length
}

// The terminal's redactor is main's, with one change. On an idle beat, what
// main held back is shown, so a prompt with no newline appears, as before.
// From then until the line ends, the line as shown is context: a name and
// separator in it, however the name was split around the beat, make what
// follows that name's value, and the value is shown as the replacement. It
// only ever hides text main would show, so nothing main hides is shown.
export class TerminalOutputRedactor {
  readonly #held = new HeldTailRedactor()
  // The end of the current line as shown, kept whether or not a beat has
  // released anything, so a name shown before the beat is still in view.
  #line = ""
  // Whether the line ends in a space or a tab.
  #blankEnd = false
  // The end of the current line as it was typed. On a beat main has shown all
  // of it, so it says exactly where a value released there stands, which what
  // main shows cannot: main writes `"[REDACTED]"` for a quote that is still
  // open as well as for one that closed.
  #raw = ""
  #context = false
  #value: ValueRead | undefined

  push(chunk: string): string {
    this.#raw = keptLineEnd(this.#raw, chunk)
    // Main drops the rest of an oversized value, closing quote and all, up to
    // its delimiter: a value being read here ends where main's drop does.
    const wasDropping = this.#held.dropping
    const shown = this.#held.push(chunk)
    if (wasDropping) this.#value = undefined
    const output = this.#read(shown)
    if (this.#held.dropping) this.#value = undefined
    return output
  }

  release(): string {
    const flushed = this.#held.flush()
    // Main has now shown the whole line, so the typed line says where a
    // value stands, better than what main showed for it.
    const typed = valueOpenInTypedLine(this.#raw)
    if (!typed) {
      const released = this.#read(flushed)
      this.#context = true
      if (this.#value === undefined) this.#value = valueEndingText(this.#seen())
      return released
    }
    // What main releases of a value still open is part of that value. When
    // main replaced none of it, it is the typed text itself, so where the
    // value starts in it is known.
    let released: string
    let hidden = false
    if (!flushed.includes(replacement)) {
      const releaseStart = this.#raw.length - collapseSpaces(flushed).length
      const keep = collapsedIndex(flushed, Math.max(0, typed.from - releaseStart))
      released = this.#read(flushed.slice(0, keep))
      if (keep < flushed.length) {
        released += replacement
        this.#see(replacement)
        hidden = true
      }
    } else {
      released = this.#read(flushed)
    }
    this.#context = true
    const { from: _from, ...read } = typed
    // A value's hidden characters go out as a replacement unless one was
    // just shown for it, so what is shown on either side is never joined.
    this.#value = { ...read, marked: hidden || released.endsWith(replacement) }
    return released
  }

  flush(): string {
    const output = this.#read(this.#held.flush())
    this.#line = ""
    this.#blankEnd = false
    this.#raw = ""
    this.#context = false
    this.#value = undefined
    return output
  }

  #read(text: string): string {
    let output = ""
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index]!
      if (character === "\n" || character === "\r") {
        this.#line = ""
        this.#blankEnd = false
        this.#context = false
        this.#value = undefined
        output += character
        continue
      }
      const value = this.#context ? this.#value : undefined
      if (value && !value.started && (character === '"' || character === "'")
        && text.startsWith(`${character}${replacement}${character}`, index)) {
        // Main replaced a quoted value here, and the value ends with it.
        const shown = `${character}${replacement}${character}`
        index += shown.length - 1
        this.#value = undefined
        output += shown
        this.#see(shown)
        continue
      }
      if (value?.quote !== undefined && text.startsWith(replacement, index)) {
        // Main replaced part of the quoted value, perhaps with its closing
        // quote: from here the value is read as an unquoted word.
        index += replacement.length - 1
        value.quote = undefined
        value.escaped = false
        if (!value.marked) {
          output += replacement
          this.#see(replacement)
          value.marked = true
        }
        continue
      }
      if (value && this.#hides(value, character)) {
        if (!value.marked) {
          output += replacement
          value.marked = true
        }
        // The context line holds the value as its replacement, so a name
        // before it is not read again as waiting for a value.
        if (!this.#line.endsWith(replacement)) this.#see(replacement)
        continue
      }
      output += character
      this.#see(character)
      if (this.#context && this.#value === undefined) this.#value = valueEndingText(this.#seen())
    }
    return output
  }

  // Whether this character belongs to the value being read, which ends the
  // value when it does not.
  #hides(value: ValueRead, character: string): boolean {
    if (value.quote !== undefined) {
      if (value.escaped) value.escaped = false
      else if (character === "\\" && value.quote === '"') value.escaped = true
      else if (character === value.quote) this.#value = undefined
      return true
    }
    if (!value.started) {
      if (character === " " || character === "\t") return false
      value.started = true
      if (character === '"' || character === "'") {
        value.quote = character
        return true
      }
    }
    if (valueEnd.test(character)) {
      this.#value = undefined
      return false
    }
    return true
  }

  // A run of spaces is kept as one: the patterns read any amount the same.
  // The line is cut back to the carry only once it has grown to twice that,
  // rather than on every character, and read through #seen, which cuts it
  // back first: the same last characters either way, at a fraction of the
  // copying.
  // Its last character is kept apart, since reading one from a line built by
  // joining would copy the line.
  #see(text: string): void {
    if ((text === " " || text === "\t") && this.#blankEnd) return
    if (text !== "") this.#blankEnd = text.endsWith(" ") || text.endsWith("\t")
    this.#line = `${this.#line}${text}`
    if (this.#line.length > 2 * terminalRedactionCarryCharacters) this.#line = this.#line.slice(-terminalRedactionCarryCharacters)
  }

  #seen(): string {
    if (this.#line.length > terminalRedactionCarryCharacters) this.#line = this.#line.slice(-terminalRedactionCarryCharacters)
    return this.#line
  }
}
