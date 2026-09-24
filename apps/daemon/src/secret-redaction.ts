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
// A quoted value, "…", '…', $'…' or $"…", runs to its first unescaped closing
// quote, across spaces and line breaks. When that quote never comes, the value
// runs to the end of the text.
const quotedValue = String.raw`(?:\$?"(?:\\(?:[\s\S]|$)|[^"\\])*(?:"|$)|\$?'(?:\\(?:[\s\S]|$)|[^'\\])*(?:'|$))`
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
  // one start the lookbehind allows. One dash starts a flag as two do
  // (-token, -db-password), as Go and Java tools write them. A quoted value
  // honours backslash escapes, as an assignment's does, so an escaped quote
  // does not end it.
  String.raw`((?:(?<![A-Za-z0-9_.-])--?(?!(?:[A-Za-z0-9]*[_.-])*?(?:no|skip|without)[_.-])${namePrefix}|--|/)${sensitiveName}(?:\s*=\s*|\s+|:))(${quotedValue}|[^\s;&|\r\n]+)`,
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
function nameOf(prefix: string): { name: string, run: string, runStart: number } {
  const run = prefix.match(/[A-Za-z0-9_.-]+/gu)?.at(-1) ?? ""
  const name = run.startsWith("-D") ? run.slice(2) : run.replace(/^-+/u, "")
  return { name, run, runStart: prefix.lastIndexOf(run) }
}

// A quote opened right before the name that does not close before the
// separator, as in set "NAME=5", is still open: it closes after the value.
// When the name starts the match, the quote is the character before it.
function openNameQuote(prefix: string, before = ""): string | undefined {
  const { run, runStart } = nameOf(prefix)
  const preceding = runStart > 0 ? prefix[runStart - 1] : before
  const nameQuote = preceding === '"' || preceding === "'" ? preceding : undefined
  return nameQuote !== undefined && !prefix.slice(runStart + run.length).includes(nameQuote) ? nameQuote : undefined
}

function showsPlainValue(prefix: string, secret: string, before = ""): boolean {
  const { name } = nameOf(prefix)
  // A quoted value must be closed by the same quote. A quote opened before the
  // name, as in set "NAME=5", must close right after the value. Otherwise the
  // value holds no quote at all.
  const openQuote = openNameQuote(prefix, before)
  const quote = secret[0] === '"' || secret[0] === "'" ? secret[0] : undefined
  let value = secret
  if (quote !== undefined) {
    if (openQuote !== undefined || secret.length < 2 || !secret.endsWith(quote)) return false
    value = secret.slice(1, -1)
  } else if (openQuote !== undefined) {
    if (!secret.endsWith(openQuote)) return false
    value = secret.slice(0, -1)
  }
  return countingName.test(name) && plainValue.test(value)
}

const lostContextAssignment = new RegExp(
  String.raw`(${sensitiveName}["']?\s*[:=]\s*)(${quotedValue}|[^\s;&|\r\n]+)`,
  "giu",
)
// cmd's set "NAME=value": the quote before the name closes after the value,
// across line breaks; when it never closes, the value runs to the end.
const quotedCmdAssignment = new RegExp(
  String.raw`(\bset\s+)(["'])(${namePrefix}${sensitiveName}\s*=)[\s\S]*?(?:\2|$)`,
  "giu",
)
const javaSystemProperty = new RegExp(
  String.raw`((?:(?<![A-Za-z0-9_.-])-D${namePrefix}|-D)${sensitiveName}\s*=)(${quotedValue}|[^\s;&|\r\n]+)`,
  "giu",
)

// Reads a quoted value's text after its opening quote. end: the index just
// after the first unescaped closing quote, or -1 when the text ends first;
// escaped: whether the text ends in a backslash that escapes what comes next.
function scanQuoted(text: string, close: string, escaped: boolean): { end: number, escaped: boolean } {
  let escaping = escaped
  for (let at = 0; at < text.length; at += 1) {
    if (escaping) escaping = false
    else if (text[at] === "\\") escaping = true
    else if (text[at] === close) return { end: at + 1, escaped: false }
  }
  return { end: -1, escaped: escaping }
}

// A matched value's quoting: its opening quote, with any $, its closing
// quote, and whether that closing quote never came.
function quoting(secret: string): { opener: string, close: string, open: boolean, escaped: boolean } | undefined {
  const opener = /^\$?["']/u.exec(secret)?.[0]
  if (opener === undefined) return undefined
  const close = opener.slice(-1)
  const scanned = scanQuoted(secret.slice(opener.length), close, false)
  return { opener, close, open: scanned.end < 0, escaped: scanned.escaped }
}

// A hidden value keeps its quotes. A value whose quote never closed ran to the
// end of the text, so the line break it ended on is kept. An unquoted value
// that ends in a quote it did not open, as in set "NAME=value", keeps that
// quote, which closes the text around it.
function hiddenValue(prefix: string, secret: string): string {
  const quoted = quoting(secret)
  if (quoted === undefined) {
    const last = secret.at(-1)
    const closesAround = (last === '"' || last === "'") && secret.length > 1 && secret.indexOf(last) === secret.length - 1
    return `${prefix}${replacement}${closesAround ? last : ""}`
  }
  const lineEnd = quoted.open ? /(?:\r\n|\r|\n)$/u.exec(secret)?.[0] ?? "" : ""
  return `${prefix}${quoted.opener}${replacement}${quoted.close}${lineEnd}`
}

// A quoted value these patterns hide whose closing quote has not arrived by
// the end of the text. start: where its match starts; valueStart: where its
// opening quote starts, or for set "NAME=value", where the value starts.
type OpenQuotedValue = { start: number, valueStart: number, opener: string, close: string, escaped: boolean }

const openValuePatterns = [assignment, structuredAssignment, secretFlag, javaSystemProperty]

function lastMatch(pattern: RegExp, text: string): RegExpExecArray | undefined {
  let last: RegExpExecArray | undefined
  for (const match of text.matchAll(pattern)) last = match
  return last
}

function openQuotedValue(text: string): OpenQuotedValue | undefined {
  if (!/["']/u.test(text)) return undefined
  let found: OpenQuotedValue | undefined
  for (const pattern of openValuePatterns) {
    const match = lastMatch(pattern, text)
    if (match === undefined || match.index + match[0].length !== text.length) continue
    const secret = match[2] ?? ""
    const quoted = quoting(secret)
    if (!quoted?.open) continue
    if (found !== undefined && found.start <= match.index) continue
    found = { start: match.index, valueStart: text.length - secret.length, opener: quoted.opener, close: quoted.close, escaped: quoted.escaped }
  }
  const cmd = lastMatch(quotedCmdAssignment, text)
  if (cmd !== undefined && cmd.index + cmd[0].length === text.length) {
    const quote = cmd[2] ?? "\""
    const head = (cmd[1] ?? "").length + quote.length + (cmd[3] ?? "").length
    const closed = cmd[0].length > head && cmd[0].endsWith(quote)
    if (!closed && (found === undefined || cmd.index < found.start)) {
      found = { start: cmd.index, valueStart: cmd.index + head, opener: "", close: quote, escaped: false }
    }
  }
  return found
}

export function redactDurableText(value: unknown): RedactedText {
  return redact(value, maximumDurableTextLength)
}

export function redactDurableCommand(value: unknown): RedactedText {
  return redact(value, maximumDurableCommandLength)
}

// A terminal read is shown, not stored, so it is redacted without the length
// bound the durable records carry: truncating what a terminal printed would
// lose output rather than protect anything.
// A read the terminal redactor emits before the rest arrives is incomplete: a
// value at its end may still be growing, so it is not taken as complete.
// exemptFrom: where the text's context is known again. Before it, a counting
// value is not shown, since what came before its name is not in view.
// following: the character that comes after the text, when the rest is held
// back; it decides whether a value at the very end is complete.
export function redactStreamText(value: string, complete = true, exemptFrom = 0, following?: string): string {
  return redact(value, Number.MAX_SAFE_INTEGER, complete, exemptFrom, following).value
}

export function redactDurableOutput(value: unknown): RedactedText {
  return redact(value, maximumDurableOutputLength)
}

export function appendDurableOutput(current: string | undefined, addition: string): string {
  const combined = `${current ?? ""}${addition}`
  if (combined.length <= maximumDurableOutputLength) return combined
  return `…${combined.slice(-(maximumDurableOutputLength - 1))}`
}

const longRecordOmitted = "[Long command output line omitted]\n"

// A quoted value that is still open when its record ends goes on into the next
// record: that record is dropped up to the value's closing quote, which the
// replacement has already written.
type OpenQuote = { close: string, escaped: boolean }

export class DurableOutputRedactor {
  #pending = ""
  #droppingLongRecord = false
  #open: OpenQuote | undefined
  // The end of an omitted record's text, so a name split across reads of it
  // is still seen with its quoted value.
  #omittedTail = ""

  push(chunk: string): string {
    let input = chunk
    let emitted = ""
    while (input !== "") {
      if (this.#droppingLongRecord) {
        const newline = input.indexOf("\n")
        const end = newline < 0 ? input.length : newline + 1
        this.#omit(input.slice(0, end))
        if (newline < 0) return emitted
        this.#droppingLongRecord = false
        this.#omittedTail = ""
        input = input.slice(end)
        continue
      }
      if (this.#open) {
        const scanned = scanQuoted(input, this.#open.close, this.#open.escaped)
        if (scanned.end < 0) {
          this.#open = { ...this.#open, escaped: scanned.escaped }
          return emitted
        }
        this.#open = undefined
        input = input.slice(scanned.end)
        continue
      }

      let combined = `${this.#pending}${input}`
      this.#pending = ""
      input = ""
      let newline = combined.indexOf("\n")
      while (newline >= 0) {
        const record = combined.slice(0, newline + 1)
        combined = combined.slice(newline + 1)
        if (record.length > maximumStreamingOutputBufferLength) {
          emitted = appendDurableOutput(emitted, longRecordOmitted)
          this.#omit(record)
          this.#omittedTail = ""
        } else {
          emitted = appendDurableOutput(emitted, redactDurableOutput(record).value)
          const open = openQuotedValue(record)
          if (open) this.#open = { close: open.close, escaped: open.escaped }
        }
        if (this.#open) {
          input = combined
          combined = ""
          break
        }
        newline = combined.indexOf("\n")
      }

      if (combined.length > maximumStreamingOutputBufferLength) {
        emitted = appendDurableOutput(emitted, longRecordOmitted)
        this.#droppingLongRecord = true
        this.#omittedTail = ""
        this.#omit(combined)
      } else {
        this.#pending = combined
      }
    }
    return emitted
  }

  // Follows quoted values through text that is omitted rather than shown, so
  // a value still open at the end of an omitted record is dropped from the
  // next record as well.
  #omit(text: string): void {
    let rest = text
    while (rest !== "") {
      if (this.#open) {
        const scanned = scanQuoted(rest, this.#open.close, this.#open.escaped)
        if (scanned.end < 0) {
          this.#open = { ...this.#open, escaped: scanned.escaped }
          return
        }
        this.#open = undefined
        this.#omittedTail = ""
        rest = rest.slice(scanned.end)
        continue
      }
      const view = `${this.#omittedTail}${rest}`
      const open = openQuotedValue(view)
      if (open) {
        this.#open = { close: open.close, escaped: open.escaped }
        this.#omittedTail = ""
      } else {
        this.#omittedTail = view.slice(-maximumStreamingOutputBufferLength)
      }
      return
    }
  }

  // The pending record has no newline yet, so its last value may still grow.
  peek(): string {
    return this.#droppingLongRecord ? "" : redact(this.#pending, maximumDurableOutputLength, false).value
  }

  flush(): string {
    const output = this.#droppingLongRecord ? "" : redactDurableOutput(this.#pending).value
    this.#droppingLongRecord = false
    this.#pending = ""
    this.#open = undefined
    this.#omittedTail = ""
    return output
  }
}

function redact(value: unknown, maximumLength: number, complete = true, exemptFrom = 0, following?: string): RedactedText {
  const bounded = boundedText(value, maximumLength)
  // The end of the text ends a value only when nothing more can follow it, or
  // when what follows is known and is a delimiter.
  const delimiter = /[\s;&|,}\r\n]/u
  const endIsDelimiter = !bounded.truncated && (following === undefined ? complete : delimiter.test(following))
  const delimitedAt = (whole: string, index: number) => index >= whole.length
    ? endIsDelimiter
    : delimiter.test(whole[index]!)
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
  // The exemption applies only to a value that is complete: balanced quotes and
  // a delimiter, or the true end of the text, right after it.
  const valueReplacer = (...args: string[]) => {
    const prefix = args[1] ?? ""
    const secret = args[2] ?? ""
    const offset = Number(args.at(-2))
    const whole = String(args.at(-1))
    if (offset >= exemptFrom && showsPlainValue(prefix, secret, whole[offset - 1]) && delimitedAt(whole, offset + args[0]!.length)) return args[0]!
    return hiddenValue(prefix, secret)
  }
  // cmd's set "NAME=value" is read first, while its closing quote is still in
  // place: an assignment read first would take that quote as part of the
  // value.
  output = replace(output, quotedCmdAssignment, (...args) => {
    const matched = args[0]!
    const quote = args[2] ?? "\""
    const name = args[3] ?? ""
    const head = (args[1] ?? "").length + quote.length + name.length
    const closed = matched.length > head && matched.endsWith(quote)
    const offset = Number(args.at(-2))
    const whole = String(args.at(-1))
    if (closed && offset >= exemptFrom && showsPlainValue(name.replace(/\s*=$/u, ""), matched.slice(head, -quote.length)) && delimitedAt(whole, offset + matched.length)) return matched
    // A quote that never closed ran to the end of the text; the line break
    // it ended on is kept.
    const lineEnd = closed ? "" : /(?:\r\n|\r|\n)$/u.exec(matched)?.[0] ?? ""
    return `${args[1] ?? ""}${quote}${name}${replacement}${quote}${lineEnd}`
  })
  // Where what came before a name is out of view, a sensitive word counts as
  // a name wherever it starts, as it did before prefixes were read: main's
  // terminal redactor, holding only from the sensitive word, redacted
  // Dpassword=... after a flush left -D behind.
  if (exemptFrom > 0) {
    output = replace(output, lostContextAssignment, (...args: string[]) => {
      if (Number(args.at(-2)) >= exemptFrom) return args[0]!
      return hiddenValue(args[1] ?? "", args[2] ?? "")
    })
  }
  output = replace(output, assignment, valueReplacer)
  output = replace(output, structuredAssignment, valueReplacer)
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
// that may still be growing. The name's prefix, its flag dashes and the
// context before it are found by walking back from the sensitive word.
const danglingSecret = new RegExp(
  String.raw`${sensitiveName}\b(["']?\s*[:=]?\s*)([^\s;&|\r\n]*)$`,
  "iu",
)

// A name can itself be split, so a run of name characters still being typed at
// the end of a read, with any flag dashes, slash or dot in it, is held until
// the next read resolves it.
const danglingName = /[A-Za-z_./-][A-Za-z0-9_./-]*$/u
const nameCharacter = /[A-Za-z0-9_./-]/u
// What a pattern reads before a name: set, $env: and an opening quote.
const nameContext = /(?:\$env:|\bset\s+)?["']?$/iu
// That context alone at the end of a read, before any name has arrived. A
// quote counts only where it can open a name, not where it closes a value.
const danglingContext = /(?:\$env:|\bset\s+)["']?$|(?:^|[\s{,(])["']$/iu
const lineBreak = /[\r\n]/u

// A quoted value whose closing quote has arrived, with something after it, is
// no longer growing. A closing quote at the very end may still be followed by
// more of the same shell word.
function closedQuote(value: string): boolean {
  const quoted = quoting(value)
  if (quoted === undefined || quoted.open) return false
  return quoted.opener.length + scanQuoted(value.slice(quoted.opener.length), quoted.close, false).end < value.length
}

// Text that ends inside an open quoted value: what comes before the value is
// redacted as usual, and the value becomes the replacement in its quotes.
function hideOpenValue(text: string, open: OpenQuotedValue, complete: boolean, exemptFrom: number): string {
  const before = redactStreamText(text.slice(0, open.valueStart), complete, exemptFrom, text[open.valueStart])
  return `${before}${open.opener}${replacement}${open.close}`
}

// Where an unquoted value ends, once the redactor has decided it is inside one.
const valueDelimiter = /[\s;&|\r\n]/u
const closedValueDelimiter = /[\s;&|,}\r\n]/u

// What the terminal redactor is dropping once a value has outgrown the carry.
// quoted: an open quoted value, which ends at its first unescaped closing
// quote; escaped says the last character seen was an escaping backslash.
// unquoted: a value that ends at a delimiter.
// A quoted value ends only at that quote, across spaces, line breaks and
// idle flushes.
// pending: the name alone outgrew the carry, so the value has not started.
// What still belongs to the name (its closing quote, the separator, spaces)
// is shown, and the first character of the value decides how it is dropped.
// A name written as a flag may take its value after spaces alone; any other
// name needs its separator first. word: the end of the name so far, since it
// may still grow (CREDENTIAL into CREDENTIALS, SECRET into SECRET_KEY); the
// drop goes on only while the name still ends in a sensitive name.
type Dropping =
  | { kind: "quoted", quote: string, escaped: boolean }
  | { kind: "unquoted", end: RegExp, dollar: boolean }
  | { kind: "pending", separator: string | undefined, quoted: boolean, spaced: boolean, flag: boolean, word: string, grown: boolean }

const nameWordLength = 64
const endsInSensitiveName = new RegExp(String.raw`(?:^|[_.-])${sensitiveName}$`, "iu")

export class TerminalOutputRedactor {
  #carry = ""
  // Set once an assignment has outgrown what can be carried. From then on the
  // value's bytes are dropped rather than held, until it ends, so a token of
  // any length is redacted without anything being buffered for it. A quoted
  // value's closing quote is dropped too, since the replacement's own closing
  // quote has already taken its place.
  #dropping: Dropping | undefined
  // Set when text before a name was emitted without the name. After a flush
  // in the middle of a line, a counting value is not shown until the next line
  // break; after a name that outgrew the carry, not within the rest of that
  // name. Whether such a value is complete depends on what is no longer in
  // view.
  #contextLost: "line" | "name" | undefined

  // Everything held back plus the new read is redacted as one string, so an
  // assignment split across two reads is seen whole.
  push(chunk: string): string {
    let input = chunk
    let lead = ""
    while (this.#dropping && input !== "") {
      const step = this.#drop(this.#dropping, input)
      lead += step.shown
      input = step.rest
    }
    if (this.#dropping) return lead

    const combined = `${this.#carry}${input}`
    const exemptFrom = this.#exemptFrom(combined)

    // A quoted value whose closing quote has not arrived is held whole from
    // its name, whatever it holds so far: spaces and line breaks do not end
    // it. Once it outgrows the carry, the replacement stands for it and the
    // rest is dropped up to its closing quote.
    const open = openQuotedValue(combined)
    if (open) {
      const start = Math.min(open.start, this.#contextStart(combined, this.#nameStart(combined, open.start, 0)))
      if (combined.length - start > terminalRedactionCarryCharacters) {
        this.#carry = ""
        this.#dropping = { kind: "quoted", quote: open.close, escaped: open.escaped }
        this.#settle(combined)
        return `${lead}${hideOpenValue(combined, open, false, exemptFrom)}`
      }
      const emitted = combined.slice(0, start)
      this.#carry = combined.slice(start)
      this.#settle(emitted)
      return `${lead}${redactStreamText(emitted, false, exemptFrom, this.#carry[0])}`
    }

    const hold = this.#holdFrom(combined)
    const held = combined.length - hold.start
    if (held > terminalRedactionCarryCharacters && hold.value !== undefined) {
      // The held text is an assignment whose value has already run past the
      // carry. Redact what there is, which turns the value seen so far into
      // the replacement, and drop the rest of it as it arrives.
      this.#carry = ""
      this.#dropping = this.#startDropping(hold.value, hold.syntax ?? "", hold.flag ?? false, hold.word ?? "")
      this.#settle(combined)
      return `${lead}${redactStreamText(combined, false, exemptFrom)}`
    }

    const emitted = combined.slice(0, hold.start)
    this.#carry = combined.slice(hold.start)
    this.#settle(emitted)
    if (hold.cut && this.#contextLost === undefined) this.#contextLost = "name"
    return `${lead}${redactStreamText(emitted, false, exemptFrom, this.#carry[0])}`
  }

  #startDropping(value: string, syntax: string, flag: boolean, word: string): Dropping {
    if (value === "") {
      return { kind: "pending", separator: /[:=]/u.exec(syntax)?.[0], quoted: /["']/u.test(syntax), spaced: /\s/u.test(syntax), flag, word, grown: false }
    }
    const quoted = quoting(value)
    if (quoted?.open) return { kind: "quoted", quote: quoted.close, escaped: quoted.escaped }
    // A value whose quote has closed ends at a delimiter or at the comma or
    // brace that follows a JSON string.
    return { kind: "unquoted", end: quoted ? closedValueDelimiter : valueDelimiter, dollar: value === "$" }
  }

  // Drops what belongs to the value in one read. shown: what is emitted for
  // it; rest: what follows the value, once it has ended.
  #drop(dropping: Dropping, input: string): { shown: string, rest: string } {
    const end = (at: number, shown = "") => {
      this.#dropping = undefined
      return { shown, rest: input.slice(at) }
    }
    if (dropping.kind === "unquoted") {
      // A value that so far is only $ is quoted when a quote comes next.
      if (dropping.dollar && (input[0] === '"' || input[0] === "'")) {
        this.#dropping = { kind: "quoted", quote: input[0], escaped: false }
        return { shown: "", rest: input.slice(1) }
      }
      const delimiter = dropping.end.exec(input)
      if (delimiter) return end(delimiter.index)
      this.#dropping = { ...dropping, dollar: false }
      return { shown: "", rest: "" }
    }
    if (dropping.kind === "quoted") {
      const scanned = scanQuoted(input, dropping.quote, dropping.escaped)
      if (scanned.end >= 0) return end(scanned.end)
      this.#dropping = { ...dropping, escaped: scanned.escaped }
      return { shown: "", rest: "" }
    }

    let { separator, quoted, spaced, word, grown } = dropping
    for (let at = 0; at < input.length; at += 1) {
      const character = input[at]!
      // The name is still being written: it goes on only while it still ends
      // in a sensitive name, and it is shown.
      if (separator === undefined && !quoted && !spaced && nameCharacter.test(character)) {
        word = `${word}${character}`.slice(-nameWordLength)
        grown = true
        continue
      }
      if (grown && !endsInSensitiveName.test(word)) return end(at, input.slice(0, at))
      grown = false
      if (character === "\r" || character === "\n") return end(at, input.slice(0, at))
      if (character === " " || character === "\t") {
        spaced = true
        continue
      }
      const isQuote = character === '"' || character === "'"
      if (separator === undefined) {
        if (character === ":" || character === "=") {
          separator = character
          continue
        }
        if (isQuote && !quoted && !spaced) {
          quoted = true
          continue
        }
        if (!(dropping.flag && spaced)) return end(at, input.slice(0, at))
      }
      const structured = separator === ":" && !dropping.flag
      if ((structured ? closedValueDelimiter : valueDelimiter).test(character)) return end(at, input.slice(0, at))
      const shown = input.slice(0, at)
      // $'…' and $"…" are quoted as '…' and "…" are.
      const dollarQuote = character === "$" && (input[at + 1] === '"' || input[at + 1] === "'")
      if (isQuote || dollarQuote) {
        const quote = dollarQuote ? input[at + 1]! : character
        const opener = dollarQuote ? `$${quote}` : quote
        this.#dropping = { kind: "quoted", quote, escaped: false }
        return { shown: `${shown}${opener}${replacement}${quote}`, rest: input.slice(at + opener.length) }
      }
      // A $ at the end of the read may still open $'…'.
      const dollar = character === "$"
      this.#dropping = { kind: "unquoted", end: structured ? closedValueDelimiter : valueDelimiter, dollar }
      return { shown: `${shown}${replacement}`, rest: input.slice(dollar ? at + 1 : at) }
    }
    this.#dropping = { ...dropping, separator, quoted, spaced, word, grown }
    return { shown: input, rest: "" }
  }

  // Context is known again once what was lost has ended in emitted text.
  #settle(emitted: string): void {
    if (this.#contextLost === "line" && lineBreak.test(emitted)) this.#contextLost = undefined
    if (this.#contextLost === "name" && /[^A-Za-z0-9_./-]/u.test(emitted)) this.#contextLost = undefined
  }

  // A flush emits what is held. A quoted value still open at that point is
  // replaced, and what arrives after the flush is dropped up to its closing
  // quote, as it would be had the value outgrown the carry.
  flush(): string {
    if (this.#dropping?.kind !== "quoted") this.#dropping = undefined
    const remainder = this.#carry
    this.#carry = ""
    const exemptFrom = this.#exemptFrom(remainder)
    const open = remainder === "" ? undefined : openQuotedValue(remainder)
    if (open) this.#dropping = { kind: "quoted", quote: open.close, escaped: open.escaped }
    const output = remainder === ""
      ? ""
      : open
        ? hideOpenValue(remainder, open, true, exemptFrom)
        : redactStreamText(remainder, true, exemptFrom)
    // A flush in the middle of a line leaves the rest of the line without
    // what came before it.
    this.#settle(remainder)
    if (output !== "" && !/[\r\n]$/u.test(remainder)) this.#contextLost = "line"
    return output
  }

  #exemptFrom(text: string): number {
    if (this.#contextLost === undefined) return 0
    const end = (this.#contextLost === "line" ? lineBreak : /[^A-Za-z0-9_./-]/u).exec(text)
    return end ? end.index + 1 : Number.MAX_SAFE_INTEGER
  }

  // Only an end of text that could still become a secret is worth withholding,
  // so a terminal that is simply busy is never held up. A dangling name is held
  // from the start of the whole name, with the context a pattern reads before
  // it; a dangling assignment in full, since the point is to notice one that
  // has outgrown the bound. A name still being typed is held within the bound.
  // cut: the held name reaches back past the bound, so what came before it
  // was emitted without it.
  // syntax: what follows the sensitive word before its value; flag: the name
  // starts with a dash or a slash; word: the end of the name.
  #holdFrom(combined: string): { start: number, value?: string, syntax?: string, flag?: boolean, word?: string, cut?: boolean } {
    const assignment = danglingSecret.exec(combined)
    if (assignment && !closedQuote(assignment[2] ?? "")) {
      const nameStart = this.#nameStart(combined, assignment.index, 0)
      const value = assignment[2] ?? ""
      const syntax = assignment[1] ?? ""
      const wordEnd = assignment.index + assignment[0].length - syntax.length - value.length
      return {
        start: this.#contextStart(combined, nameStart),
        value,
        syntax,
        flag: combined[nameStart] === "-" || combined[nameStart] === "/",
        word: combined.slice(Math.max(nameStart, wordEnd - nameWordLength), wordEnd),
      }
    }
    const floor = Math.max(0, combined.length - terminalRedactionCarryCharacters)
    const window = combined.slice(floor)
    const name = danglingName.exec(window)
    if (!name) {
      const context = danglingContext.exec(window)
      return { start: context ? floor + context.index : combined.length }
    }
    const nameStart = this.#nameStart(combined, floor + name.index, floor)
    const contextStart = this.#contextStart(combined, nameStart)
    const start = Math.max(floor, contextStart)
    // Cut when the name, or the set " or quote read before it, goes on past
    // the bound.
    return { start, cut: start === floor && floor > 0 && (nameCharacter.test(combined[floor - 1]!) || contextStart < floor) }
  }

  #nameStart(combined: string, start: number, floor: number): number {
    let at = start
    while (at > floor && nameCharacter.test(combined[at - 1]!)) at -= 1
    return at
  }

  #contextStart(combined: string, start: number): number {
    const context = nameContext.exec(combined.slice(Math.max(0, start - 16), start))
    return context ? start - context[0].length : start
  }
}
