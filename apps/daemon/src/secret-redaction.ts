import * as baseline from "./secret-redaction-baseline.js"
import {
  appendDurableOutput,
  maximumDurableCommandLength,
  maximumDurableOutputLength,
  maximumDurableTextLength,
  maximumStreamingOutputBufferLength,
  terminalRedactionCarryCharacters,
  type RedactedText,
} from "./secret-redaction-baseline.js"

export {
  appendDurableOutput,
  maximumDurableCommandLength,
  maximumDurableOutputLength,
  maximumDurableTextLength,
  maximumStreamingOutputBufferLength,
  terminalRedactionCarryCharacters,
  type RedactedText,
}

// Redaction runs in two stages. The first, in this file, adds the forms main
// misses: shell quoting, values that arrive after their name, quotes that never
// close. The second is main's own code, in secret-redaction-baseline.ts: a
// byte-identical copy of this file at 8bda137f that nothing edits (a test holds
// its bytes to that commit). It reads what the first stage let through, last,
// so the result is never less redacted than main's own reading of that text.
// New pattern work belongs in the first stage.

const replacement = "[REDACTED]"

const sensitiveName = String.raw`(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|passwd|secret|client[_-]?secret|credentials?|cookie|private[_-]?key|aws[_-]?secret[_-]?access[_-]?key|github[_-]?token|openai[_-]?api[_-]?key|azure[_-]?client[_-]?secret)`
// A backslash escapes the next character, whatever it is short of a line end:
// `.` would not match U+2028 or U+2029, and the quote would seem to end there.
const escaped = String.raw`\\[^\r\n]`
const quotedValue = String.raw`(?:"(?:${escaped}|[^"\\\r\n])*"|'(?:${escaped}|[^'\\\r\n])*')`
// A quoted shell word: a backslash escapes inside double quotes, and is a
// literal character inside single quotes, which nothing can escape.
const shellQuotedValue = String.raw`(?:"(?:${escaped}|[^"\\\r\n])*"|'[^'\r\n]*')`
// A shell quote that never closes on its line (a double quote's closing quote
// may be escaped): the value runs to the end of the line.
const unclosedShellQuotedValue = String.raw`(?:"(?:${escaped}|[^"\\\r\n])*\\?(?=[\r\n]|$)|'[^'\r\n]*(?=[\r\n]|$))`
const assignmentPrefix = String.raw`(?:\$env:|\bset\s+)?["']?\b${sensitiveName}\b["']?\s*=\s*`
const structuredPrefix = String.raw`["']?\b${sensitiveName}\b["']?\s*:\s*`
const flagPrefix = String.raw`(?:--|/)${sensitiveName}(?:\s*=\s*|\s+|:)`
// Space after the "=" is allowed: main's terminal redactor, holding the name
// back from "-D", reads "-Dpassword= 'x'" as an assignment whose value is 'x'.
const javaPrefix = String.raw`-D${sensitiveName}\s*=\s*`
// A value is one word: unquoted characters and closed quotes, up to a
// delimiter (`"…"rest` is one shell value), so nothing of it is left behind. A
// quote that does not close in the word is not taken as part of it: it may be
// the end of a quoted value this name sits inside, and main's code, reading
// last, needs that quote to see where that value ends. A value that starts
// with a quote which never closes runs to the end of the line.
// Formatting a terminal writes between a name and its value.
const formatting = String.raw`(?:\x1b\[[0-9;]*[A-Za-z])*`
const shellValue = String.raw`${formatting}${unclosedShellQuotedValue}|(?:[^\s;&|\r\n"']|${shellQuotedValue})+`
// Every name and its value in one pass, left to right, so a name inside a
// value already matched (a quoted value that holds "token=…") is part of that
// value, not a second assignment that could run past its closing quote.
const secretValue = new RegExp(
  [
    String.raw`(${flagPrefix})(${shellValue})`,
    String.raw`(${javaPrefix})(${shellValue})`,
    String.raw`(${assignmentPrefix})((?:[^\s;&|\r\n"']|${quotedValue})+|["'][^\s;&|\r\n]*)`,
    String.raw`(${structuredPrefix})((?:[^\s,;&|}\r\n"']|${quotedValue})+|["'][^\s,;&|}\r\n]*)`,
  ].join("|"),
  "giu",
)

export function redactDurableText(value: unknown): RedactedText {
  return thenBaseline(redactAddedForms(value, maximumDurableTextLength), baseline.redactDurableText)
}

export function redactDurableCommand(value: unknown): RedactedText {
  return thenBaseline(redactAddedForms(value, maximumDurableCommandLength), baseline.redactDurableCommand)
}

// A terminal read is shown, not stored, so it is redacted without the length
// bound the durable records carry: truncating what a terminal printed would
// lose output rather than protect anything.
export function redactStreamText(value: string): string {
  return baseline.redactStreamText(redactAddedForms(value, Number.MAX_SAFE_INTEGER).value)
}

export function redactDurableOutput(value: unknown): RedactedText {
  return thenBaseline(redactAddedForms(value, maximumDurableOutputLength), baseline.redactDurableOutput)
}

function thenBaseline(first: RedactedText, second: (value: unknown) => RedactedText): RedactedText {
  const last = second(first.value)
  return { value: last.value, redacted: first.redacted || last.redacted, truncated: first.truncated || last.truncated }
}

export class DurableOutputRedactor {
  #pending = ""
  #droppingLongRecord = false

  push(chunk: string): string {
    let input = chunk
    if (this.#droppingLongRecord) {
      const newline = input.indexOf("\n")
      if (newline < 0) return ""
      input = input.slice(newline + 1)
      this.#droppingLongRecord = false
    }

    let combined = `${this.#pending}${input}`
    this.#pending = ""
    let emitted = ""
    let newline = combined.indexOf("\n")
    while (newline >= 0) {
      const record = combined.slice(0, newline + 1)
      emitted = appendDurableOutput(
        emitted,
        record.length > maximumStreamingOutputBufferLength
          ? "[Long command output line omitted]\n"
          : redactDurableOutput(record).value,
      )
      combined = combined.slice(newline + 1)
      newline = combined.indexOf("\n")
    }

    if (combined.length > maximumStreamingOutputBufferLength) {
      emitted = appendDurableOutput(emitted, "[Long command output line omitted]\n")
      this.#droppingLongRecord = true
    } else {
      this.#pending = combined
    }
    return emitted
  }

  peek(): string {
    return this.#droppingLongRecord ? "" : redactDurableOutput(this.#pending).value
  }

  flush(): string {
    const output = this.peek()
    this.#droppingLongRecord = false
    this.#pending = ""
    return output
  }
}

// The first stage's pattern pass, bounded the way main bounds its own.
function redactAddedForms(value: unknown, maximumLength: number): RedactedText {
  const bounded = boundedText(value, maximumLength)
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
  output = replace(output, secretValue, (...args) => {
    const pair = [1, 3, 5, 7].find((group) => args[group] !== undefined) ?? 1
    const prefix = args[pair] ?? ""
    const secret = args[pair + 1] ?? ""
    const quote = secret.startsWith('"') ? '"' : secret.startsWith("'") ? "'" : ""
    return `${prefix}${quote}${replacement}${quote}`
  })
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
// be enormous, and what it shows has to keep up with typing. Each read is
// redacted in the context of the whole of its current line, and what is shown
// is how the redacted line has grown since last time. A value always follows
// its name on the same line, so however the line was split across reads or
// idle beats, the name is in view when the value arrives, and nothing that
// could still turn out to be a value has to be held back to be caught.
// Line boundaries are carriage returns and newlines.

// How much of one line is kept as context. A longer line keeps only its tail,
// unless it ends inside a value, which is then dropped up to where it ends.
const maximumTerminalLineContextCharacters = 8_192

const lineBoundary = /[\r\n]/

// Where a value ends, once the redactor has decided it is inside one.
const valueDelimiter = /[\s;&|\r\n]/

const shellValuePrefix = `(?:${assignmentPrefix}|${flagPrefix}|${javaPrefix})`
const valuePrefix = `(?:${shellValuePrefix}|${structuredPrefix})`

// Every place a value could start, shell or structured, to find the last one.
const valueStarts = new RegExp(String.raw`(${shellValuePrefix})|(${structuredPrefix})`, "giu")

// A quoted value whose closing quote has not arrived yet: everything after the
// opening quote is value until it does.
const unclosedQuotedValue = new RegExp(String.raw`(${valuePrefix})(?:(")(?:${escaped}|[^"\\\r\n])*\\?|(')[^'\r\n]*)$`, "iu")

// The line ends with a name and its separator whose value has not started.
const pendingValue = new RegExp(String.raw`${valuePrefix}$`, "iu")

// Where a value is, once the redactor has decided it is inside one. A shell
// value is a shell word: a backslash escapes inside double quotes and is
// literal inside single quotes, and a closing quote does not end the word,
// only an unquoted delimiter does. A structured (JSON) value is read the same
// way, except that a comma or closing brace also ends it. A carriage return or
// a newline ends both.
type ValueScan = { context: "shell" | "structured", quote: string | undefined, escaped: boolean }

const structuredValueDelimiter = /[\s,;&|}]/u

// Where the value being scanned ends in this text, or undefined if it goes on.
function endOfValue(text: string, scan: ValueScan): number | undefined {
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!
    if (character === "\n" || character === "\r") return index
    if (scan.quote !== undefined) {
      if (scan.escaped) {
        scan.escaped = false
      } else if (character === "\\" && scan.quote === '"') {
        scan.escaped = true
      } else if (character === scan.quote) {
        scan.quote = undefined
      }
      continue
    }
    if ((scan.context === "structured" ? structuredValueDelimiter : valueDelimiter).test(character)) return index
    if (character === '"' || character === "'") scan.quote = character
  }
  return undefined
}

// The value the line ends inside, if any. Values are read left to right, each
// from its name to its end, so a name inside an earlier value (a quoted value
// holding "token=…") is part of that value and never starts one of its own.
function valueOpenAtEnd(line: string): ValueScan | undefined {
  const starts = new RegExp(valueStarts.source, valueStarts.flags)
  for (let start = starts.exec(line); start; start = starts.exec(line)) {
    const from = start.index + start[0].length
    if (from === line.length) return undefined
    const scan: ValueScan = { context: start[1] === undefined ? "structured" : "shell", quote: undefined, escaped: false }
    const end = endOfValue(line.slice(from), scan)
    if (end === undefined) return scan
    starts.lastIndex = from + end
  }
  return undefined
}

// The start of a bare token (sk-, ghp_, a JWT) still being printed. Held until
// the next read, so its first characters are not shown before the pattern that
// recognises it is complete. Not released on an idle beat: a token is not a
// prompt anyone waits on.
const tokenFragment = /\b(?:(?:sk|ghp|gho|github_pat|xox[baprs])(?:[-_][A-Za-z0-9_-]*)?|eyJ[A-Za-z0-9_.-]*)$/u

// A quoted value and the rest of its word (`"…"rest` is one shell value). The
// word goes on to the next delimiter, which for a structured (JSON) value also
// includes a comma or closing brace, so `"password":"…","safe":…` keeps the
// field after it.
const quotedValueWithWord = new RegExp(String.raw`(${shellValuePrefix})(${shellQuotedValue})([^\s;&|\r\n]+)`, "giu")
const structuredQuotedValueWithWord = new RegExp(String.raw`(${structuredPrefix})(${quotedValue})([^\s,;&|}\r\n]+)`, "giu")

function redactTerminalLine(line: string): string {
  const unclosed = line.replace(unclosedQuotedValue, (_match, prefix: string, double: string | undefined, single: string | undefined) => `${prefix}${double ?? single}${replacement}`)
  const wholeWord = (_match: string, prefix: string, quoted: string) => `${prefix}${quoted[0]}${replacement}${quoted[0]}`
  const words = unclosed.replace(quotedValueWithWord, wholeWord).replace(structuredQuotedValueWithWord, wholeWord)
  return redactAddedForms(words, Number.MAX_SAFE_INTEGER).value
}

function commonPrefixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length)
  let index = 0
  while (index < length && left.charCodeAt(index) === right.charCodeAt(index)) index += 1
  return index
}

class LineContextRedactor {
  // The raw text of the current line so far, and the redacted form of it that
  // has been shown.
  #line = ""
  #shown = ""
  // Set when a line outgrew its context while inside a value: the value's
  // remaining bytes are dropped until it ends. A quoted value ends at its
  // unescaped closing quote; either kind ends at a line boundary.
  #dropping: ValueScan | undefined

  push(chunk: string): string {
    let input = chunk
    if (this.#dropping) {
      const end = endOfValue(input, this.#dropping)
      if (end === undefined) return ""
      input = input.slice(end)
      this.#dropping = undefined
    }
    let output = ""
    while (input.length > 0) {
      const boundary = lineBoundary.exec(input)
      if (boundary) {
        this.#line += input.slice(0, boundary.index + 1)
        input = input.slice(boundary.index + 1)
        output += this.#show(redactTerminalLine(this.#line))
        this.#line = ""
        this.#shown = ""
        continue
      }
      this.#line += input
      input = ""
      const held = tokenFragment.exec(this.#line)
      const ready = held && held[0].length <= terminalRedactionCarryCharacters
        ? this.#line.slice(0, held.index)
        : this.#line
      output += this.#show(redactTerminalLine(ready))
      if (this.#line.length > maximumTerminalLineContextCharacters) this.#trimLine()
    }
    return output
  }

  // An idle beat. Everything but a bare token still being printed has already
  // been shown, so there is nothing more to release.
  release(): string {
    return ""
  }

  // The end of the stream: show what is held, redacted, and forget the line.
  flush(): string {
    const output = this.#line === "" ? "" : this.#show(redactTerminalLine(this.#line))
    this.#line = ""
    this.#shown = ""
    this.#dropping = undefined
    return output
  }

  // Shows how the redacted line grew. If redaction changed text already shown
  // (a bare token recognised late), the rest of the redacted line is shown
  // after it: the view may repeat a little, but nothing unredacted appears.
  #show(redacted: string): string {
    const shared = commonPrefixLength(redacted, this.#shown)
    const added = redacted.slice(shared)
    this.#shown = redacted
    return added
  }

  #trimLine(): void {
    const open = valueOpenAtEnd(this.#line)
    if (open) {
      // The line ends inside a value: drop the rest of it as it arrives.
      this.#dropping = open
      this.#line = ""
      this.#shown = ""
      return
    }
    // A name and separator whose value has not started stay as context, so a
    // value after a long run of spaces is still seen as one.
    const pending = pendingValue.exec(this.#line)
    if (pending) {
      const kept = pending[0].length > terminalRedactionCarryCharacters
        ? pending[0].replace(/\s+$/u, (space) => space.slice(-1))
        : pending[0]
      this.#line = kept
      this.#shown = redactTerminalLine(kept)
      return
    }
    this.#line = this.#line.slice(-terminalRedactionCarryCharacters)
    this.#shown = redactTerminalLine(this.#line)
  }

}

// The terminal's redactor is the line-context stage followed by main's own
// terminal redactor. The line-context stage reads each line whole, so a value
// that arrives after its name, across a read or an idle beat, is still
// redacted. Main's then reads what the first let through, in the same reads,
// holding back a tail that might become a secret and releasing it on an idle
// beat so a prompt shows.
export class TerminalOutputRedactor {
  readonly #line = new LineContextRedactor()
  readonly #baseline = new baseline.TerminalOutputRedactor()

  push(chunk: string): string {
    return this.#baseline.push(this.#line.push(chunk))
  }

  // An idle beat: main releases what it holds, so a prompt shows. The
  // line-context stage keeps the line it belongs to as context.
  release(): string {
    const released = this.#line.release()
    return `${released ? this.#baseline.push(released) : ""}${this.#baseline.flush()}`
  }

  flush(): string {
    const remainder = this.#line.flush()
    return `${remainder ? this.#baseline.push(remainder) : ""}${this.#baseline.flush()}`
  }
}
