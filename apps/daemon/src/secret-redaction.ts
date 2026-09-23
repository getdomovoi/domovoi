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

const sensitiveName = String.raw`(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|passwd|secret|client[_-]?secret|credentials?|cookie|private[_-]?key|aws[_-]?secret[_-]?access[_-]?key|github[_-]?token|openai[_-]?api[_-]?key|azure[_-]?client[_-]?secret)`
const quotedValue = String.raw`(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*')`
const assignment = new RegExp(
  String.raw`((?:\$env:|\bset\s+)?["']?\b${sensitiveName}\b["']?\s*=\s*)(${quotedValue}|[^\s;&|\r\n]+)`,
  "giu",
)
const structuredAssignment = new RegExp(
  String.raw`(["']?\b${sensitiveName}\b["']?\s*:\s*)(${quotedValue}|[^\s,;&|}\r\n]+)`,
  "giu",
)
const secretFlag = new RegExp(
  String.raw`((?:--|/)${sensitiveName}(?:\s*=\s*|\s+|:))("[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|\r\n]+)`,
  "giu",
)
const quotedCmdAssignment = new RegExp(
  String.raw`(\bset\s+)(["'])(${sensitiveName}\s*=)[^\r\n]*?\2`,
  "giu",
)
const javaSystemProperty = new RegExp(
  String.raw`(-D${sensitiveName}\s*=)("[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|\r\n]+)`,
  "giu",
)

export function redactDurableText(value: unknown): RedactedText {
  return redact(value, maximumDurableTextLength)
}

export function redactDurableCommand(value: unknown): RedactedText {
  return redact(value, maximumDurableCommandLength)
}

// A terminal read is shown, not stored, so it is redacted without the length
// bound the durable records carry: truncating what a terminal printed would
// lose output rather than protect anything.
export function redactStreamText(value: string): string {
  return redact(value, Number.MAX_SAFE_INTEGER).value
}

export function redactDurableOutput(value: unknown): RedactedText {
  return redact(value, maximumDurableOutputLength)
}

export function appendDurableOutput(current: string | undefined, addition: string): string {
  const combined = `${current ?? ""}${addition}`
  if (combined.length <= maximumDurableOutputLength) return combined
  return `…${combined.slice(-(maximumDurableOutputLength - 1))}`
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

  flush(): string {
    if (this.#droppingLongRecord) {
      this.#droppingLongRecord = false
      this.#pending = ""
      return ""
    }
    const output = redactDurableOutput(this.#pending).value
    this.#pending = ""
    return output
  }
}

function redact(value: unknown, maximumLength: number): RedactedText {
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
  output = replace(output, assignment, (...args) => {
    const prefix = args[1] ?? ""
    const secret = args[2] ?? ""
    const quote = secret.startsWith('"') ? '"' : secret.startsWith("'") ? "'" : ""
    return `${prefix}${quote}${replacement}${quote}`
  })
  output = replace(output, structuredAssignment, (...args) => {
    const prefix = args[1] ?? ""
    const secret = args[2] ?? ""
    const quote = secret.startsWith('"') ? '"' : secret.startsWith("'") ? "'" : ""
    return `${prefix}${quote}${replacement}${quote}`
  })
  output = replace(
    output,
    quotedCmdAssignment,
    (...args) => `${args[1] ?? ""}${args[2] ?? "\""}${args[3] ?? ""}${replacement}${args[2] ?? "\""}`,
  )
  output = replace(output, secretFlag, (...args) => {
    const prefix = args[1] ?? ""
    const secret = args[2] ?? ""
    const quote = secret.startsWith('"') ? '"' : secret.startsWith("'") ? "'" : ""
    return `${prefix}${quote}${replacement}${quote}`
  })
  output = replace(output, javaSystemProperty, (...args) => {
    const prefix = args[1] ?? ""
    const secret = args[2] ?? ""
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
export const terminalRedactionCarryCharacters = 256

// How much of one line is kept as context. A longer line keeps only its tail,
// unless it ends inside a value, which is then dropped up to where it ends.
const maximumTerminalLineContextCharacters = 8_192

const lineBoundary = /[\r\n]/

// Where a value ends, once the redactor has decided it is inside one.
const valueDelimiter = /[\s;&|\r\n]/

const assignmentPrefix = String.raw`(?:\$env:|\bset\s+)?["']?\b${sensitiveName}\b["']?\s*=\s*`
const structuredPrefix = String.raw`["']?\b${sensitiveName}\b["']?\s*:\s*`
const flagPrefix = String.raw`(?:--|/)${sensitiveName}(?:\s*=\s*|\s+|:)`
const javaPrefix = String.raw`-D${sensitiveName}\s*=`
const valuePrefix = `(?:${assignmentPrefix}|${structuredPrefix}|${flagPrefix}|${javaPrefix})`

// A quoted value whose closing quote has not arrived yet: everything after the
// opening quote is value until it does.
const unclosedQuotedValue = new RegExp(String.raw`(${valuePrefix})(["'])(?:\\.|(?!\2)[^\\\r\n])*$`, "iu")

// The line ends inside a value: an unclosed quote, or an unquoted run.
const valueAtEnd = new RegExp(String.raw`${valuePrefix}(?:(["'])(?:\\.|(?!\1)[^\\\r\n])*|[^\s;&|\r\n"'][^\s;&|\r\n]*)$`, "iu")

// The start of a bare token (sk-, ghp_, a JWT) still being printed. Held until
// the next read, so its first characters are not shown before the pattern that
// recognises it is complete. Not released on an idle beat: a token is not a
// prompt anyone waits on.
const tokenFragment = /\b(?:(?:sk|ghp|gho|github_pat|xox[baprs])(?:[-_][A-Za-z0-9_-]*)?|eyJ[A-Za-z0-9_.-]*)$/u

function redactTerminalLine(line: string): string {
  return redactStreamText(line.replace(unclosedQuotedValue, (_match, prefix: string, quote: string) => `${prefix}${quote}${replacement}`))
}

function commonPrefixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length)
  let index = 0
  while (index < length && left.charCodeAt(index) === right.charCodeAt(index)) index += 1
  return index
}

export class TerminalOutputRedactor {
  // The raw text of the current line so far, and the redacted form of it that
  // has been shown.
  #line = ""
  #shown = ""
  // Set when a line outgrew its context while inside a value: the value's
  // remaining bytes are dropped until this ends it.
  #droppingUntil: RegExp | undefined

  push(chunk: string): string {
    let input = chunk
    if (this.#droppingUntil) {
      const end = this.#droppingUntil.exec(input)
      if (!end) return ""
      input = input.slice(end.index + (this.#droppingUntil === valueDelimiter ? 0 : 1))
      this.#droppingUntil = undefined
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
    this.#droppingUntil = undefined
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
    const inValue = valueAtEnd.exec(this.#line)
    if (inValue) {
      const quote = inValue[1]
      this.#droppingUntil = quote === undefined ? valueDelimiter : new RegExp(quote === '"' ? '"' : "'")
      this.#line = ""
      this.#shown = ""
      return
    }
    this.#line = this.#line.slice(-terminalRedactionCarryCharacters)
    this.#shown = redactTerminalLine(this.#line)
  }
}
