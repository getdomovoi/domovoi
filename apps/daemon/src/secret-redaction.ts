import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

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

export function redactWorkspaceCopies(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  const sanitized = structuredClone(snapshot)
  sanitized.approvals = sanitized.approvals.map((approval) => {
    const command = redactDurableCommand(approval.command)
    const operation = redactDurableText(approval.operation)
    const directory = redactDurableText(approval.directory)
    const affects = redactDurableText(approval.affects)
    const network = redactDurableText(approval.network)
    return {
      ...approval,
      risk: command.redacted || operation.redacted || directory.redacted
        || affects.redacted || network.redacted
        ? "hard-gate"
        : approval.risk,
      command: command.value,
      operation: operation.value,
      directory: directory.value,
      affects: affects.value,
      network: network.value,
    }
  })
  sanitized.approvalRules = sanitized.approvalRules.flatMap((rule) => {
    const command = redactDurableCommand(rule.command)
    const operation = redactDurableText(rule.operation)
    if (command.redacted || operation.redacted) return []
    return [{ ...rule, command: command.value, operation: operation.value }]
  })
  sanitized.thread = sanitized.thread.map((item) => {
    if (item.kind === "tool") {
      return {
        ...item,
        title: redactDurableCommand(item.title).value,
        ...(item.output === undefined
          ? {}
          : { output: redactDurableOutput(item.output).value }),
      }
    }
    if (item.kind === "receipt") {
      return {
        ...item,
        operation: redactDurableText(item.operation).value,
        ...(item.explanation === undefined
          ? {}
          : { explanation: redactDurableText(item.explanation).value }),
      }
    }
    if (item.kind === "checkpoint") {
      return { ...item, label: redactDurableText(item.label).value }
    }
    if (item.kind === "system") {
      return {
        ...item,
        body: redactDurableText(item.body).value,
        ...(item.detail === undefined
          ? {}
          : { detail: redactDurableText(item.detail).value }),
      }
    }
    return { ...item, body: redactDurableText(item.body).value }
  })
  return sanitized
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

export class TerminalOutputRedactor {
  #carry = ""

  // Everything held back plus the new read is redacted as one string, so an
  // assignment split across two reads is seen whole.
  push(chunk: string): string {
    const combined = `${this.#carry}${chunk}`
    const holdFrom = this.#suspiciousTailStart(combined)
    this.#carry = combined.slice(holdFrom)
    return redactStreamText(combined.slice(0, holdFrom))
  }

  flush(): string {
    if (this.#carry === "") return ""
    const remainder = this.#carry
    this.#carry = ""
    return redactStreamText(remainder)
  }

  // Only a tail that could still become a secret is worth withholding, and
  // never more than the carry bound, so a terminal that is simply busy is
  // never held up.
  #suspiciousTailStart(combined: string): number {
    const window = combined.slice(-terminalRedactionCarryCharacters)
    const match = danglingSecret.exec(window) ?? danglingWord.exec(window)
    if (!match) return combined.length
    return combined.length - window.length + match.index
  }
}
