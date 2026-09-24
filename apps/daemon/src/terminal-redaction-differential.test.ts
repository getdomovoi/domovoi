import { writeFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { DurableOutputRedactor, redactDurableCommand, redactDurableOutput, TerminalOutputRedactor } from "./secret-redaction.js"
import {
  DurableOutputRedactor as MainDurableOutputRedactor,
  redactDurableCommand as mainRedactDurableCommand,
  redactDurableOutput as mainRedactDurableOutput,
  TerminalOutputRedactor as MainTerminalOutputRedactor,
} from "./secret-redaction-baseline.js"

// Differential fuzz: the terminal redactor against main's own code
// (8bda137f). Inputs are generated from secret and plain forms with random
// formatting, carriage returns, whitespace runs, quotes, escapes and long
// values, cut into random reads with idle beats between some. For every value
// main hides, the new redactor shows no three-character run of it; for every
// plain line main shows exactly, the new redactor shows it exactly. Seeded: a
// failure names its seed, its shape and a minimal list of reads.

type Step = string | "idle"
// kept: text outside the secret that must survive wherever main keeps it.
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

function generate(next: () => number): Case {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
  const chance = (probability: number) => next() < probability
  const features: string[] = []
  const space = (): string => {
    if (chance(0.06)) { features.push("long-space"); return " ".repeat(8_200 + Math.floor(next() * 300)) }
    if (chance(0.05)) { features.push("space-300"); return " ".repeat(300) }
    return " ".repeat(Math.floor(next() * 3))
  }
  const ansi = (): string => chance(0.12) ? (features.push("ansi"), pick(formatting)) : ""
  const word = (length: number) => Array.from({ length }, () => pick(valueLetters.split(""))).join("")
  const valueBody = (): string => {
    if (chance(0.06)) { features.push("long-value"); return word(4) + "q".repeat(9_000) + word(8) }
    return word(6 + Math.floor(next() * 8))
  }
  const ending = pick(["\r\n", "\n", "\r\n", ""])
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
  // In shell single quotes a backslash is literal and cannot escape the quote.
  if (quote === "'" && chance(0.3)) { features.push("single-quote-backslash"); value = `${value}\\` }
  const closed = !quote || chance(0.85)
  if (quote && !closed) features.push("unclosed")
  // A double quote whose closing quote is escaped never closes.
  const escapedClose = quote === '"' && closed && chance(0.08)
  if (escapedClose) features.push("escaped-closing-quote")
  const after = quote && closed && chance(0.2) ? (features.push("after-quote"), word(8)) : ""
  const quoted = escapedClose ? `"${value}\\"` : `${quote}${value}${closed ? quote : ""}${after}`
  const secretText = quote ? value.replace(/\\"/g, "") + after : value + after
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

function runMain(steps: readonly Step[]): string {
  const redactor = new MainTerminalOutputRedactor()
  return steps.map((step) => step === "idle" ? redactor.flush() : redactor.push(step)).join("") + redactor.flush()
}

function runNew(steps: readonly Step[]): string {
  const redactor = new TerminalOutputRedactor()
  return steps.map((step) => step === "idle" ? redactor.release() : redactor.push(step)).join("") + redactor.flush()
}

function fragments(value: string): string[] {
  const runs = value.match(new RegExp(`[${valueLetters}]{3,}`, "g")) ?? []
  const all = new Set<string>()
  for (const run of runs) for (let index = 0; index + 3 <= run.length; index += 1) all.add(run.slice(index, index + 3))
  return [...all]
}

function runMainDurable(steps: readonly Step[]): string {
  const redactor = new MainDurableOutputRedactor()
  return steps.map((step) => step === "idle" ? "" : redactor.push(step)).join("") + redactor.flush()
}

function runNewDurable(steps: readonly Step[]): string {
  const redactor = new DurableOutputRedactor()
  return steps.map((step) => step === "idle" ? "" : redactor.push(step)).join("") + redactor.flush()
}

// Each redactor this change touches, beside main's own version of it.
const pairs: readonly { name: string, main: (item: Case, steps: readonly Step[]) => string, current: (item: Case, steps: readonly Step[]) => string }[] = [
  { name: "terminal", main: (_item, steps) => runMain(steps), current: (_item, steps) => runNew(steps) },
  { name: "durable output stream", main: (_item, steps) => runMainDurable(steps), current: (_item, steps) => runNewDurable(steps) },
  { name: "durable output", main: (item) => mainRedactDurableOutput(item.text).value, current: (item) => redactDurableOutput(item.text).value },
  { name: "durable command", main: (item) => mainRedactDurableCommand(item.text).value, current: (item) => redactDurableCommand(item.text).value },
]

function failure(item: Case, steps: readonly Step[]): string | undefined {
  for (const pair of pairs) {
    const main = pair.main(item, steps)
    const current = pair.current(item, steps)
    if (item.value === undefined) {
      if (main === item.text && current !== item.text) return `${pair.name}: plain line changed: ${JSON.stringify(current.slice(0, 160))}`
      continue
    }
    const lost = item.kept.find((part) => main.includes(part) && !current.includes(part))
    if (lost !== undefined) return `${pair.name}: main keeps ${JSON.stringify(lost)}, this loses it: ${JSON.stringify(current.slice(-160))}`
    const pieces = fragments(item.value)
    if (pieces.length === 0 || pieces.some((piece) => main.includes(piece))) continue
    const shown = pieces.find((piece) => current.includes(piece))
    if (shown !== undefined) return `${pair.name}: main hides the value, this shows ${JSON.stringify(shown)}`
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

const cases = Number(process.env.TERMINAL_REDACTION_FUZZ_CASES ?? 4_000)
const seed = Number(process.env.TERMINAL_REDACTION_FUZZ_SEED ?? 20_260_923)
if (!Number.isSafeInteger(cases) || cases < 1 || !Number.isSafeInteger(seed)) {
  throw new Error("TERMINAL_REDACTION_FUZZ_CASES and TERMINAL_REDACTION_FUZZ_SEED must be integers")
}

describe("terminal redaction against main", () => {
  it(`hides at least what main hid and keeps what main kept, ${cases} cases from seed ${seed}`, () => {
    const failures = new Map<string, string>()
    for (let index = 0; index < cases; index += 1) {
      const caseSeed = seed + index
      const next = random(caseSeed)
      const item = generate(next)
      const steps = cut(item.text, next)
      const problem = failure(item, steps)
      if (!problem || failures.has(`${item.shape} (${problem.slice(0, problem.indexOf(":"))})`)) continue
      const minimal = shrink(item, steps)
      failures.set(`${item.shape} (${problem.slice(0, problem.indexOf(":"))})`, `seed ${caseSeed}: ${problem}\n  reads ${JSON.stringify(minimal.map((step) => step !== "idle" && step.length > 60 ? `${step.slice(0, 40)}…(${step.length})` : step))}`)
    }
    const report = [...failures].map(([shape, detail]) => `${shape}\n  ${detail}`)
    if (process.env.TERMINAL_REDACTION_FUZZ_REPORT) writeFileSync(process.env.TERMINAL_REDACTION_FUZZ_REPORT, report.join("\n"))
    expect(report).toEqual([])
  }, 10_000 + cases * 2)
})
