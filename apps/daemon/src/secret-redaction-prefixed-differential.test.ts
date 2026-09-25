import { writeFileSync } from "node:fs"
import { performance } from "node:perf_hooks"

import { describe, expect, it } from "vitest"

import {
  DurableOutputRedactor,
  type GroupingName,
  groupingConstructs,
  redactDurableCommand,
  redactDurableOutput,
  TerminalOutputRedactor,
} from "./secret-redaction.js"
import {
  DurableOutputRedactor as MainDurableOutputRedactor,
  redactDurableCommand as mainRedactDurableCommand,
  redactDurableOutput as mainRedactDurableOutput,
  TerminalOutputRedactor as MainTerminalOutputRedactor,
} from "./secret-redaction-baseline.js"

// Differential fuzz for secret names, against main's own code
// (secret-redaction-baseline.ts, pinned by its own test). Inputs are secret
// forms whose name mostly carries a prefix (X_API_KEY=, --x-token,
// -Dx.password=, /x-token:, $env:, set "…", JSON), plain lines, long runs
// around the terminal's 256-character carry. A quoted value (any quote in the
// reader's table: "…", '…', $'…', $"…") is drawn from a wide alphabet: spaces,
// tabs, CR, LF, CRLF, escaped quotes, the other quote, escaped backslashes, =,
// :, ; and non-ASCII letters, and its quote may never close. A value may also
// be any grouping construct in the reader's table (groupingConstructs in
// secret-redaction.ts: $(…), $((…)), <(…), >(…), ${…}, `…`, the quotes and an
// array's (…)),
// bare, inside double quotes or inside a word, holding spaces, tabs, CR, LF,
// CRLF, every construct the table lets open inside it, escapes, table syntax
// that is plain there, and heredocs (<<EOF, <<'EOF', <<-EOF) inside $(…); it
// may never close. A construct added to the table is generated with no change
// here, and a test fails if the generator misses one. A value may also begin
// with another name and its separator, or a separator alone, nested up to
// twice, with a line break where that syntax allows whitespace; a JSON or
// name: value may start on the next line; terminal formatting may follow the
// separator; and a -D property's or flag's = may have spaces around it (found
// by the differential fuzz of #598).
// Every input is redacted whole, split at every point into two reads, split
// into three reads at points drawn from the value's syntax characters or at
// random, and cut into random reads with idle beats between some, half the
// time with one inside the name's syntax. The checks:
// - no letter or digit of a secret value may show, unless the ruling shows
//   it: after a prefixed name, the word right before the sensitive name counts
//   (total, has, max, min, count, is, enable) and the value is a complete plain
//   number or true/false (ruled 2026-09-24). This is a direct oracle, not a
//   comparison with main, so a value main also shows is still a failure;
// - a complete counting value is shown exactly;
// - a plain line main shows exactly is shown exactly;
// - what follows a closed value and main keeps is kept;
// - no redaction takes longer than a second.
// A value counts as shown when any of its letters or digits occurs more often
// in the output than in the text around it, so a one-character value and a
// value shown in part are both caught.
// An idle beat makes the terminal emit everything it holds (server.ts calls
// release on an idle timer, flush before #598), which shows any unquoted value typed after its name
// on main as well; that is the idle-release fix in #575. Across an idle beat,
// and for a name longer than the 256 characters the terminal carries, the
// terminal is held only to hiding what main hides. There, too, it may hide
// more than main, and nothing else: ruled by fetzy 2026-09-24, where the
// terminal has lost what came before a name, a quote in the value opens a
// quote, failing closed, so a set "NAME=value" split there may hide what
// follows until another quote arrives. Losing kept text is allowed there when
// a quote follows the value's start; showing a value main hides never is. Seeded: a failure names its seed, its
// shape and a minimal list of reads.

type Step = string | "idle"
// hide: the value must never show. show: the text must come out unchanged.
// either: a counting value the ruling may show, read another way when a
// separator, a name or formatting comes before it (--total-token =5 is the
// counting value 5, token==5 is the value =5), so it may show or be hidden.
// plain: no secret.
type Rule = "hide" | "show" | "either" | "plain"
// longName: a name longer than the terminal carries, which the terminal is
// held to main on.
// nameSpan: where the name and its syntax sit, from its flag dashes or -D to
// the value, so a read can be cut inside it with an idle beat.
type Case = { shape: string, text: string, value?: string, rule: Rule, kept: readonly string[], longName?: boolean, nameSpan?: readonly [number, number] }

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), state | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

const valueLetters = "zqxjwvkm"
const sensitiveNames = [
  "token", "password", "API_KEY", "api-key", "secret", "secret_key", "auth-token", "access_token",
  "client_secret", "passwd", "credentials", "cookie", "private-key", "github_token",
]
const countingWords = ["total", "has", "max", "min", "count", "is", "enable"]
// Words that are neither counting words nor part of a sensitive name.
const otherWords = ["db", "x", "npm", "config", "my", "app", "limit", "service", "ci", "prod"]
const separators = ["_", ".", "-"]
// Terminal formatting a program may print between a name's separator and its
// value.
const formatting = ["\u001b[0m", "\u001b[1m", "\u001b[32m", "\u001b[2K"]
const lineBreaks = ["\n", "\r\n", "\r"]

// What may sit inside a quoted value besides letters. An escape is a
// backslash and the character it escapes, so a value never ends in a lone
// backslash that would escape its own closing quote.
// A quote opened before a name (set "NAME=…", echo 'NAME=…') is read with the
// same escapes as the table's entry for that quote, so it draws the same
// pieces, escaped quotes of both kinds among them.
function widePieces(close: string): ReadonlyArray<readonly [string, string]> {
  const pieces: Array<readonly [string, string]> = [
    ["space", " "], ["tab", "\t"], ["cr", "\r"], ["lf", "\n"], ["crlf", "\r\n"],
    ["equals", "="], ["colon", ":"], ["semicolon", ";"], ["non-ascii", "é"], ["non-ascii", "ж"], ["non-ascii", "漢"],
  ]
  const other = close === "\"" ? "'" : "\""
  return [...pieces, ["escaped-quote", `\\${close}`], ["escaped-backslash", "\\\\"], ["other-quote", other], ["escaped-other-quote", `\\${other}`]]
}

// The reader's grouping constructs, from its own table: what opens where a
// value starts (a quote), what opens anywhere in a word, and what opens only
// inside another construct.
const groupingNames = Object.keys(groupingConstructs) as GroupingName[]
const valueStartNames = groupingNames.filter((name) => groupingConstructs[name].at !== "inside")
const valueStartOnly = groupingNames.filter((name) => groupingConstructs[name].at !== "inside" && groupingConstructs[name].at !== "word")
// The quotes: what makes a value quoted where it starts and lets neither
// quote open inside it, so the wide alphabet's other quote is plain there.
const quoteNames = valueStartOnly.filter((name) => !groupingConstructs[name].inside.some((inner) => valueStartOnly.includes(inner)))
// What may open after plain characters of a word, as bash reads one word:
// every construct that opens in a word, and every quote.
const inWordNames = groupingNames.filter((name) => groupingConstructs[name].at === "word" || quoteNames.includes(name))

// Text that is plain inside a construct: an opener or closer from the table
// that opens nothing there and does not close it. Letters come before and
// after every piece, and letters complete no opener.
function plainPieces(name: GroupingName): string[] {
  const construct = groupingConstructs[name]
  const openers = construct.inside.map((inner) => groupingConstructs[inner].opener)
  const candidates = new Set(groupingNames.flatMap((other) => [groupingConstructs[other].opener, groupingConstructs[other].closer]))
  return [...candidates].filter((text) => !text.includes("\\") && !text.includes(construct.closer[0]!) && !openers.some((opener) => text.includes(opener)))
}

// A grouping construct from the reader's table, of words and what may sit
// between them: spaces, tabs and line breaks, every construct the table lets
// open inside it (nested up to two deep), escapes where it takes them, and
// table syntax that is plain inside it. A heredoc goes last inside $(…),
// since its terminator needs a line of its own before the closing
// parenthesis. An unclosed construct is the closed one cut short at a random
// point inside it, so any nesting, quote or escape may be left open.
function grouping(next: () => number, word: (length: number) => string, features: string[], outer: GroupingName): { text: string, closed: boolean } {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
  const chance = (probability: number) => next() < probability
  const short = () => word(1 + Math.floor(next() * 3))
  const build = (name: GroupingName, depth: number): string => {
    const construct = groupingConstructs[name]
    features.push(`construct-${name}`)
    const pieces: Array<readonly [string, () => string]> = [
      ["space", () => " "], ["tab", () => "\t"], ["lf", () => "\n"], ["crlf", () => "\r\n"], ["cr", () => "\r"],
      ...plainPieces(name).map((text) => ["plain-syntax", () => text] as const),
    ]
    if (construct.escapes) pieces.push(["escaped-closer", () => `\\${construct.closer[0]!}`], ["escaped-backslash", () => "\\\\"], ["escaped-dollar", () => "\\$"])
    const nests = depth < 2 && construct.inside.length > 0
    let body = short()
    const count = 1 + Math.floor(next() * 4)
    for (let index = 0; index < count; index += 1) {
      if (nests && chance(0.4)) {
        features.push("sub-nested")
        body += ` ${build(pick(construct.inside), depth + 1)} ${short()}`
        continue
      }
      const [feature, piece] = pick(pieces)
      features.push(`sub-${feature}`)
      body += `${piece()}${short()}`
    }
    if (depth === 0 && chance(0.05)) { features.push("sub-long"); body += ` ${word(260 + Math.floor(next() * 40))}` }
    if (name === "commandSubstitution" && depth === 0 && chance(0.15)) {
      const [feature, marker, indent] = pick([["heredoc", "EOF", ""], ["heredoc-quoted", "'EOF'", ""], ["heredoc-dash", "-EOF", "\t"]] as const)
      features.push(`sub-${feature}`)
      body += ` <<${marker}\n${indent}${short()} ${short()}\n${indent}${short()}\n${indent}EOF\n`
    }
    return `${construct.opener}${body}${construct.closer}`
  }
  features.push(`outer-${outer}`)
  const closedText = build(outer, 0)
  if (!chance(0.2)) return { text: closedText, closed: true }
  features.push("unclosed-substitution")
  const opener = groupingConstructs[outer].opener.length
  const cutAt = opener + 1 + Math.floor(next() * (closedText.length - opener - 1))
  return { text: closedText.slice(0, cutAt), closed: false }
}

function generatePrefixed(next: () => number): Case {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
  const chance = (probability: number) => next() < probability
  const features: string[] = []
  const word = (length: number) => Array.from({ length }, () => pick(valueLetters.split(""))).join("")
  const digits = (length: number) => Array.from({ length }, (_, at) => String(at === 0 ? 1 + Math.floor(next() * 9) : Math.floor(next() * 10))).join("")

  // The name: prefix segments, then the sensitive name. The last segment
  // decides the ruling.
  const sensitive = pick(sensitiveNames)
  const prefixed = chance(0.85)
  let name = sensitive
  let counting = false
  if (prefixed) {
    const separator = pick(separators)
    const segments: string[] = []
    if (chance(0.25)) { features.push("several-segments"); segments.push(pick([...otherWords, ...countingWords])) }
    if (chance(0.1)) { features.push("empty-segment"); segments.push("") }
    counting = chance(0.5)
    const last = counting ? pick(countingWords) : pick(otherWords)
    segments.push(last)
    if (chance(0.03)) { features.push("long-prefix"); segments.unshift(...Array.from({ length: 1_500 }, () => "a")) }
    name = `${segments.join(chance(0.8) ? separator : pick(separators))}${separator}${sensitive}`
    features.push(counting ? "counting" : "other-word")
  } else {
    features.push("unprefixed")
  }
  if (chance(0.3)) name = name.toUpperCase()

  const form = pick([
    "assignment", "export", "env", "set", "cmd-set", "echo-enclosed", "json", "json-mixed", "structured",
    "flag-space", "flag-equals", "single-dash-space", "single-dash-equals", "slash-colon", "property",
  ])
  const jsonLike = form === "json" || form === "json-mixed"
  // A quote opened right before the name encloses the value: cmd's
  // set "NAME=…" and a quoted argument such as echo 'NAME=…'.
  const enclosed = form === "cmd-set" || form === "echo-enclosed"
  const enclosingQuote = enclosed ? pick(["\"", "'"]) : undefined
  if (enclosingQuote !== undefined) features.push(`enclosed-${enclosingQuote === "\"" ? "double" : "single"}`)

  // The value: a secret word, a plain number or true/false, a number that
  // goes on, a long run around the carry, or a wide quoted value.
  // A value past the durable 8,192-character bound is costly to split at
  // every point, so it comes up a third as often as the others.
  let kind = pick(["word", "number", "number", "decimal", "boolean", "number-then-word", "carry", "long", "wide", "wide", "wide", "substitution", "substitution", "substitution"])
  if (kind === "long" && !chance(1 / 3)) kind = "carry"
  // An enclosed value and a JSON string with a following key hold no
  // substitution here.
  if (kind === "substitution" && (enclosed || form === "json-mixed")) kind = "wide"
  // The quote: none, or one of the table's quotes: "…", '…', $'…' or $"…". A
  // wide value is always quoted, since unquoted it would end at its first
  // space. JSON strings take double quotes. A substitution is bare, when it
  // may be any construct that opens where a value starts, a quote or an
  // array included, or in double quotes, when it is one the double quote lets
  // open.
  const quoteOpeners = quoteNames.map((name) => groupingConstructs[name].opener)
  const opener = enclosed || form === "json-mixed"
    ? ""
    : kind === "wide"
      ? (jsonLike ? "\"" : pick(quoteOpeners))
      : kind === "substitution"
        ? (jsonLike || chance(0.3) ? "\"" : "")
        : chance(0.3) ? (jsonLike ? "\"" : pick(["\"", "'"])) : ""
  const close = enclosingQuote ?? (form === "json-mixed" ? "\"" : opener.slice(-1))
  let value: string
  // Whether a substitution in the value closed.
  let substitutionClosed = true
  switch (kind) {
    case "number": value = chance(0.5) ? digits(3 + Math.floor(next() * 4)) : String(1 + Math.floor(next() * 9)); break
    case "decimal": value = `${digits(3)}.${digits(3)}`; break
    case "boolean": value = pick(["true", "false", "TRUE", "False"]); break
    case "number-then-word": value = `${digits(1 + Math.floor(next() * 3))}${word(3 + Math.floor(next() * 3))}`; break
    case "carry": value = word(240 + Math.floor(next() * 32)); break
    case "long": value = word(9_000 + Math.floor(next() * 400)); break
    case "wide": {
      const pieces = widePieces(close)
      value = word(1 + Math.floor(next() * 3))
      const count = 1 + Math.floor(next() * 5)
      for (let index = 0; index < count; index += 1) {
        const [feature, piece] = pick(pieces)
        features.push(`wide-${feature}`)
        value += `${piece}${word(1 + Math.floor(next() * 3))}`
      }
      if (chance(0.05)) { features.push("wide-long"); value += word(260 + Math.floor(next() * 40)) }
      break
    }
    case "substitution": {
      const outer = pick(opener ? groupingConstructs.doubleQuote.inside : valueStartNames)
      const built = grouping(next, word, features, outer)
      substitutionClosed = built.closed
      // Bare, a construct that opens in a word, a quote included, may sit
      // inside one, with letters before it and, once closed, after it.
      const inWord = !opener && inWordNames.includes(outer)
      const lead = inWord && chance(0.3) ? (features.push("sub-in-word", `in-word-${outer}`), word(2)) : ""
      const tail = inWord && built.closed && chance(0.15) ? (features.push("sub-in-word"), word(2)) : ""
      value = `${lead}${built.text}${tail}`
      break
    }
    default: value = word(6 + Math.floor(next() * 7)); break
  }
  features.push(`value-${kind}`)
  const quoteName = quoteNames.find((name) => groupingConstructs[name].opener === opener)
  if (quoteName !== undefined) features.push(`quote-${quoteName}`, `construct-${quoteName}`)
  // An enclosed value is one shell word with its quote: letters may follow
  // the closing quote, as in set "NAME=a b"c, and belong to the value.
  const enclosedClosed = enclosed && chance(0.7)
  if (enclosed && !enclosedClosed) features.push("unclosed-enclosure")
  if (enclosedClosed && chance(0.2)) { features.push("enclosed-tail"); value = `${value}${close}${word(2)}` }
  const enclosedCloser = enclosedClosed && !features.includes("enclosed-tail") ? close : ""
  const plain = /^(?:\d+(?:\.\d+)?|true|false)$/iu.test(value)

  // Inside a substitution that never closes, a closing quote would be part of
  // it, so the quote is left off too.
  const closed = !opener || (substitutionClosed && chance(0.8))
  if (opener && !closed) features.push("unclosed-quote")
  const space = () => chance(0.2) ? " " : ""
  // Found by the differential fuzz of #598: a value may begin with another
  // name and its separator, or a separator alone, nested up to twice, whose
  // own value is the secret (-DGITHUB_TOKEN ==Password: value). Where the
  // inner syntax allows whitespace, it may be a line break.
  const gap = (fallback: string): string => {
    if (chance(0.3)) { features.push("cross-line"); return pick(lineBreaks) }
    return fallback
  }
  let nested = ""
  if (!enclosed && form !== "json-mixed") {
    for (let depth = 0; depth < 2 && chance(0.12); depth += 1) {
      const inner = pick(sensitiveNames)
      features.push("nested")
      nested = `${pick([
        `${inner}=`, `${inner}=${gap(" ")}`, `--${inner}${gap(" ")}`, `--${inner}=`, `-D${inner}=`, `${inner}:${gap(" ")}`,
        `"${inner}":`, "=", ":", `/${inner}:`,
      ])}${nested}`
    }
  }
  // Terminal formatting right before the value, after its separator and any
  // name inside it, and spaces around a -D property's or a flag's =.
  const formatted = ["assignment", "structured", "flag-equals", "property"].includes(form)
  const ansi = formatted && chance(0.08) ? (features.push("ansi"), pick(formatting)) : ""
  const spaced = () => chance(0.15) ? (features.push("spaced-equals"), pick([" ", "  "])) : ""
  const quoted = `${nested}${ansi}${opener}${value}${closed ? close : ""}`
  const before = chance(0.05) ? (features.push("filler-near-carry"), `${pick([" ", "a"]).repeat(236 + Math.floor(next() * 40))} `) : ""

  let text: string
  let kept: string[] = []
  // Whether the value, as written, is complete: its quote closed and a
  // delimiter or the end of the text right after it.
  let complete = closed && substitutionClosed
  switch (form) {
    case "assignment": text = `${name}${space()}=${space()}${quoted}`; break
    case "export": text = `export ${name}=${quoted}`; break
    case "env": text = `$env:${name}=${quoted}`; break
    case "set": text = `set ${name}=${quoted}`; break
    case "cmd-set": complete = enclosedClosed; text = `set ${close}${name}=${value}${enclosedCloser}`; break
    case "echo-enclosed": complete = enclosedClosed; text = `echo ${close}${name}=${value}${enclosedCloser} -s`; kept = [" -s"]; break
    case "json": text = `{"${name}":${gap(space())}${quoted}}`; break
    case "json-mixed": text = `{"${name}":"${value}","safe":"visible"}`; kept = [`"safe":"visible"}`]; complete = true; break
    case "structured": text = `${name}:${gap(space() || " ")}${quoted}`; break
    case "flag-space": text = `curl --${name} ${quoted} -s`; kept = [" -s"]; break
    case "flag-equals": text = `curl --${name}${spaced()}=${spaced()}${quoted} -s`; kept = [" -s"]; break
    case "single-dash-space": text = `tool -${name} ${quoted} -s`; kept = [" -s"]; break
    case "single-dash-equals": text = `tool -${name}${spaced()}=${spaced()}${quoted} -s`; kept = [" -s"]; break
    case "slash-colon": text = `tool /${name}:${quoted} -s`; kept = [" -s"]; break
    default: text = `java -D${name}${spaced()}=${spaced()}${quoted} -jar app.jar`; kept = [" -jar app.jar"]; break
  }
  const following = chance(0.15) ? (features.push("following-line"), pick(["\nvisible output\n", "\r\nvisible output\r\n"])) : ""
  const ending = following ? "" : pick(["\r\n", "\n", ""])
  // After a quote that never closes, everything after it is inside the value,
  // the following line included.
  if (complete && following) kept = [...kept, "visible output"]
  if (!complete) kept = []

  let rule: Rule
  if (prefixed && counting && plain && complete) rule = nested === "" && ansi === "" ? "show" : "either"
  else rule = "hide"
  const nameAt = text.indexOf(name)
  return {
    shape: [`${prefixed ? "prefixed" : "unprefixed"}-${form}`, ...[...new Set(features)].sort()].join("+"),
    text: `${before}${text}${ending}${following}`,
    value,
    rule,
    kept,
    longName: name.length > 200,
    nameSpan: [before.length + Math.max(0, nameAt - 2), before.length + text.indexOf(value, nameAt + name.length)],
  }
}

function generatePlain(next: () => number): Case {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
  const line = pick([
    "passwords are hashed", "Enter password below", "token count 5", "me@host:~$ ls -la", "TOKEN_BUDGET=100",
    "token_count=5", "api_key_rotation: weekly", "mysql --skip-password db", "tool --no-token build",
    "run --without-secret now", "--password-file ./pw.txt", "the token was rotated", "secret sauce recipe",
    "x-token-count: 12", "Downloading 10%\rDownloading 20%", "say \"password reset sent\"", "grep -n 'secret' notes.txt",
  ])
  return { shape: "plain", text: `${line}${pick(["\r\n", "\n"])}`, rule: "plain", kept: [] }
}

function generate(next: () => number): Case {
  return next() < 0.15 ? generatePlain(next) : generatePrefixed(next)
}

// Half the time one cut falls inside the name's syntax, from its flag dashes
// or -D to its value, with an idle beat after it, as a name split by an idle
// beat (found by the differential fuzz of #598).
function cut(text: string, next: () => number, nameSpan?: readonly [number, number]): Step[] {
  const cuts = new Set<number>()
  const count = Math.floor(next() * 6)
  for (let index = 0; index < count; index += 1) cuts.add(1 + Math.floor(next() * Math.max(1, text.length - 1)))
  let inName: number | undefined
  if (nameSpan !== undefined && nameSpan[1] - nameSpan[0] > 1 && next() < 0.5) {
    inName = nameSpan[0] + 1 + Math.floor(next() * (nameSpan[1] - nameSpan[0] - 1))
    cuts.add(inName)
  }
  const points = [...cuts].sort((left, right) => left - right)
  const steps: Step[] = []
  let from = 0
  for (const point of points) {
    if (point <= from || point >= text.length) continue
    steps.push(text.slice(from, point))
    if (next() < 0.3 || point === inName) steps.push("idle")
    from = point
  }
  steps.push(text.slice(from))
  if (next() < 0.3) steps.push("idle")
  return steps
}

// A text up to this long is split at every point; every text the generator
// makes is, except those with a long prefix or a value past the durable
// bound. Those are split at every point within this many characters of their
// start, of each end of their value, of the terminal's carry past the start
// and on either side of the value's start, and of their end, and at every
// 97th point elsewhere, so a 9,000-character value costs hundreds of splits
// rather than thousands.
const everyPointLength = 1_000
const everyPointWindow = 64

function splitPoints(item: Case): number[] {
  const length = item.text.length
  if (length <= everyPointLength) return Array.from({ length: Math.max(0, length - 1) }, (_, at) => at + 1)
  const carry = 256
  const marks = [0, carry, length]
  if (item.value !== undefined) {
    const at = item.text.indexOf(item.value)
    marks.push(at - carry, at, at + carry, at + item.value.length)
  }
  const points: number[] = []
  for (let at = 1; at < length; at += 1) {
    if (at % 97 === 0 || marks.some((mark) => Math.abs(mark - at) <= everyPointWindow)) points.push(at)
  }
  return points
}

// Where a value's syntax sits: its quotes, substitution delimiters,
// backslashes and whitespace, just before or just after each. Cuts there
// split an escape from what it escapes, $ from (, and a delimiter from its
// neighbours.
function syntaxPoints(item: Case): number[] {
  if (item.value === undefined) return []
  const start = item.text.indexOf(item.value)
  const points: number[] = []
  for (let at = 0; at < item.value.length; at += 1) {
    if (/[$()`"'\\\s]/u.test(item.value[at]!)) points.push(start + at, start + at + 1)
  }
  return points.filter((point) => point > 0 && point < item.text.length)
}

// Every way a case is read: whole, split at every point into two reads, split
// into three reads (three times, each cut at a syntax point of the value half
// the time and at random otherwise), and cut into random reads with idle
// beats.
function readings(item: Case, next: () => number): Step[][] {
  const text = item.text
  const all: Step[][] = [[text]]
  for (const at of splitPoints(item)) all.push([text.slice(0, at), text.slice(at)])
  if (text.length >= 3) {
    const syntax = syntaxPoints(item)
    const point = (from: number) => {
      const random = from + Math.floor(next() * (text.length - from))
      const candidates = syntax.filter((at) => at >= from && at < text.length)
      return candidates.length > 0 && next() < 0.5 ? candidates[Math.floor(next() * candidates.length)]! : random
    }
    for (let index = 0; index < 3; index += 1) {
      const first = Math.min(point(1), text.length - 2)
      const second = Math.max(first + 1, Math.min(point(first + 1), text.length - 1))
      all.push([text.slice(0, first), text.slice(first, second), text.slice(second)])
    }
  }
  all.push(cut(text, next, item.nameSpan))
  return all
}

// What a value shows is measured by counting: none of its letters or digits
// may occur more often in the output than in the text around the value, once
// the redactors' own markers are taken out. A value of any length is checked,
// and a value shown in part counts as shown.
function fragments(value: string): string[] {
  return [...new Set(value.match(/[\p{L}\p{N}]/gu) ?? [])]
}

const markers = ["[REDACTED]", "[Long command output line omitted]", "…"]

function occurrences(text: string, piece: string): number {
  return text.split(piece).length - 1
}

function exposed(item: Case, output: string): string | undefined {
  const value = item.value!
  const at = item.text.indexOf(value)
  if (at < 0) throw new Error(`the value of ${item.shape} is not in its text`)
  const around = `${item.text.slice(0, at)}${item.text.slice(at + value.length)}`
  const shown = markers.reduce((text, marker) => text.replaceAll(marker, "\u0000"), output)
  const pieces = fragments(value)
  if (pieces.length === 0) throw new Error(`the value of ${item.shape} has nothing to check`)
  return pieces.find((piece) => occurrences(shown, piece) > occurrences(around, piece))
}

type Pair = {
  name: string
  // Whether the reads reach this redactor, or only the whole text.
  streaming: boolean
  // Whether an idle beat in the reads reaches this redactor.
  idleMatters: boolean
  main: (item: Case, steps: readonly Step[]) => string
  current: (item: Case, steps: readonly Step[]) => string
}

const pairs: readonly Pair[] = [
  {
    name: "terminal",
    streaming: true,
    idleMatters: true,
    main: (_item, steps) => {
      const redactor = new MainTerminalOutputRedactor()
      return steps.map((step) => step === "idle" ? redactor.flush() : redactor.push(step)).join("") + redactor.flush()
    },
    // An idle beat is a release, as server.ts sends it since #598; the end of
    // the output is a flush.
    current: (_item, steps) => {
      const redactor = new TerminalOutputRedactor()
      return steps.map((step) => step === "idle" ? redactor.release() : redactor.push(step)).join("") + redactor.flush()
    },
  },
  {
    name: "durable output stream",
    streaming: true,
    idleMatters: false,
    main: (_item, steps) => {
      const redactor = new MainDurableOutputRedactor()
      return steps.map((step) => step === "idle" ? "" : redactor.push(step)).join("") + redactor.flush()
    },
    current: (_item, steps) => {
      const redactor = new DurableOutputRedactor()
      return steps.map((step) => step === "idle" ? "" : redactor.push(step)).join("") + redactor.flush()
    },
  },
  { name: "durable output", streaming: false, idleMatters: false, main: (item) => mainRedactDurableOutput(item.text).value, current: (item) => redactDurableOutput(item.text).value },
  { name: "durable command", streaming: false, idleMatters: false, main: (item) => mainRedactDurableCommand(item.text).value, current: (item) => redactDurableCommand(item.text).value },
]

// A durable command is cut at 8,192 characters, so a text longer than that is
// not held to showing anything whole.
function withinBound(pair: Pair, item: Case): boolean {
  return pair.name !== "durable command" || item.text.length <= 8_192
}

const slowMilliseconds = 1_000

type Failure = { pair: string, kind: string, detail: string, steps: readonly Step[] }

function judge(pair: Pair, item: Case, steps: readonly Step[]): Failure | undefined {
  const fail = (kind: string, detail: string): Failure => ({ pair: pair.name, kind, detail, steps })
  const started = performance.now()
  const current = pair.current(item, steps)
  const elapsed = performance.now() - started
  if (elapsed > slowMilliseconds) return fail("slow", `${Math.round(elapsed)} ms`)
  if (!withinBound(pair, item)) return undefined
  let mainOutput: string | undefined
  const main = () => mainOutput ??= pair.main(item, steps)
  const absolute = !(pair.idleMatters && (steps.includes("idle") || item.longName))
  if (item.rule === "plain") {
    if (absolute && current !== item.text && main() === item.text) return fail("plain line changed", JSON.stringify(current.slice(0, 160)))
    return undefined
  }
  if (item.rule === "show") {
    if (absolute && current !== item.text) return fail("complete counting value not shown", JSON.stringify(current.slice(0, 160)))
    return undefined
  }
  if (item.rule === "either") return undefined
  // Across an idle beat or a name past the carry, the terminal may hide more
  // than main where a quote from the value on may open (ruled 2026-09-24),
  // never less.
  const quoteMayOpen = !absolute && item.value !== undefined && /["']/u.test(item.text.slice(item.text.indexOf(item.value)))
  const lost = quoteMayOpen ? undefined : item.kept.find((part) => !current.includes(part) && main().includes(part))
  if (lost !== undefined) return fail("loses what main keeps", `${JSON.stringify(lost)}: ${JSON.stringify(current.slice(-160))}`)
  const shown = exposed(item, current)
  if (shown === undefined) return undefined
  const mainHides = exposed(item, main()) === undefined
  if (mainHides) return fail("shows a value main hides", JSON.stringify(shown))
  if (absolute) return fail("shows a value (main shows it too)", JSON.stringify(shown))
  return undefined
}

function failure(item: Case, all: readonly (readonly Step[])[], under: readonly Pair[] = pairs): Failure | undefined {
  for (const pair of under) {
    for (const steps of pair.streaming ? all : all.slice(0, 1)) {
      const problem = judge(pair, item, steps)
      if (problem) return problem
    }
  }
  return undefined
}

function shrink(item: Case, pair: Pair, steps: readonly Step[]): Step[] {
  let best = [...steps]
  let improved = true
  while (improved) {
    improved = false
    for (let index = 0; index < best.length && !improved; index += 1) {
      const candidates: Step[][] = [best.filter((_, at) => at !== index)]
      const here = best[index]
      const following = best[index + 1]
      if (here !== "idle" && following !== undefined && following !== "idle") {
        candidates.push([...best.slice(0, index), here + following, ...best.slice(index + 2)])
      }
      for (const candidate of candidates) {
        if (candidate.length === 0 || candidate.every((step) => step === "idle")) continue
        const text = candidate.filter((step): step is string => step !== "idle").join("")
        if (text !== item.text) continue
        if (judge(pair, item, candidate)) { best = candidate; improved = true; break }
      }
    }
  }
  return best
}

const cases = Number(process.env.PREFIXED_REDACTION_FUZZ_CASES ?? 1_000)
const seed = Number(process.env.PREFIXED_REDACTION_FUZZ_SEED ?? 20_260_924)
if (!Number.isSafeInteger(cases) || cases < 1 || !Number.isSafeInteger(seed)) {
  throw new Error("PREFIXED_REDACTION_FUZZ_CASES and PREFIXED_REDACTION_FUZZ_SEED must be integers")
}

// The run's time budget is the one each redaction had when a case was read
// only once, as eight redactions in 3 ms: 0.375 ms a redaction, for as many
// redactions as the cases will now make.
function plannedRedactions(): number {
  let total = 0
  for (let index = 0; index < cases; index += 1) {
    const item = generate(random(seed + index))
    const readingsOfCase = 1 + splitPoints(item).length + (item.text.length >= 3 ? 3 : 0) + 1
    total += readingsOfCase * 2 + 2
  }
  return total
}
const millisecondsPerRedaction = 0.375

function show(step: Step): string {
  return step !== "idle" && step.length > 60 ? `${step.slice(0, 40)}…(${step.length})` : step
}

// A failure is reported once per family: the form, whether the name is
// prefixed, the quote and whether it closed, a substitution, its kind and
// whether it closed, the redactor and the failure.
function family(item: Case): string {
  const features = item.shape.split("+")
  const kept = features.filter((feature) => feature.startsWith("quote-") || feature === "unclosed-quote" || feature === "unclosed-enclosure" || feature.startsWith("enclosed-") || feature === "value-wide" || feature === "long-prefix"
    || feature === "value-substitution" || feature === "unclosed-substitution" || feature.startsWith("outer-") || feature.startsWith("in-word-")
    || feature === "nested" || feature === "cross-line" || feature === "ansi" || feature === "spaced-equals")
  return [features[0], ...kept].join("+")
}

describe("secret names against main", () => {
  const planned = plannedRedactions()
  it(`hides secret values, shows only complete counting values, and keeps what main keeps, ${cases} cases from seed ${seed}`, () => {
    const failures = new Map<string, string>()
    let redactions = 0
    for (let index = 0; index < cases; index += 1) {
      const caseSeed = seed + index
      const next = random(caseSeed)
      const item = generate(next)
      const all = readings(item, next)
      redactions += all.length * 2 + 2
      if (!failure(item, all)) continue
      for (const pair of pairs) {
        const problem = failure(item, all, [pair])
        if (!problem) continue
        const key = `${family(item)} (${problem.pair}: ${problem.kind})`
        if (failures.has(key)) continue
        const minimal = shrink(item, pair, problem.steps)
        failures.set(key, `seed ${caseSeed} ${item.shape}: ${problem.detail}\n  reads ${JSON.stringify(minimal.map(show))}`)
      }
    }
    const report = [...failures].map(([shape, detail]) => `${shape}\n  ${detail}`)
    if (process.env.PREFIXED_REDACTION_FUZZ_REPORT) {
      writeFileSync(process.env.PREFIXED_REDACTION_FUZZ_REPORT, [...report, `${cases} cases from seed ${seed}, ${redactions} redactions, ${failures.size} failing families`].join("\n"))
    }
    expect(redactions).toBe(planned)
    expect(report).toEqual([])
  }, 10_000 + Math.ceil(planned * millisecondsPerRedaction))
})

// Shapes that end the terminal's drop of a value longer than its carry, each
// split at every point across two reads: a quoted value with an escaped quote
// inside it, and a name that fills the carry before its quoted value starts.
describe("values the terminal drops, split at every point", () => {
  const long = valueLetters.repeat(34)
  const escaped = `${long}\\"mkqz`
  const escapedSingle = `${long}\\'mkqz`
  const keyOf = (length: number) => `${"a".repeat(length - "-token".length)}-token`
  const splitCases: Case[] = [
    { shape: "escaped-quote-assignment", text: `token="${escaped}" -s\n`, value: escaped, rule: "hide", kept: [" -s"] },
    { shape: "escaped-quote-prefixed", text: `export X_TOKEN="${escaped}" -s\n`, value: escaped, rule: "hide", kept: [" -s"] },
    { shape: "escaped-quote-json", text: `{"x-token": "${escaped}", "safe": "visible"}\n`, value: escaped, rule: "hide", kept: ["\"safe\": \"visible\"}"] },
    { shape: "escaped-quote-json-tight", text: `{"x-token":"${escaped}","safe":"visible"}\n`, value: escaped, rule: "hide", kept: ["\"safe\":\"visible\"}"] },
    { shape: "escaped-single-quote", text: `x.secret='${escapedSingle}' -s\n`, value: escapedSingle, rule: "hide", kept: [" -s"] },
    { shape: "escaped-flag-space", text: `run --x-token "zqxj\\"mkqz" -s\n`, value: "zqxj\\\"mkqz", rule: "hide", kept: [" -s"] },
    { shape: "escaped-flag-equals-single", text: `run --x-token='zqxj\\'mkqz' -s\n`, value: "zqxj\\'mkqz", rule: "hide", kept: [" -s"] },
    { shape: "escaped-one-dash-flag", text: `tool -db-password "zqxj\\\\\\"mkqz" -s\n`, value: "zqxj\\\\\\\"mkqz", rule: "hide", kept: [" -s"] },
    { shape: "escaped-property", text: `java -Dx.password="zqxj\\"mkqz" -jar app.jar\n`, value: "zqxj\\\"mkqz", rule: "hide", kept: [" -jar app.jar"] },
    { shape: "escaped-flag-long", text: `run --x-token "${escaped}" -s\n`, value: escaped, rule: "hide", kept: [" -s"] },
    { shape: "escaped-backslash", text: `token="${long}\\\\" -s mkqz\n`, value: `${long}\\\\`, rule: "hide", kept: [" -s mkqz"] },
    ...[250, 252, 253, 254, 255, 256, 258].flatMap((length): Case[] => [
      { shape: `long-key-${length}-json-spaced`, text: `{"${keyOf(length)}": "zqx jwvk", "safe": "visible"}\n`, value: "zqx jwvk", rule: "hide", kept: ["\"safe\": \"visible\"}"], longName: true },
      { shape: `long-key-${length}-json-tight`, text: `{"${keyOf(length)}":"zqxjwvkm","safe":"visible"}\n`, value: "zqxjwvkm", rule: "hide", kept: ["\"safe\":\"visible\"}"], longName: true },
    ]),
    { shape: "long-key-json-single", text: `{"${keyOf(254)}": 'zqx jwvk', "safe": "visible"}\n`, value: "zqx jwvk", rule: "hide", kept: ["\"safe\": \"visible\"}"], longName: true },
    { shape: "long-key-assignment", text: `${keyOf(254)}="zqx jwvk" -s\n`, value: "zqx jwvk", rule: "hide", kept: [" -s"], longName: true },
    { shape: "long-key-long-value", text: `{"${keyOf(254)}": "${long} mkqz", "safe": "visible"}\n`, value: `${long} mkqz`, rule: "hide", kept: ["\"safe\": \"visible\"}"], longName: true },
    // Command substitutions, which run to their matching closing delimiter.
    ...[
      ["sub-assignment", "TOKEN=", "$(get zqx jwvk)"],
      ["sub-backtick-flag", "run --token ", "`get zqx jwvk`"],
      ["sub-nested", "export X_TOKEN=", "$(get $(zqx\tjwvk) \"m)q\" `kz\nvw`)"],
      ["sub-in-quotes", "NPM_TOKEN=\"", "$(get \"zqx jwvk\")"],
      ["sub-heredoc", "X_PASSWORD=", "$(cat <<'EOF'\nzqx jwvk\nEOF\n)"],
      ["sub-escaped-backtick", "token=", "`get \\`zqx jwvk\\` mq`"],
      ["sub-in-word", "run --db-password=", "zq$(get x\r\njwvk)vk"],
      ["sub-long", "TOKEN=", `$(get ${long} zqx)`],
      ["sub-long-nested", "run --x-token \"", `$(get $(${long}) zqx)`],
      ["sub-process-long", "NPM_TOKEN=", `<(printf ${long} zqx)`],
      ["sub-parameter-long", "TOKEN=", `\${VAR:-${long} zqx}`],
      ["sub-arithmetic-long", "TOKEN=", `$((${long} + (zqx * 2)))`],
    ].map(([shape, before, value]): Case => ({
      shape: shape!,
      text: `${before!}${value!}${before!.endsWith("\"") ? "\"" : ""} -s\n`,
      value: value!,
      rule: "hide",
      kept: [" -s"],
    })),
  ]

  it.each(splitCases)("$shape", (item) => {
    const failed: string[] = []
    for (let at = 1; at < item.text.length; at += 1) {
      const problem = failure(item, [[item.text.slice(0, at), item.text.slice(at)]])
      if (problem) failed.push(`${at} ${problem.pair}: ${problem.kind}: ${problem.detail}`)
    }
    expect(failed).toEqual([])
  })
})

// The check of the check: a redactor that shows everything, or all but one
// character of a value, must fail the same oracle.
function standIn(show: (item: Case) => string): readonly Pair[] {
  return pairs.map((pair) => ({ ...pair, current: (item: Case) => show(item) }))
}
const identity = standIn((item) => item.text)
// Shows the first letter or digit of the value, since a value such as
// $(get x) opens with syntax the oracle does not count.
const firstCharacterShown = standIn((item) => item.text.replace(item.value!, `${/[\p{L}\p{N}]/u.exec(item.value!)?.[0] ?? ""}[REDACTED]`))

describe("the secret value oracle", () => {
  const probe = (text: string, value: string): Case => ({ shape: "probe", text, value, rule: "hide", kept: [] })
  const probes = [
    probe("DB_PASSWORD=7\n", "7"),
    probe("DB_PASSWORD=42\n", "42"),
    probe("export db.token='9'\n", "9"),
    probe("{\"x-secret\": \"false\"}\n", "false"),
    probe("tool --limit-token 3 -s\n", "3"),
    probe("NPM_TOKEN=\"zqx jwvk\" -s\n", "zqx jwvk"),
    probe("tool --npm-token=\"zqx\rjwvk\" -s\n", "zqx\rjwvk"),
    probe("token=$'ж\\'q' -s\n", "ж\\'q"),
    probe("TOKEN=$(get zqx jwvk) -s\n", "$(get zqx jwvk)"),
    probe("run --token `get zqx` -s\n", "`get zqx`"),
    probe("NPM_TOKEN=<(printf zqx jwvk) -s\n", "<(printf zqx jwvk)"),
    probe("NPM_TOKEN=${VAR:-zqx jwvk} -s\n", "${VAR:-zqx jwvk}"),
    probe("NPM_TOKEN=(zqx jwvk) -s\n", "(zqx jwvk)"),
    probe("TOKEN=zq\"x jw\"vk -s\n", "zq\"x jw\"vk"),
    probe("TOKEN=zq'x jw'vk -s\n", "zq'x jw'vk"),
    probe("TOKEN=zq$'x jw'vk -s\n", "zq$'x jw'vk"),
    probe("set \"TOKEN=zqx\\\"jwvk\"", "zqx\\\"jwvk"),
    probe("set 'TOKEN=zqx\\'jwvk", "zqx\\'jwvk"),
  ]

  it.each(probes)("hides $text and fails a redactor that shows it whole or in part", (item) => {
    expect(failure(item, [[item.text]])).toBeUndefined()
    expect(failure(item, [[item.text]], identity)?.kind).toMatch(/^shows a value/u)
    expect(failure(item, [[item.text]], firstCharacterShown)?.kind).toMatch(/^shows a value/u)
  })

  it("fails a redactor that shows everything on every generated case that must be hidden", () => {
    const missed: string[] = []
    let hidden = 0
    let wide = 0
    let substituted = 0
    for (let index = 0; index < 4_000; index += 1) {
      const next = random(seed + index)
      const item = generate(next)
      if (item.rule !== "hide") continue
      hidden += 1
      if (item.shape.includes("value-wide")) wide += 1
      if (item.shape.includes("value-substitution")) substituted += 1
      if (!failure(item, [[item.text]], identity)) missed.push(`${item.shape}: ${JSON.stringify(item.text.slice(0, 80))}`)
    }
    expect(hidden).toBeGreaterThan(2_000)
    expect(wide).toBeGreaterThan(500)
    expect(substituted).toBeGreaterThan(500)
    expect(missed).toEqual([])
  })

  it("generates every grouping construct in the reader's table, outermost and nested", () => {
    const outermost = new Set<string>()
    const anywhere = new Set<string>()
    const inWord = new Set<string>()
    for (let index = 0; index < 4_000; index += 1) {
      for (const feature of generate(random(seed + index)).shape.split("+")) {
        if (feature.startsWith("outer-")) outermost.add(feature.slice("outer-".length))
        if (feature.startsWith("construct-")) anywhere.add(feature.slice("construct-".length))
        if (feature.startsWith("in-word-")) inWord.add(feature.slice("in-word-".length))
      }
    }
    expect(groupingNames.filter((name) => !anywhere.has(name))).toEqual([])
    expect(valueStartNames.filter((name) => !outermost.has(name))).toEqual([])
    // Every construct that may open after plain characters of a word does,
    // quotes included.
    expect(inWordNames.filter((name) => !inWord.has(name))).toEqual([])
  })
})
