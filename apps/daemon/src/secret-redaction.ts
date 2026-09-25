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
// be enormous, and what it shows has to keep up with typing. Redaction still
// has to see across reads, so the whole of what has been carried plus the new
// read is redacted together, and a tail is held back only while it could still
// be the beginning of a secret. Ordinary output is never delayed, and nothing
// is ever replaced wholesale.
export const terminalRedactionCarryCharacters = 256

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
const valueDelimiter = /[\s;&|\r\n]/

// Main's terminal redactor, unchanged but for the dropping getter the wrapper
// below reads. The exported redactor wraps it.
class HeldTailRedactor {
  #carry = ""
  // Set once an assignment's value has outgrown what can be carried. From then
  // on the value's bytes are dropped rather than held, until its delimiter, so
  // a token of any length is redacted without anything being buffered for it.
  #droppingValue = false

  // Whether the rest of a value is being dropped rather than shown.
  get dropping(): boolean {
    return this.#droppingValue
  }

  // Everything held back plus the new read is redacted as one string, so an
  // assignment split across two reads is seen whole.
  push(chunk: string): string {
    let input = chunk
    if (this.#droppingValue) {
      const delimiter = valueDelimiter.exec(input)
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
      if (this.#value === undefined) this.#value = valueEndingText(this.#line)
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
      if (this.#context && this.#value === undefined) this.#value = valueEndingText(this.#line)
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
  #see(text: string): void {
    if ((text === " " || text === "\t") && /[ \t]$/u.test(this.#line)) return
    this.#line = `${this.#line}${text}`.slice(-terminalRedactionCarryCharacters)
  }
}
