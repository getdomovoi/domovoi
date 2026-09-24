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
const quotedValue = String.raw`(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*')`
// A sensitive name may carry an identifier prefix, as in NPM_TOKEN, db.password,
// npm's :_authToken or npm_config__authToken (a segment may be only its
// separator). It may not carry a suffix: TOKEN_BUDGET names a number.
const namePrefix = String.raw`(?:[A-Za-z0-9]*[_.-])*`
const prefixedName = String.raw`(?<![A-Za-z0-9_.-])${namePrefix}${sensitiveName}\b`
const assignment = new RegExp(
  String.raw`((?:\$env:|\bset\s+)?["']?${prefixedName}["']?\s*=\s*)(${quotedValue}|[^\s;&|\r\n]+)`,
  "giu",
)
const structuredAssignment = new RegExp(
  String.raw`(["']?${prefixedName}["']?\s*:\s*)(${quotedValue}|[^\s,;&|}\r\n]+)`,
  "giu",
)
const secretFlag = new RegExp(
  // A prefixed flag starts where a name cannot continue, so a run of dashes
  // starts one prefix walk rather than one at every position. A bare -- or /
  // followed directly by the sensitive name matches anywhere, as before
  // prefixes were added; it walks nothing, so it stays linear. A negated flag
  // takes no value: when any segment of the whole flag name is no, skip or
  // without (--no-password, --no-auth-token, --db-skip-client-secret), the
  // prefixed branch does not match. The check walks the name once, from the
  // one start the lookbehind allows.
  String.raw`((?:(?<![A-Za-z0-9_.-])--(?!(?:[A-Za-z0-9]*[_.-])*?(?:no|skip|without)[_.-])${namePrefix}|--|/)${sensitiveName}(?:\s*=\s*|\s+|:))("[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|\r\n]+)`,
  "giu",
)
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
function showsPlainValue(prefix: string, secret: string): boolean {
  const run = prefix.match(/[A-Za-z0-9_.-]+/gu)?.at(-1) ?? ""
  const name = run.startsWith("-D") ? run.slice(2) : run.replace(/^-+/u, "")
  const value = secret.replace(/^["']/u, "").replace(/["']$/u, "")
  return countingName.test(name) && plainValue.test(value)
}

const quotedCmdAssignment = new RegExp(
  String.raw`(\bset\s+)(["'])(${namePrefix}${sensitiveName}\s*=)[^\r\n]*?\2`,
  "giu",
)
const javaSystemProperty = new RegExp(
  String.raw`((?:(?<![A-Za-z0-9_.-])-D${namePrefix}|-D)${sensitiveName}\s*=)("[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|\r\n]+)`,
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
  const valueReplacer = (...args: string[]) => {
    const prefix = args[1] ?? ""
    const secret = args[2] ?? ""
    if (showsPlainValue(prefix, secret)) return args[0]!
    const quote = secret.startsWith('"') ? '"' : secret.startsWith("'") ? "'" : ""
    return `${prefix}${quote}${replacement}${quote}`
  }
  output = replace(output, assignment, valueReplacer)
  output = replace(output, structuredAssignment, valueReplacer)
  output = replace(output, quotedCmdAssignment, (...args) => {
    const matched = args[0]!
    const quote = args[2] ?? "\""
    const name = args[3] ?? ""
    const value = matched.slice((args[1] ?? "").length + quote.length + name.length, -quote.length)
    if (showsPlainValue(name.replace(/\s*=$/u, ""), value)) return matched
    return `${args[1] ?? ""}${quote}${name}${replacement}${quote}`
  })
  output = replace(output, secretFlag, valueReplacer)
  output = replace(output, javaSystemProperty, valueReplacer)
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

export class TerminalOutputRedactor {
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
