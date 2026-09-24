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
// A quoted shell word: a backslash escapes inside double quotes, and is a
// literal character inside single quotes, which nothing can escape.
const shellQuotedValue = String.raw`(?:"(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*')`
// A shell quote that never closes on its line (a double quote's closing quote
// may be escaped): the value runs to the end of the line.
const unclosedShellQuotedValue = String.raw`(?:"(?:\\.|[^"\\\r\n])*\\?(?=[\r\n]|$)|'[^'\r\n]*(?=[\r\n]|$))`
const assignment = new RegExp(
  String.raw`((?:\$env:|\bset\s+)?["']?\b${sensitiveName}\b["']?\s*=\s*)(${quotedValue}|[^\s;&|\r\n]+)`,
  "giu",
)
const structuredAssignment = new RegExp(
  String.raw`(["']?\b${sensitiveName}\b["']?\s*:\s*)(${quotedValue}|[^\s,;&|}\r\n]+)`,
  "giu",
)
const secretFlag = new RegExp(
  String.raw`((?:--|/)${sensitiveName}(?:\s*=\s*|\s+|:))(${shellQuotedValue}|${unclosedShellQuotedValue}|[^\s;&|\r\n]+)`,
  "giu",
)
const quotedCmdAssignment = new RegExp(
  String.raw`(\bset\s+)(["'])(${sensitiveName}\s*=)[^\r\n]*?\2`,
  "giu",
)
const javaSystemProperty = new RegExp(
  String.raw`(-D${sensitiveName}\s*=)(${shellQuotedValue}|${unclosedShellQuotedValue}|[^\s;&|\r\n]+)`,
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
const shellValuePrefix = `(?:${assignmentPrefix}|${flagPrefix}|${javaPrefix})`
const valuePrefix = `(?:${shellValuePrefix}|${structuredPrefix})`

// Every place a value could start, shell or structured, to find the last one.
const valueStarts = new RegExp(String.raw`(${shellValuePrefix})|(${structuredPrefix})`, "giu")

// A quoted value whose closing quote has not arrived yet: everything after the
// opening quote is value until it does.
const unclosedQuotedValue = new RegExp(String.raw`(${valuePrefix})(?:(")(?:\\.|[^"\\\r\n])*\\?|(')[^'\r\n]*)$`, "iu")

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
  return redactStreamText(words)
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
    let last: RegExpExecArray | undefined
    for (const start of this.#line.matchAll(valueStarts)) last = start
    if (last) {
      const rest = this.#line.slice(last.index + last[0].length)
      const scan: ValueScan = { context: last[1] === undefined ? "structured" : "shell", quote: undefined, escaped: false }
      if (rest.length > 0 && endOfValue(rest, scan) === undefined) {
        // The line ends inside a value: drop the rest of it as it arrives.
        this.#dropping = scan
        this.#line = ""
        this.#shown = ""
        return
      }
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

// The first stage, unchanged from before the line-context stage existed. It
// holds back a tail that might become a secret, redacting what it holds with
// what arrives next, and the terminal releases it on an idle beat so a prompt
// shows. Whatever it hides stays hidden: the second stage only ever removes.
// The start of an assignment this redactor would act on, left dangling at the
// end of a read: a sensitive name, or one followed by its separator and a value
// that may still be growing.
const danglingSecret = new RegExp(
  String.raw`(?:${sensitiveName}\b["']?\s*[:=]?\s*|(?:--|/)${sensitiveName}(?:\s*=\s*|\s+|:)?|-D${sensitiveName}\s*=?)[^\s;&|\r\n]*$`,
  "i",
)

// A sensitive name can itself be split, so a word still being typed at the end
// of a read is held until the next one resolves it.
const danglingWord = /[A-Za-z][A-Za-z0-9_-]*$/

// Where a value ends, once the redactor has decided it is inside one.
const heldValueDelimiter = /[\s;&|\r\n]/

class HeldTailRedactor {
  #carry = ""
  // Set once an assignment's value has outgrown what can be carried. From then
  // on the value's bytes are dropped rather than held, until its delimiter, so
  // a token of any length is redacted without anything being buffered for it.
  #droppingValue = false

  // Everything held back plus the new read is redacted as one string, so an
  // assignment split across two reads is seen whole.
  push(chunk: string): string {
    let input = chunk
    if (this.#droppingValue) {
      const delimiter = heldValueDelimiter.exec(input)
      if (!delimiter) return ""
      input = input.slice(delimiter.index)
      this.#droppingValue = false
    }

    const combined = `${this.#carry}${input}`
    const holdFrom = this.#suspiciousTailStart(combined)
    const held = combined.length - holdFrom
    if (held > terminalRedactionCarryCharacters) {
      // The tail is an assignment whose value has already run past the carry.
      // Redact what there is, which turns the value seen so far into the
      // replacement, and drop the rest of it as it arrives.
      this.#carry = ""
      this.#droppingValue = true
      return redactStreamText(combined)
    }

    this.#carry = combined.slice(holdFrom)
    return redactStreamText(combined.slice(0, holdFrom))
  }

  flush(): string {
    this.#droppingValue = false
    if (this.#carry === "") return ""
    const remainder = this.#carry
    this.#carry = ""
    return redactStreamText(remainder)
  }

  // Only a tail that could still become a secret is worth withholding, so a
  // terminal that is simply busy is never held up. A dangling word is checked
  // within the carry bound; a dangling assignment is checked in full, since the
  // point is to notice one that has outgrown the bound.
  #suspiciousTailStart(combined: string): number {
    const assignment = danglingSecret.exec(combined)
    if (assignment) return assignment.index
    const window = combined.slice(-terminalRedactionCarryCharacters)
    const word = danglingWord.exec(window)
    if (!word) return combined.length
    return combined.length - window.length + word.index
  }
}

// The terminal's redactor is the two stages in a row. The line-context stage
// reads each line whole, so a value that arrives after its name, across a
// read or an idle beat, is still redacted. The held-tail stage then reads what
// the first let through, in the same reads, and hides what it always hid. Each
// stage only removes, so what either hides stays hidden.
export class TerminalOutputRedactor {
  readonly #line = new LineContextRedactor()
  readonly #held = new HeldTailRedactor()

  push(chunk: string): string {
    return this.#held.push(this.#line.push(chunk))
  }

  // An idle beat: the held-tail stage releases what it holds, so a prompt
  // shows; the line-context stage keeps the line it belongs to as context.
  release(): string {
    const released = this.#line.release()
    return `${released ? this.#held.push(released) : ""}${this.#held.flush()}`
  }

  flush(): string {
    const remainder = this.#line.flush()
    return `${remainder ? this.#held.push(remainder) : ""}${this.#held.flush()}`
  }
}
