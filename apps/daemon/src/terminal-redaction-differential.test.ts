import { writeFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { DurableOutputRedactor, redactDurableCommand, redactDurableOutput, redactDurableText, TerminalOutputRedactor } from "./secret-redaction.js"
import {
  DurableOutputRedactor as MainDurableOutputRedactor,
  redactDurableCommand as mainRedactDurableCommand,
  redactDurableOutput as mainRedactDurableOutput,
  redactDurableText as mainRedactDurableText,
  TerminalOutputRedactor as MainTerminalOutputRedactor,
} from "./secret-redaction-baseline.js"
import * as latest from "./secret-redaction-main-stage.js"

// Differential fuzz: the terminal redactor against main's own code
// (8bda137f). Inputs are generated from secret and plain forms with random
// formatting, carriage returns, whitespace runs, quotes, escapes and long
// values, cut into random reads with idle beats between some. For every value
// main hides, the new redactor shows none of its letters or digits, counted
// as in secret-redaction-prefixed-differential.test.ts: a character shows when
// it occurs more often in the output than in the text around the value. For
// every plain line main shows exactly, the new redactor shows it exactly, or
// exactly as the durable redactors show the whole text (a name: whose value is
// on the next line, which the command output stream now reads together). A
// sensitive name at the end of an identifier (identifier-suffix) follows the
// prefixed-name rule of #539 instead, which hides its value unless the word
// before the name counts and the value is complete. Hiding more than main,
// what follows a value or the lines after an unclosed quote included, is
// allowed (owner rulings in #539). Main's current code
// (secret-redaction-main-stage.ts, the #598 terminal redactor included, an
// idle beat as its release) is an oracle as well: a value it hides must stay
// hidden too, in the terminal, the stream and its peek, and durable output,
// command and text (security review round 7 of #539). Every text up to 120
// characters that holds a value is also split at every point with an idle
// beat between, and read one character at a time. Seeded: a failure names its seed, its shape
// and a minimal list of reads.

type Step = string | "idle"
// kept: text outside the secret that main keeps. Hiding it is allowed (owner
// rulings in #539), so the oracle does not require it.
type Case = { shape: string, text: string, value?: string, kept: readonly string[] }

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
const names = ["API_KEY", "password", "token", "client_secret", "GITHUB_TOKEN", "access-token", "Password"]
const formatting = ["\x1b[0m", "\x1b[1m", "\x1b[32m", "\x1b[2K"]
// Characters a JavaScript pattern treats as line terminators (U+2028, U+2029)
// or that some tools treat as one (U+0085, NEL), though a terminal does not.
const separators = ["\u2028", "\u2029", "\u0085"]

// Forms composed the way main's baseline reads them. Every place a baseline
// pattern allows whitespace (\s, which includes a line break) between a name,
// its separator and its value may hold a line break: around "=" and ":" in
// assignments, JSON and headers, between a flag and its value, before the "="
// of a -D property, between "set" and its name or quote, and between
// Bearer or Basic and the credential. A value may itself begin with another
// name and separator, or a separator alone, nested up to twice.
const lineBreaks = ["\n", "\r\n", "\r"]

function generateComposed(next: () => number, word: (length: number) => string): Case {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
  const chance = (probability: number) => next() < probability
  const classes = new Set<string>()
  const gap = (fallback: string): string => {
    if (chance(0.3)) { classes.add("cross-line"); return pick(lineBreaks) }
    return chance(0.5) ? fallback : fallback === "" ? " " : fallback
  }
  const innerPrefix = (): string => {
    const name = pick(names)
    classes.add("nested")
    return pick([
      `${name}=`, `${name}=${gap("")}`, `--${name}${gap(" ")}`, `--${name}=`, `-D${name}=`, `${name}:${gap(" ")}`,
      `"${name}":`, `Bearer${gap(" ")}`, "=", ":", `/${name}:`,
      // A chain of glued names (round 7 of #539).
      `${pick(["a", "db", "x"])}_${name}=`.repeat(1 + Math.floor(next() * 3)),
    ])
  }
  const secret = word(6 + Math.floor(next() * 6))
  let value = secret
  for (let depth = 0; depth < 2 && chance(0.45); depth += 1) value = `${innerPrefix()}${value}`
  const name = pick(names)
  const form = pick(["flag-space", "flag-equals", "flag-colon", "assignment", "set", "json", "property", "cmd-set", "cmd-set-tail", "bearer", "basic", "header", "prompt"])
  let text: string
  let kept: string[] = []
  switch (form) {
    case "flag-space": text = `curl --${name}${gap(" ") || " "}${value} -s`; kept = [" -s"]; break
    case "flag-equals": text = `curl --${name}${gap("")}=${gap("")}${value} -s`; kept = [" -s"]; break
    case "flag-colon": text = `tool /${name}:${value} -s`; kept = [" -s"]; break
    case "assignment": text = `${name}${gap("")}=${gap("")}${value}`; break
    case "set": text = `set${gap(" ") || " "}${name}=${value}`; break
    case "json": text = `{"${name}"${gap("")}:${gap("")}"${value.replace(/"/g, "")}","safe":"visible"}`; kept = [`"safe":"visible"}`]; break
    case "property": text = `java -D${name}${gap("")}=${value} -jar app.jar`; kept = [" -jar app.jar"]; break
    case "cmd-set": text = `set${gap(" ") || " "}"${name}${gap("")}=${value.replace(/"/g, "")}"`; break
    // A name after the set quote closes, with its own value (round 7 of #539).
    case "cmd-set-tail": text = `set "${name}='${word(3)}'"${pick(names)}:${gap(" ")}${value} & echo -s`; kept = [" & echo -s"]; break
    case "bearer": text = `Authorization:${gap(" ")}Bearer${gap(" ") || " "}${value}`; break
    case "basic": text = `Proxy-Authorization=${gap("")}Basic${gap(" ") || " "}${value}`; break
    case "header": text = `Authorization:${gap(" ")}${value}`; break
    default: text = `${name}:${gap(" ")}${value}`; break
  }
  const ending = pick(["\r\n", "\n", ""])
  return {
    shape: [`composed-${form}`, ...[...classes].sort()].join("+"),
    text: `${text}${ending}`,
    value: secret,
    kept,
  }
}

function generate(next: () => number): Case {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
  const chance = (probability: number) => next() < probability
  const features: string[] = []
  const space = (): string => {
    if (chance(0.06)) { features.push("long-space"); return " ".repeat(8_200 + Math.floor(next() * 300)) }
    if (chance(0.05)) { features.push("space-300"); return " ".repeat(300) }
    return " ".repeat(Math.floor(next() * 3))
  }
  // Formatting, or an OSC string holding a quote, spaces or an assignment.
  const ansi = (): string => chance(0.12)
    ? (features.push("ansi"), pick([...formatting, "\x1b]0;'\x07", "\x1b]0;\"\x07", "\x1b]0;a b; c\x07", "\x1b]0;token=kk\x07"]))
    : ""
  const word = (length: number) => Array.from({ length }, () => pick(valueLetters.split(""))).join("")
  const valueBody = (): string => {
    if (chance(0.06)) { features.push("long-value"); return word(4) + "q".repeat(9_000) + word(8) }
    // A value that ends in or holds a sensitive word, perhaps with a
    // separator and a second value after it (round 7 of #539).
    if (chance(0.12)) {
      features.push("sensitive-word")
      const tail = pick(["token", "_token", "secret", "password", "Passwd", "client_secret"])
      return `${word(4 + Math.floor(next() * 3))}${tail}${pick(["", word(3), `: ${word(5)}`, `= ${word(5)}`])}`
    }
    return word(6 + Math.floor(next() * 8))
  }
  const ending = pick(["\r\n", "\n", "\r\n", ""])
  if (chance(0.3)) return generateComposed(next, word)
  // A sensitive name as the end of an ordinary identifier is not that name:
  // where main shows such a line whole, so must this.
  if (chance(0.12)) {
    const identifier = pick(["total_token", "has_secret", "max_password_length", "session_cookie_count", "last_accesstoken", "retry_credentials", "xpassword"])
    const separator = pick(["=", ": ", " = ", ":"])
    const shown = pick(["5", "false", "12", "none", "true"])
    return { shape: "identifier-suffix", text: `${pick(["", "export ", "set ", "{\""])}${identifier}${separator}${shown}${ending || "\r\n"}`, kept: [] }
  }
  if (chance(0.25)) {
    const plain = pick([
      "passwords are hashed", "Enter password below", "token count 5", "me@host:~$ ls -la",
      "Downloading 10%\rDownloading 20%", "\x1b[32mpasswords are hashed\x1b[0m", "password\nhello world",
      "Password:\nhello world", "the token was rotated", "secret sauce recipe",
    ])
    return { shape: "plain", text: `${plain}${ending || "\r\n"}`, kept: [] }
  }
  const name = pick(names)
  const quote = chance(0.35) ? pick(['"', "'"]) : ""
  let value = valueBody()
  if (quote && chance(0.3)) { features.push("inner-space"); value = `${value} ${word(6)}` }
  // A name and value inside the quoted value, which is still one value.
  if (quote && chance(0.15)) { features.push("embedded-assignment"); value = `${value} ${pick(names)}=${word(6)}` }
  if (quote && chance(0.1)) { features.push("separator"); value = `${word(4)}${pick(separators)}${value}` }
  if (quote && chance(0.1)) { features.push("escaped-separator"); value = `${word(4)}\\${pick(separators)}${value}` }
  if (quote === '"' && chance(0.3)) { features.push("escaped-quote"); value = `${word(4)}\\"${value}` }
  // A backslash inside single quotes escapes the next character, as it does
  // inside double quotes (owner ruling 2026-09-25): an escaped quote is part
  // of the value.
  if (quote === "'" && chance(0.3)) { features.push("escaped-single-quote"); value = `${word(4)}\\'${value}` }
  const closed = !quote || chance(0.85)
  if (quote && !closed) features.push("unclosed")
  // A quote whose closing quote is escaped never closes.
  const escapedClose = quote !== "" && closed && chance(0.08)
  if (escapedClose) features.push("escaped-closing-quote")
  const after = quote && closed && chance(0.2) ? (features.push("after-quote"), word(8)) : ""
  const quoted = escapedClose ? `${quote}${value}\\${quote}` : `${quote}${value}${closed ? quote : ""}${after}`
  const secretText = quote ? value.replace(/\\["']/g, "") + after : value + after
  const newlineBeforeValue = chance(0.08) ? (features.push("newline-before-value"), "\n") : ""
  const redraw = chance(0.06) ? (features.push("redraw"), "\r\x1b[4C") : ""
  const form = pick(["assignment", "export", "json", "json-mixed", "flag-space", "flag-equals", "property", "prompt", "env", "bare-token"])
  let text: string
  let kept: string[] = []
  switch (form) {
    case "assignment": text = `${name}${ansi()}${space()}=${space()}${ansi()}${newlineBeforeValue}${redraw}${quoted}`; break
    case "export": text = `export ${name}${ansi()}=${ansi()}${newlineBeforeValue}${redraw}${quoted}`; break
    case "json": text = `{"${name}":${space()}${newlineBeforeValue}${quote ? quoted : `"${value}"`}}`; break
    case "json-mixed": text = `{"${name}":"${value.replace(/[\\"]/g, "")}","safe":"visible"}`; kept = [`"safe":"visible"}`]; break
    case "flag-space": text = `curl --${name}${space() || " "}${ansi()}${redraw}${quoted} -s`; kept = [" -s"]; break
    case "flag-equals": text = `curl --${name}=${ansi()}${quoted}`; break
    case "property": text = `java -D${name}=${space()}${ansi()}${quoted} -jar app.jar`; kept = [" -jar app.jar"]; break
    case "prompt": text = `${name}:${space() || " "}${ansi()}${newlineBeforeValue}${redraw}${value}`; break
    case "env": text = `$env:${name}=${quote ? quoted : `"${value}"`}`; break
    default: text = `echo ghp_${value} done`; kept = [" done"]; break
  }
  const hidden = form === "bare-token" ? `ghp_${value}` : form === "json-mixed" ? value.replace(/[\\"]/g, "") : form === "json" && !quote ? value : form === "env" && !quote ? value : form === "prompt" ? value : secretText
  // After a quote that never closes, the rest of the line is inside the shell
  // word, so nothing after it on that line counts as kept outside the secret.
  // A line that follows, after a carriage return or a newline, always does.
  const following = chance(0.15) ? (features.push("following-line"), pick(["\rvisible output\r\n", "\nvisible output\n", "\r\nvisible output\r\n"])) : ""
  const sameLine = closed && !escapedClose ? kept : []
  return {
    shape: [form, ...[...new Set(features)].sort()].join("+"),
    text: `${text}${following ? "" : ending}${following}`,
    value: hidden,
    kept: following ? [...sameLine, "visible output"] : sameLine,
  }
}

function cut(text: string, next: () => number): Step[] {
  const cuts = new Set<number>()
  const count = Math.floor(next() * 6)
  for (let index = 0; index < count; index += 1) cuts.add(1 + Math.floor(next() * Math.max(1, text.length - 1)))
  const points = [...cuts].sort((left, right) => left - right)
  const steps: Step[] = []
  let from = 0
  for (const point of points) {
    if (point <= from || point >= text.length) continue
    steps.push(text.slice(from, point))
    if (next() < 0.5) steps.push("idle")
    from = point
  }
  steps.push(text.slice(from))
  if (next() < 0.3) steps.push("idle")
  return steps
}

// The leak shapes of #608, each cut into reads with idle beats between some,
// and judged on their own terms rather than against main: formatting between
// a name and its separator, a carriage return redraw after a name and its
// separator, a bare token longer than the carry, and a bare token an idle beat
// cuts. A single-quoted value may hold an escaped quote (owner ruling
// 2026-09-25). The secret is never the token's prefix, which stays visible.
const tokenPrefixes = ["sk-", "ghp_", "gho_", "github_pat_", "xoxb-"]

// OSC strings, which a terminal does not print: a window title or a link.
// They may carry an assignment of their own (other: its secret), a quote, or
// spaces and a semicolon, none of which is part of the line as it reads.
function oscString(next: () => number, other: string): string {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
  return pick([
    `\x1b]0;${pick(names)}=${other}\x07`,
    `\x1b]2;${pick(names)}: ${other}\x1b\\`,
    "\x1b]0;'\x07",
    "\x1b]0;\"\x07",
    "\x1b]0;a b; c\x07",
    "\x1b]8;;https://example.test/p\x1b\\",
  ])
}

function generateLeak(next: () => number): { item: Case, others: string[], steps: Step[] } {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
  const word = (length: number) => Array.from({ length }, () => pick(valueLetters.split(""))).join("")
  const secret = word(8 + Math.floor(next() * 6))
  const name = pick(names)
  const ending = pick(["\r\n", "\n", ""])
  const shape = pick(["ansi-name", "redraw", "long-token", "beat-token", "osc"])
  const others: string[] = []
  let text: string
  switch (shape) {
    case "osc": {
      // OSC strings inside the name, between it and its separator, between
      // the separator and the value, and inside an oversized quoted value.
      const osc = (chance: number): string => {
        if (next() >= chance) return ""
        const other = word(8)
        const string = oscString(next, other)
        if (string.includes(other)) others.push(other)
        return string
      }
      const cutAt = 1 + Math.floor(next() * (name.length - 1))
      const nameText = `${name.slice(0, cutAt)}${osc(0.5)}${name.slice(cutAt)}`
      const long = "q".repeat(260 + Math.floor(next() * 60))
      const value = pick([secret, `'${secret}'`, `"${secret}"`, `'${long}${osc(0.8)} ${secret} rest'`, `"${long}${osc(0.8)} ${secret} rest"`])
      text = `${pick(["export ", ""])}${nameText}${osc(0.5)}${pick(["=", ": "])}${osc(0.5)}${value} done${ending}`
      break
    }
    case "ansi-name": {
      // An escaped single quote does not close the value, so the secret after
      // it is still inside it.
      const quoted = pick([secret, `"${secret}"`, `'${secret}'`, `'${word(3)}\\'${secret}'`, `'${word(3)}\\'${secret} rest'`])
      text = `${pick(["export ", ""])}${name}${pick(formatting)}${pick(["=", " = "])}${quoted} done${ending}`
      break
    }
    case "redraw":
      text = `${pick([`export ${name}=`, `${name}=`, `${name}: `, `${name}:`])}\r${pick(["", "\x1b[8C", "\x1b[12C", "\x1b[2K"])}${secret}${ending}`
      break
    case "long-token":
      text = `echo ${pick(tokenPrefixes)}${"a".repeat(260 + Math.floor(next() * 300))}${secret}${pick(["", "a".repeat(40)])} done${ending}`
      break
    default: {
      text = `echo ${pick(tokenPrefixes)}${secret} done${ending}`
      // The first beat falls inside the token, at or before the secret; the
      // rest is cut at random.
      const beat = "echo ".length + 1 + Math.floor(next() * (text.indexOf(secret) - "echo ".length))
      return {
        item: { shape, text, value: secret, kept: [] },
        others,
        steps: [text.slice(0, beat), "idle", ...cut(text.slice(beat), next)],
      }
    }
  }
  return { item: { shape, text, value: secret, kept: [] }, others, steps: cut(text, next) }
}

// Every three consecutive characters of a secret.
function fragments(value: string): string[] {
  return Array.from({ length: Math.max(1, value.length - 2) }, (_, index) => value.slice(index, index + 3))
}

function runMain(steps: readonly Step[]): string {
  const redactor = new MainTerminalOutputRedactor()
  return steps.map((step) => step === "idle" ? redactor.flush() : redactor.push(step)).join("") + redactor.flush()
}

function runNew(steps: readonly Step[]): string {
  const redactor = new TerminalOutputRedactor()
  return steps.map((step) => step === "idle" ? redactor.release() : redactor.push(step)).join("") + redactor.flush()
}

function runLatest(steps: readonly Step[]): string {
  const redactor = new latest.TerminalOutputRedactor()
  return steps.map((step) => step === "idle" ? redactor.release() : redactor.push(step)).join("") + redactor.flush()
}

type Stream = { push: (chunk: string) => string, peek: () => string }

// What a stream has emitted and what its peek shows of the rest.
function peeked(redactor: Stream, steps: readonly Step[]): string {
  return steps.map((step) => step === "idle" ? "" : redactor.push(step)).join("") + redactor.peek()
}

// The letters and digits of a value, each counted in the text around the
// value: how often it occurs in the text less how often in the value. The
// value is counted rather than cut out, since a hidden value may leave out
// escapes the text holds.
const markers = ["[REDACTED]", "[Long command output line omitted]", "…"]

function occurrences(text: string, piece: string): number {
  return text.split(piece).length - 1
}


// How often each piece occurs in a text once the redactors' markers are taken
// out, counted in one pass rather than a split per piece.
function countPieces(text: string, pieces: readonly string[]): Map<string, number> {
  const counts = new Map(pieces.map((piece) => [piece, 0]))
  for (const character of text) {
    const count = counts.get(character)
    if (count !== undefined) counts.set(character, count + 1)
  }
  for (const marker of markers) {
    let found = 0
    for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + marker.length)) found += 1
    if (found === 0) continue
    for (const character of marker) {
      const count = counts.get(character)
      if (count !== undefined) counts.set(character, count - found)
    }
  }
  return counts
}

// A letter or digit of the value the output shows, if any. A case is judged
// many times in a row, so the counts around its value are worked out once.
let lastAround: { item: Case, pieces: string[], around: Map<string, number> } | undefined

function exposed(item: Case, output: string): string | undefined {
  if (lastAround?.item !== item) {
    const value = item.value!
    const pieces = [...new Set(value.match(/[\p{L}\p{N}]/gu) ?? [])]
    lastAround = { item, pieces, around: new Map(pieces.map((piece) => [piece, occurrences(item.text, piece) - occurrences(value, piece)])) }
  }
  const { pieces, around } = lastAround
  const shown = countPieces(output, pieces)
  return pieces.find((piece) => shown.get(piece)! > around.get(piece)!)
}

function runMainDurable(steps: readonly Step[]): string {
  const redactor = new MainDurableOutputRedactor()
  return steps.map((step) => step === "idle" ? "" : redactor.push(step)).join("") + redactor.flush()
}

function runNewDurable(steps: readonly Step[]): string {
  const redactor = new DurableOutputRedactor()
  return steps.map((step) => step === "idle" ? "" : redactor.push(step)).join("") + redactor.flush()
}

// Each redactor this change touches, beside main's own version of it at
// 8bda137f (main) and its current version (latest).
type Pair = {
  name: string
  main: (item: Case, steps: readonly Step[]) => string
  latest: (item: Case, steps: readonly Step[]) => string
  current: (item: Case, steps: readonly Step[]) => string
}
const pairs: readonly Pair[] = [
  { name: "terminal", main: (_item, steps) => runMain(steps), latest: (_item, steps) => runLatest(steps), current: (_item, steps) => runNew(steps) },
  {
    name: "durable output stream", main: (_item, steps) => runMainDurable(steps),
    latest: (_item, steps) => stream(new latest.DurableOutputRedactor(), steps), current: (_item, steps) => runNewDurable(steps),
  },
  // Main's code at 8bda137f had no peek; its current code is the reference.
  {
    name: "durable output peek", main: (_item, steps) => peeked(new latest.DurableOutputRedactor(), steps),
    latest: (_item, steps) => peeked(new latest.DurableOutputRedactor(), steps), current: (_item, steps) => peeked(new DurableOutputRedactor(), steps),
  },
  {
    name: "durable output", main: (item) => mainRedactDurableOutput(item.text).value,
    latest: (item) => latest.redactDurableOutput(item.text).value, current: (item) => redactDurableOutput(item.text).value,
  },
  {
    name: "durable command", main: (item) => mainRedactDurableCommand(item.text).value,
    latest: (item) => latest.redactDurableCommand(item.text).value, current: (item) => redactDurableCommand(item.text).value,
  },
  {
    name: "durable text", main: (item) => mainRedactDurableText(item.text).value,
    latest: (item) => latest.redactDurableText(item.text).value, current: (item) => redactDurableText(item.text).value,
  },
]
const terminalPair = pairs.filter((pair) => pair.name === "terminal")
const streamingPairs = pairs.filter((pair) => pair.name === "terminal" || pair.name.startsWith("durable output stream") || pair.name === "durable output peek")

function stream(redactor: { push: (chunk: string) => string, flush: () => string }, steps: readonly Step[]): string {
  return steps.map((step) => step === "idle" ? "" : redactor.push(step)).join("") + redactor.flush()
}

// knownMain: main's output for the only pair, when the caller has it already.
function failure(item: Case, steps: readonly Step[], under: readonly Pair[] = pairs, knownMain?: string): string | undefined {
  for (const pair of under) {
    const current = pair.current(item, steps)
    if (item.value === undefined) {
      const main = knownMain ?? pair.main(item, steps)
      const prefixedName = item.shape === "identifier-suffix"
      if (!prefixedName && main === item.text && current !== item.text && current !== redactDurableOutput(item.text).value) {
        return `${pair.name}: plain line changed: ${JSON.stringify(current.slice(0, 160))}`
      }
      continue
    }
    const shown = exposed(item, current)
    if (shown === undefined) continue
    if (exposed(item, knownMain ?? pair.main(item, steps)) === undefined) return `${pair.name}: main hides the value, this shows ${JSON.stringify(shown)}`
    if (exposed(item, pair.latest(item, steps)) === undefined) return `${pair.name}: current main hides the value, this shows ${JSON.stringify(shown)}`
  }
  return undefined
}

// The check of the check: a redactor that shows everything fails wherever
// main hides a value. It stands in for the durable output redactor only,
// whole text, so each case costs one of main's redactions: the oracle is the
// same for every pair.
const identity: readonly Pair[] = pairs
  .filter((pair) => pair.name === "durable output")
  .map((pair) => ({ ...pair, current: (item: Case) => item.text }))

function shrink(item: Case, steps: readonly Step[]): Step[] {
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
        if (failure(item, candidate)) { best = candidate; improved = true; break }
      }
    }
  }
  return best
}

const everySplitLength = 120
const cases = Number(process.env.TERMINAL_REDACTION_FUZZ_CASES ?? 4_000)
const seed = Number(process.env.TERMINAL_REDACTION_FUZZ_SEED ?? 20_260_923)
if (!Number.isSafeInteger(cases) || cases < 1 || !Number.isSafeInteger(seed)) {
  throw new Error("TERMINAL_REDACTION_FUZZ_CASES and TERMINAL_REDACTION_FUZZ_SEED must be integers")
}
const leakCases = Number(process.env.TERMINAL_REDACTION_LEAK_CASES ?? 2_000)
if (!Number.isSafeInteger(leakCases) || leakCases < 1) throw new Error("TERMINAL_REDACTION_LEAK_CASES must be an integer")

describe("terminal redaction against main", () => {
  it(`hides at least what main hid and keeps what main kept, ${cases} cases from seed ${seed}`, () => {
    const failures = new Map<string, string>()
    for (let index = 0; index < cases; index += 1) {
      const caseSeed = seed + index
      const next = random(caseSeed)
      const item = generate(next)
      const steps = cut(item.text, next)
      let found = failure(item, steps) === undefined ? undefined : steps
      // A short text with a value is also split at every point with an idle
      // beat between, in the terminal, and read one character at a time in
      // the redactors that take reads.
      if (found === undefined && item.value !== undefined && item.text.length <= everySplitLength) {
        for (let at = 1; at < item.text.length && found === undefined; at += 1) {
          const split: Step[] = [item.text.slice(0, at), "idle", item.text.slice(at)]
          if (failure(item, split, terminalPair) !== undefined) found = split
        }
        const typed = [...item.text]
        if (found === undefined && failure(item, typed, streamingPairs) !== undefined) found = typed
      }
      if (found === undefined) continue
      const problem = failure(item, found)!
      if (failures.has(`${item.shape} (${problem.slice(0, problem.indexOf(":"))})`)) continue
      const minimal = shrink(item, found)
      failures.set(`${item.shape} (${problem.slice(0, problem.indexOf(":"))})`, `seed ${caseSeed}: ${problem}\n  reads ${JSON.stringify(minimal.map((step) => step !== "idle" && step.length > 60 ? `${step.slice(0, 40)}…(${step.length})` : step))}`)
    }
    const report = [...failures].map(([shape, detail]) => `${shape}\n  ${detail}`)
    if (process.env.TERMINAL_REDACTION_FUZZ_REPORT) writeFileSync(process.env.TERMINAL_REDACTION_FUZZ_REPORT, report.join("\n"))
    expect(report).toEqual([])
  }, 10_000 + cases * 2)

  it(`hides the leak shapes of #608 on their own terms, ${leakCases} cases from seed ${seed}`, () => {
    const failures = new Map<string, string>()
    for (let index = 0; index < leakCases; index += 1) {
      const caseSeed = seed + index
      const { item, others, steps } = generateLeak(random(caseSeed))
      // The check has teeth: the text itself shows the secret.
      expect(exposed(item, item.text), item.shape).toBeDefined()
      const output = runNew(steps)
      // A secret an OSC string carries stays hidden too.
      const shown = fragments(item.value!).find((piece) => output.includes(piece)) ?? exposed(item, output)
        ?? others.flatMap(fragments).find((piece) => output.includes(piece))
      if (shown === undefined || failures.has(item.shape)) continue
      failures.set(item.shape, `seed ${caseSeed}: shows ${JSON.stringify(shown)}\n  reads ${JSON.stringify(steps.map((step) => step !== "idle" && step.length > 60 ? `${step.slice(0, 40)}…(${step.length})` : step))}`)
    }
    expect([...failures].map(([shape, detail]) => `${shape}\n  ${detail}`)).toEqual([])
  })

  it("fails a redactor that shows everything wherever main hides a value", () => {
    let hidden = 0
    const missed: string[] = []
    for (let index = 0; index < 4_000; index += 1) {
      const next = random(seed + index)
      const item = generate(next)
      if (item.value === undefined) continue
      const main = mainRedactDurableOutput(item.text).value
      if (exposed(item, main) !== undefined) continue
      hidden += 1
      if (failure(item, [item.text], identity, main) === undefined) missed.push(`${item.shape}: ${JSON.stringify(item.text.slice(0, 80))}`)
    }
    expect(hidden).toBeGreaterThan(1_000)
    expect(missed).toEqual([])
  })
})
