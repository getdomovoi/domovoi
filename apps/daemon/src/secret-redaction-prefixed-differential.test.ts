import { writeFileSync } from "node:fs"
import { performance } from "node:perf_hooks"

import { describe, expect, it } from "vitest"

import { DurableOutputRedactor, redactDurableCommand, redactDurableOutput, TerminalOutputRedactor } from "./secret-redaction.js"
import {
  DurableOutputRedactor as MainDurableOutputRedactor,
  redactDurableCommand as mainRedactDurableCommand,
  redactDurableOutput as mainRedactDurableOutput,
  TerminalOutputRedactor as MainTerminalOutputRedactor,
} from "./secret-redaction-baseline.js"

// Differential fuzz for prefixed secret names, against main's own code
// (secret-redaction-baseline.ts, pinned by its own test). Inputs are secret
// forms whose name carries a prefix (X_API_KEY=, --x-token, -Dx.password=,
// /x-token:, $env:, set "…", JSON), plain lines, long runs around the
// terminal's 256-character carry, cut into random reads with idle beats
// between some. The checks:
// - a value main hides stays hidden, except a value the ruling shows;
// - a prefixed name's value is never shown, unless the word right before the
//   sensitive name counts (total, has, max, min, count, is, enable) and the
//   value is a complete plain number or true/false (ruled 2026-09-24);
// - such a counting value that is not complete (an unclosed quote, a value
//   that goes on past the number) is never shown;
// - a plain line main shows exactly is shown exactly, and so is a complete
//   counting value;
// - no redaction takes longer than a second.
// A value counts as shown when any of its letters or digits occurs more often
// in the output than in the text around it, so a one-digit value and a value
// shown in part are both caught.
// An idle beat makes the terminal emit everything it holds (server.ts calls
// flush on an idle timer), which shows any value typed after its name on
// main as well; that is the idle-release fix in #575. Across an idle beat, and
// for a name longer than the 256 characters the terminal carries, the
// terminal is held only to hiding what main hides. Seeded: a failure names its
// seed, its shape and a minimal list of reads.

type Step = string | "idle"
// hide: the value must never show. show: the text must come out unchanged.
// main: the value must be hidden wherever main hides it. plain: no secret.
type Rule = "hide" | "show" | "main" | "plain"
// longName: a name longer than the terminal carries, which the terminal is
// held to main on.
type Case = { shape: string, text: string, value?: string, rule: Rule, kept: readonly string[], longName?: boolean }

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

  // The value: a secret word, a plain number or true/false, a number that
  // goes on, or a long run around the carry.
  const kind = pick(["word", "word", "number", "number", "decimal", "boolean", "number-then-word", "carry", "long"])
  let value: string
  switch (kind) {
    case "number": value = chance(0.5) ? digits(3 + Math.floor(next() * 4)) : String(1 + Math.floor(next() * 9)); break
    case "decimal": value = `${digits(3)}.${digits(3)}`; break
    case "boolean": value = pick(["true", "false", "TRUE", "False"]); break
    case "number-then-word": value = `${digits(1 + Math.floor(next() * 3))}${word(3 + Math.floor(next() * 3))}`; break
    case "carry": value = word(240 + Math.floor(next() * 32)); break
    case "long": value = word(9_000 + Math.floor(next() * 400)); break
    default: value = word(6 + Math.floor(next() * 7)); break
  }
  features.push(`value-${kind}`)
  const plain = /^(?:\d+(?:\.\d+)?|true|false)$/iu.test(value)

  const quoteChoice = chance(0.3) ? pick(['"', "'"]) : ""
  const closed = !quoteChoice || chance(0.8)
  if (quoteChoice && !closed) features.push("unclosed-quote")
  const quoted = `${quoteChoice}${value}${closed ? quoteChoice : ""}`
  const space = () => chance(0.2) ? " " : ""
  const before = chance(0.05) ? (features.push("filler-near-carry"), `${pick([" ", "a"]).repeat(236 + Math.floor(next() * 40))} `) : ""

  const form = pick([
    "assignment", "export", "env", "set", "cmd-set", "json", "json-mixed", "structured",
    "flag-space", "flag-equals", "single-dash-space", "single-dash-equals", "slash-colon", "property",
  ])
  let text: string
  let kept: string[] = []
  // Whether the value, as written, is complete: its quote closed and a
  // delimiter or the end of the text right after it.
  let complete = closed
  switch (form) {
    case "assignment": text = `${name}${space()}=${space()}${quoted}`; break
    case "export": text = `export ${name}=${quoted}`; break
    case "env": text = `$env:${name}=${quoted}`; break
    case "set": text = `set ${name}=${quoted}`; break
    case "cmd-set": {
      const cmdClosed = chance(0.7)
      complete = cmdClosed
      if (!cmdClosed) features.push("unclosed-set")
      text = `set "${name}=${value}${cmdClosed ? '"' : ""}`
      break
    }
    case "json": text = `{"${name}":${space()}${quoteChoice === "'" ? quoted.replace(/'/gu, '"') : quoted}}`; break
    case "json-mixed": text = `{"${name}":"${value}","safe":"visible"}`; kept = [`"safe":"visible"}`]; complete = true; break
    case "structured": text = `${name}:${space() || " "}${quoted}`; break
    case "flag-space": text = `curl --${name} ${quoted} -s`; kept = [" -s"]; break
    case "flag-equals": text = `curl --${name}=${quoted} -s`; kept = [" -s"]; break
    case "single-dash-space": text = `tool -${name} ${quoted} -s`; kept = [" -s"]; break
    case "single-dash-equals": text = `tool -${name}=${quoted} -s`; kept = [" -s"]; break
    case "slash-colon": text = `tool /${name}:${quoted} -s`; kept = [" -s"]; break
    default: text = `java -D${name}=${quoted} -jar app.jar`; kept = [" -jar app.jar"]; break
  }
  const following = chance(0.15) ? (features.push("following-line"), pick(["\nvisible output\n", "\r\nvisible output\r\n"])) : ""
  const ending = following ? "" : pick(["\r\n", "\n", ""])
  // After a quote that never closes, the rest of the line is inside the value.
  if (!complete) kept = []
  if (following) kept = [...kept, "visible output"]

  let rule: Rule
  if (!prefixed) rule = "main"
  else if (counting && plain && complete) rule = "show"
  else rule = "hide"
  return {
    shape: [`prefixed-${form}`, ...[...new Set(features)].sort()].join("+"),
    text: `${before}${text}${ending}${following}`,
    value,
    rule,
    kept,
    longName: name.length > 200,
  }
}

function generatePlain(next: () => number): Case {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
  const line = pick([
    "passwords are hashed", "Enter password below", "token count 5", "me@host:~$ ls -la", "TOKEN_BUDGET=100",
    "token_count=5", "api_key_rotation: weekly", "mysql --skip-password db", "tool --no-token build",
    "run --without-secret now", "--password-file ./pw.txt", "the token was rotated", "secret sauce recipe",
    "x-token-count: 12", "Downloading 10%\rDownloading 20%",
  ])
  return { shape: "plain", text: `${line}${pick(["\r\n", "\n"])}`, rule: "plain", kept: [] }
}

function generate(next: () => number): Case {
  return next() < 0.15 ? generatePlain(next) : generatePrefixed(next)
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
    if (next() < 0.3) steps.push("idle")
    from = point
  }
  steps.push(text.slice(from))
  if (next() < 0.3) steps.push("idle")
  return steps
}

// What a value shows is measured by counting: none of its letters or digits
// may occur more often in the output than in the text around the value, once
// the redactors' own markers are taken out. A value of any length is checked,
// and a value shown in part counts as shown.
function fragments(value: string): string[] {
  return [...new Set(value.match(/[A-Za-z0-9]/gu) ?? [])]
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
  // Whether an idle beat in the reads reaches this redactor.
  idleMatters: boolean
  main: (item: Case, steps: readonly Step[]) => string
  current: (item: Case, steps: readonly Step[]) => string
}

const pairs: readonly Pair[] = [
  {
    name: "terminal",
    idleMatters: true,
    main: (_item, steps) => {
      const redactor = new MainTerminalOutputRedactor()
      return steps.map((step) => step === "idle" ? redactor.flush() : redactor.push(step)).join("") + redactor.flush()
    },
    current: (_item, steps) => {
      const redactor = new TerminalOutputRedactor()
      return steps.map((step) => step === "idle" ? redactor.flush() : redactor.push(step)).join("") + redactor.flush()
    },
  },
  {
    name: "durable output stream",
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
  { name: "durable output", idleMatters: false, main: (item) => mainRedactDurableOutput(item.text).value, current: (item) => redactDurableOutput(item.text).value },
  { name: "durable command", idleMatters: false, main: (item) => mainRedactDurableCommand(item.text).value, current: (item) => redactDurableCommand(item.text).value },
]

// A durable command is cut at 8,192 characters, so a text longer than that is
// not held to showing anything whole.
function withinBound(pair: Pair, item: Case): boolean {
  return pair.name !== "durable command" || item.text.length <= 8_192
}

const slowMilliseconds = 1_000

type Failure = { pair: string, kind: string, detail: string }

function failure(item: Case, steps: readonly Step[], under: readonly Pair[] = pairs): Failure | undefined {
  const idle = steps.includes("idle")
  const fail = (pair: Pair, kind: string, detail: string): Failure => ({ pair: pair.name, kind, detail })
  for (const pair of under) {
    const started = performance.now()
    const main = pair.main(item, steps)
    const current = pair.current(item, steps)
    const elapsed = performance.now() - started
    if (elapsed > slowMilliseconds) return fail(pair, "slow", `${Math.round(elapsed)} ms`)
    if (!withinBound(pair, item)) continue
    const absolute = !(pair.idleMatters && (idle || item.longName))
    if (item.rule === "plain") {
      if (absolute && main === item.text && current !== item.text) return fail(pair, "plain line changed", JSON.stringify(current.slice(0, 160)))
      continue
    }
    if (item.rule === "show") {
      if (absolute && current !== item.text) return fail(pair, "complete counting value not shown", JSON.stringify(current.slice(0, 160)))
      continue
    }
    const lost = item.kept.find((part) => main.includes(part) && !current.includes(part))
    if (lost !== undefined) return fail(pair, "loses what main keeps", `${JSON.stringify(lost)}: ${JSON.stringify(current.slice(-160))}`)
    const shown = exposed(item, current)
    if (shown === undefined) continue
    if (exposed(item, main) === undefined) return fail(pair, "shows a value main hides", JSON.stringify(shown))
    if (item.rule === "hide" && absolute) return fail(pair, "shows a prefixed value", JSON.stringify(shown))
  }
  return undefined
}

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

const cases = Number(process.env.PREFIXED_REDACTION_FUZZ_CASES ?? 4_000)
const seed = Number(process.env.PREFIXED_REDACTION_FUZZ_SEED ?? 20_260_924)
if (!Number.isSafeInteger(cases) || cases < 1 || !Number.isSafeInteger(seed)) {
  throw new Error("PREFIXED_REDACTION_FUZZ_CASES and PREFIXED_REDACTION_FUZZ_SEED must be integers")
}

describe("prefixed secret names against main", () => {
  it(`hides prefixed values, shows only complete counting values, and hides what main hid, ${cases} cases from seed ${seed}`, () => {
    const failures = new Map<string, string>()
    for (let index = 0; index < cases; index += 1) {
      const caseSeed = seed + index
      const next = random(caseSeed)
      const item = generate(next)
      const steps = cut(item.text, next)
      const problem = failure(item, steps)
      if (!problem) continue
      const key = `${item.shape} (${problem.pair}: ${problem.kind})`
      if (failures.has(key)) continue
      const minimal = shrink(item, steps)
      failures.set(key, `seed ${caseSeed}: ${problem.kind}: ${problem.detail}\n  reads ${JSON.stringify(minimal.map((step) => step !== "idle" && step.length > 60 ? `${step.slice(0, 40)}…(${step.length})` : step))}`)
    }
    const report = [...failures].map(([shape, detail]) => `${shape}\n  ${detail}`)
    if (process.env.PREFIXED_REDACTION_FUZZ_REPORT) writeFileSync(process.env.PREFIXED_REDACTION_FUZZ_REPORT, report.join("\n"))
    expect(report).toEqual([])
  }, 10_000 + cases * 3)
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
    { shape: "escaped-quote-assignment", text: `token="${escaped}" -s\n`, value: escaped, rule: "main", kept: [" -s"] },
    { shape: "escaped-quote-prefixed", text: `export X_TOKEN="${escaped}" -s\n`, value: escaped, rule: "hide", kept: [" -s"] },
    { shape: "escaped-quote-json", text: `{"x-token": "${escaped}", "safe": "visible"}\n`, value: escaped, rule: "hide", kept: ["\"safe\": \"visible\"}"] },
    { shape: "escaped-quote-json-tight", text: `{"x-token":"${escaped}","safe":"visible"}\n`, value: escaped, rule: "hide", kept: ["\"safe\":\"visible\"}"] },
    { shape: "escaped-single-quote", text: `x.secret='${escapedSingle}' -s\n`, value: escapedSingle, rule: "hide", kept: [" -s"] },
    { shape: "escaped-flag-space", text: `run --x-token "zqxj\\"mkqz" -s\n`, value: "zqxj\\\"mkqz", rule: "hide", kept: [" -s"] },
    { shape: "escaped-flag-equals-single", text: `run --x-token='zqxj\\'mkqz' -s\n`, value: "zqxj\\'mkqz", rule: "hide", kept: [" -s"] },
    { shape: "escaped-one-dash-flag", text: `tool -db-password "zqxj\\\\\\"mkqz" -s\n`, value: "zqxj\\\\\\\"mkqz", rule: "hide", kept: [" -s"] },
    { shape: "escaped-property", text: `java -Dx.password="zqxj\\"mkqz" -jar app.jar\n`, value: "zqxj\\\"mkqz", rule: "hide", kept: [" -jar app.jar"] },
    { shape: "escaped-flag-long", text: `run --x-token "${escaped}" -s\n`, value: escaped, rule: "hide", kept: [" -s"] },
    { shape: "escaped-backslash", text: `token="${long}\\\\" -s mkqz\n`, value: `${long}\\\\`, rule: "main", kept: [" -s mkqz"] },
    ...[250, 252, 253, 254, 255, 256, 258].flatMap((length): Case[] => [
      { shape: `long-key-${length}-json-spaced`, text: `{"${keyOf(length)}": "zqx jwvk", "safe": "visible"}\n`, value: "zqx jwvk", rule: "hide", kept: ["\"safe\": \"visible\"}"], longName: true },
      { shape: `long-key-${length}-json-tight`, text: `{"${keyOf(length)}":"zqxjwvkm","safe":"visible"}\n`, value: "zqxjwvkm", rule: "hide", kept: ["\"safe\":\"visible\"}"], longName: true },
    ]),
    { shape: "long-key-json-single", text: `{"${keyOf(254)}": 'zqx jwvk', "safe": "visible"}\n`, value: "zqx jwvk", rule: "hide", kept: ["\"safe\": \"visible\"}"], longName: true },
    { shape: "long-key-assignment", text: `${keyOf(254)}="zqx jwvk" -s\n`, value: "zqx jwvk", rule: "hide", kept: [" -s"], longName: true },
    { shape: "long-key-long-value", text: `{"${keyOf(254)}": "${long} mkqz", "safe": "visible"}\n`, value: `${long} mkqz`, rule: "hide", kept: ["\"safe\": \"visible\"}"], longName: true },
  ]

  it.each(splitCases)("$shape", (item) => {
    const failed: string[] = []
    for (let at = 1; at < item.text.length; at += 1) {
      const steps = [item.text.slice(0, at), item.text.slice(at)]
      const problem = failure(item, steps)
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
const firstCharacterShown = standIn((item) => item.text.replace(item.value!, `${item.value!.slice(0, 1)}[REDACTED]`))

describe("the prefixed differential oracle", () => {
  const probe = (text: string, value: string): Case => ({ shape: "probe", text, value, rule: "hide", kept: [] })
  const probes = [
    probe("DB_PASSWORD=7\n", "7"),
    probe("DB_PASSWORD=42\n", "42"),
    probe("export db.token='9'\n", "9"),
    probe("{\"x-secret\": \"false\"}\n", "false"),
    probe("tool --limit-token 3 -s\n", "3"),
  ]

  it.each(probes)("hides $text and fails a redactor that shows it whole or in part", (item) => {
    expect(failure(item, [item.text])).toBeUndefined()
    expect(failure(item, [item.text], identity)?.kind).toMatch(/^shows a (?:prefixed value|value main hides)$/u)
    expect(failure(item, [item.text], firstCharacterShown)?.kind).toMatch(/^shows a (?:prefixed value|value main hides)$/u)
  })

  it("fails a redactor that shows everything on every generated case that must be hidden", () => {
    const missed: string[] = []
    let hidden = 0
    for (let index = 0; index < 4_000; index += 1) {
      const next = random(seed + index)
      const item = generate(next)
      if (item.rule !== "hide") continue
      hidden += 1
      const steps = cut(item.text, next)
      if (!failure(item, steps, identity)) missed.push(`${item.shape}: ${JSON.stringify(item.text.slice(0, 80))}`)
    }
    expect(hidden).toBeGreaterThan(1_000)
    expect(missed).toEqual([])
  }, 10_000 + 4_000 * 3)
})
