// Redaction for the text a repository's provider files supply to the tool
// inventory: hook and server commands, rules and names. This is the guarantee;
// the protocol's credential backstop behind it only refuses forms it knows, and
// an entry it still refuses is dropped and counted by the reader.
//
// Every `NAME=value` at a word start, every value after a sensitive key, flag
// or authorization scheme, every header value after a header flag whatever the
// header is called (the next word too, when an unquoted header ends at its
// colon), every URL query and fragment part (a bare part with no
// equals sign in whole), and all URL user info become [REDACTED]. A header
// value that opens with an authorization scheme keeps the scheme word, as a
// bare `Bearer x` does. The daemon's durable-text redaction leaves
// `DATABASE_URL=x`, `https://tok@host` and `Bearer tok` alone, so this pass is
// separate from it. It errs toward redacting: inside a quoted string a value
// runs to the closing quote, so `sh -c 'A=1 run'` reads `sh -c 'A=[REDACTED]'`.

const marker = "[REDACTED]"

// The same sensitive-name test as the protocol backstop, so a key it would
// refuse is a key redacted here. A key that names where a secret lives or
// counts something (--token-file, --max-tokens) is not sensitive.
const sensitiveParts = ["apikey", "accesskey", "privatekey", "sessionkey", "token", "password", "passwd", "secret", "credential", "cookie", "authorization"]
const pointerSuffixes = ["file", "path", "dir", "env", "name", "type", "helper", "command", "cmd", "url", "tokens", "tokenizer", "count", "limit", "length", "size"]
const schemeProse = new Set(["authentication", "authorization", "auth", "token", "tokens", "header", "headers", "scheme", "schemes", "credentials"])

function isSensitiveKey(key: string): boolean {
  const flat = key.toLowerCase().replace(/[-_.]/gu, "")
  if (flat === "auth" || flat === "pat") return true
  return sensitiveParts.some((part) => flat.includes(part)) && !pointerSuffixes.some((suffix) => flat.endsWith(suffix))
}

type Quote = "\"" | "'" | undefined

const wordBoundary = /[\s(;&|`<"'{]/u
const keyPair = /(-{1,2})?(["'`]?)([A-Za-z_][A-Za-z0-9_.-]*)\2(\s*[=:]\s*|\s+)/uy
const urlStart = /[A-Za-z][A-Za-z0-9+.-]*:\/\//uy
const scheme = /(?:Bearer|Basic|Token|Digest)\s+/iuy
const knownShapes: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/gu,
  /\b(?:sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/gu,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
]

// The end of a quoted string that opens at `start`, past its closing quote.
function quotedEnd(text: string, start: number): number {
  const quote = text[start]
  let index = start + 1
  while (index < text.length && text[index] !== quote) index += quote === "\"" && text[index] === "\\" ? 2 : 1
  return Math.min(index + 1, text.length)
}

// Where a value that starts at `start` ends. A value that is one quoted string
// ends at its closing quote; inside a quoted string any other value runs to
// that string's closing quote; outside one it is a whole shell word.
function valueEnd(text: string, start: number, quote: Quote): number {
  const first = text[start]
  if ((first === "\"" || first === "'") && first !== quote) return quotedEnd(text, start)
  let index = start
  if (quote) {
    while (index < text.length && text[index] !== quote) index += quote === "\"" && text[index] === "\\" ? 2 : 1
    return Math.min(index, text.length)
  }
  return wordEnd(text, index)
}

// The end of the unquoted shell word at `start`, quoted runs inside it included.
// Inside a quoted string, `quote`, the word also ends at that string's close.
function wordEnd(text: string, start: number, quote?: Quote): number {
  let index = start
  while (index < text.length && !/[\s;&|()<>]/u.test(text[index]!) && text[index] !== quote) {
    const character = text[index]!
    if (character === "\\") index += 2
    else if (character === "\"" || character === "'") index = quotedEnd(text, index)
    else index += 1
  }
  return Math.min(index, text.length)
}

function redactedValue(value: string): string {
  const quote = value[0]
  if ((quote === "\"" || quote === "'") && value.length >= 2 && value.endsWith(quote) && quotedEnd(value, 0) === value.length) {
    return `${quote}${marker}${quote}`
  }
  return marker
}

function isMarker(value: string): boolean {
  return value === marker || value === `"${marker}"` || value === `'${marker}'`
}

// A key and separator at `index` whose value is redacted: the value's span.
function pairAt(text: string, index: number, quote: Quote): { start: number; end: number } | undefined {
  if (index > 0 && /[\p{L}\p{N}_.-]/u.test(text[index - 1]!)) return undefined
  keyPair.lastIndex = index
  const match = keyPair.exec(text)
  if (!match) return undefined
  const [whole, flag = "", keyQuote = "", key = "", separator = ""] = match
  const start = index + whole.length
  if (start >= text.length || text[start] === quote) return undefined
  const joinedBy = separator.trim()
  const wordStart = index === 0 || wordBoundary.test(text[index - 1]!)
  let redacts: boolean
  if (joinedBy === "") redacts = flag !== "" && isSensitiveKey(key) && text[start] !== "-"
  else if (isSensitiveKey(key)) {
    // `Authorization: Bearer x` names a scheme; the scheme rule takes its value.
    scheme.lastIndex = start
    redacts = !(key.toLowerCase() === "authorization" && scheme.test(text))
  } else if (joinedBy === "=") redacts = flag === "" && keyQuote === "" && wordStart && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
  else redacts = /^[A-Z_][A-Z0-9_]+$/u.test(key) && (keyQuote !== "" || key.includes("_"))
  if (!redacts) return undefined
  const end = valueEnd(text, start, quote)
  return end > start ? { start, end } : undefined
}

// A query or fragment: each `name=value` part keeps its name, and a bare part
// is a value in whole, since `?opaque` or `#opaque` can be the token itself.
function redactUrlParts(payload: string): string {
  return payload.split(/([&;])/u).map((part, index) => {
    if (index % 2 === 1 || part === "" || isMarker(part)) return part
    const equals = part.indexOf("=")
    if (equals === -1) return marker
    const value = part.slice(equals + 1)
    return value === "" || isMarker(value) ? part : `${part.slice(0, equals + 1)}${marker}`
  }).join("")
}

// A URL's user info, and every query and fragment part, redacted.
function redactUrl(url: string): string {
  const authorityStart = url.indexOf("://") + 3
  const authorityEnd = url.slice(authorityStart).search(/[/?#]/u)
  const authorityStop = authorityEnd === -1 ? url.length : authorityStart + authorityEnd
  const authority = url.slice(authorityStart, authorityStop)
  const at = authority.lastIndexOf("@")
  const host = at === -1 ? authority : `${marker}@${authority.slice(at + 1)}`
  const rest = url.slice(authorityStop)
  const hash = rest.indexOf("#")
  const beforeHash = hash === -1 ? rest : rest.slice(0, hash)
  const question = beforeHash.indexOf("?")
  const path = question === -1 ? beforeHash : beforeHash.slice(0, question)
  const query = question === -1 ? "" : `?${redactUrlParts(beforeHash.slice(question + 1))}`
  const fragment = hash === -1 ? "" : `#${redactUrlParts(rest.slice(hash + 1))}`
  return `${url.slice(0, authorityStart)}${host}${path}${query}${fragment}`
}

// Flags that take a whole `Name: value` header line: curl's -H, --header and
// --proxy-header, and wget's --header. -H can hold its value in the same word.
const headerFlag = /(-H|--header|--proxy-header)(=|\s+)?/uy
// A field name is an RFC 9110 token, apostrophe and backtick included. The
// double quote is not a token character, but a shell word spells a quoted name
// with it (`"X-Foo":value`), so it is accepted too.
const headerLine = /^([A-Za-z0-9!#$%&'"*+.^_`|~-]+)(\s*:\s*)([\s\S]+)$/u
// A header argument that ends at its colon: `-H X-Foo: secret` unquoted
// leaves the value in the next shell word.
const headerWithoutValue = /^[A-Za-z0-9!#$%&'"*+.^_`|~-]+\s*:$/u

// The quote a shell word leaves open after `text`, or "" when none is.
function openQuote(text: string): string {
  let open = ""
  for (const character of text) {
    if (open === "" && (character === "'" || character === "\"")) open = character
    else if (character === open) open = ""
  }
  return open
}

// A header line with its value redacted, or undefined when the text is not a
// `Name: value` line (curl's `@file` form, or `Name;` for an empty header).
// In a shell word a quote in the name can open a quoted run that the value
// closes (`X'Foo: v w'`, `'X-Foo: a':b`), so the redacted value closes it again.
function redactHeaderLine(header: string, shellWord: boolean): string | undefined {
  const match = headerLine.exec(header)
  if (!match) return undefined
  const [, name = "", separator = "", value = ""] = match
  scheme.lastIndex = 0
  const kept = scheme.exec(value)?.[0] ?? ""
  const rest = value.slice(kept.length)
  const redacted = `${marker}${shellWord ? openQuote(name) : ""}`
  return `${redactKnownShapes(name)}${separator}${kept}${rest === "" || isMarker(rest) || rest === redacted ? rest : redacted}`
}

function redactKnownShapes(text: string): string {
  return knownShapes.reduce((redacted, shape) => redacted.replace(shape, marker), text)
}

// A header flag at `index` and the argument after it, with that argument's
// value redacted: the whole replacement and where it ends.
function headerAt(text: string, index: number, quote: Quote): { text: string; end: number } | undefined {
  if (index > 0 && !wordBoundary.test(text[index - 1]!)) return undefined
  headerFlag.lastIndex = index
  const match = headerFlag.exec(text)
  if (!match) return undefined
  const [whole, flag = "", separator = ""] = match
  // --headers is another flag; only -H takes its value in the same word.
  if (separator === "" && flag !== "-H") return undefined
  const start = index + whole.length
  const argument = headerArgument(text, start, quote)
  const line = text.slice(start + argument.open.length, argument.end - argument.close.length)
  const header = redactHeaderLine(line, argument.open === "")
  if (header !== undefined) return { text: `${whole}${argument.open}${header}${argument.close}`, end: argument.end }
  // A quoted `"Name:"` is an empty header its author closed; only an unquoted
  // one takes the next word as its value.
  if (argument.open !== "" || !headerWithoutValue.test(line)) return undefined
  const value = splitHeaderValue(text, argument.end, quote)
  return value && { text: `${text.slice(index, argument.end)}${value.text}`, end: value.end }
}

// The shell word after a header argument that ended at its colon, redacted,
// with the blanks before it. A flag there is the next argument, not a value,
// and a shell operator or the end of a quoted string ends the command.
function splitHeaderValue(text: string, from: number, quote: Quote): { text: string; end: number } | undefined {
  let start = from
  while (text[start] === " " || text[start] === "\t") start += 1
  if (start === from || start >= text.length || text[start] === quote || /[-;&|()<>\r\n]/u.test(text[start]!)) return undefined
  const blanks = text.slice(from, start)
  if (!quote) {
    const end = wordEnd(text, start)
    const word = text.slice(start, end)
    return { text: `${blanks}${isMarker(word) ? word : redactedValue(word)}`, end }
  }
  const argument = headerArgument(text, start, quote)
  const word = text.slice(start + argument.open.length, argument.end - argument.close.length)
  return { text: `${blanks}${argument.open}${isMarker(word) ? word : marker}${argument.close}`, end: argument.end }
}

// The shell word a header flag takes, and the quotes around it when the word
// is one quoted string. A quoted part with text glued after it
// (`'X-Foo':value`) is one word with no quotes around it.
function headerArgument(text: string, start: number, quote: Quote): { open: string; close: string; end: number } {
  const first = text[start]
  if ((first === "\"" || first === "'") && first !== quote) {
    const end = quotedEnd(text, start)
    const word = wordEnd(text, start, quote)
    if (word > end) return { open: "", close: "", end: word }
    return { open: first, close: end - 1 > start && text[end - 1] === first ? first : "", end }
  }
  if (quote === "\"" && text.startsWith("\\\"", start)) {
    // An escaped quote inside a double-quoted string: sh -c "curl -H \"X: v\"".
    for (let index = start + 2; index < text.length && text[index] !== "\""; index += text[index] === "\\" ? 2 : 1) {
      if (text.startsWith("\\\"", index)) return { open: "\\\"", close: "\\\"", end: index + 2 }
    }
    // Unclosed: the value runs to the end of the outer string.
    return { open: "\\\"", close: "", end: valueEnd(text, start, quote) }
  }
  if (!quote) return { open: "", close: "", end: valueEnd(text, start, quote) }
  // Inside a quoted string the word ends at a blank, an operator or that
  // string's close, and a quoted run of the other kind stays in it.
  return { open: "", close: "", end: wordEnd(text, start, quote) }
}

export function redactInventoryText(text: string): string {
  let output = ""
  let quote: Quote
  let index = 0
  while (index < text.length) {
    const character = text[index]!
    urlStart.lastIndex = index
    if ((index === 0 || !/[A-Za-z0-9+.-]/u.test(text[index - 1]!)) && urlStart.test(text)) {
      let end = index
      while (end < text.length && !/[\s"'`<>]/u.test(text[end]!) && text[end] !== quote) end += 1
      output += redactUrl(text.slice(index, end))
      index = end
      continue
    }
    const header = headerAt(text, index, quote)
    if (header) {
      output += header.text
      index = header.end
      continue
    }
    const pair = pairAt(text, index, quote)
    if (pair) {
      const value = text.slice(pair.start, pair.end)
      output += text.slice(index, pair.start) + (isMarker(value) ? value : redactedValue(value))
      index = pair.end
      continue
    }
    scheme.lastIndex = index
    if ((index === 0 || /[\s"'`(=:,{[]/u.test(text[index - 1]!)) && scheme.test(text)) {
      const start = scheme.lastIndex
      let end = start
      while (end < text.length && !/[\s"'`,;)]/u.test(text[end]!)) end += 1
      const value = text.slice(start, end)
      const keep = value === "" || value === marker || value.startsWith("-") || schemeProse.has(value.toLowerCase().replace(/[.,;:!?]+$/u, ""))
      output += text.slice(index, start) + (keep ? value : marker)
      index = end
      continue
    }
    if (character === "\\" && quote !== "'") {
      output += text.slice(index, index + 2)
      index += 2
      continue
    }
    if (quote) {
      if (character === quote) quote = undefined
    } else if (character === "\"" || character === "'") quote = character
    output += character
    index += 1
  }
  return redactKnownShapes(output)
}

// A command given as an argument vector. A sensitive flag's next argument, a
// header flag's header value and the whole value of an assignment argument are
// redacted as units, since an argument is one word however many spaces it holds.
// A header that ends at its colon takes the next argument as its value, as the
// text form does, unless that argument is a flag.
export function redactInventoryArgv(argv: readonly string[]): string {
  const words: string[] = []
  const takesSplitValue = (header: string, value: string | undefined): value is string => (
    headerWithoutValue.test(header) && value !== undefined && value !== "" && !value.startsWith("-")
  )
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    const flag = /^-{1,2}([A-Za-z_][A-Za-z0-9_.-]*)$/u.exec(argument)
    const next = argv[index + 1]
    if (/^(?:-H|--header|--proxy-header)$/u.test(argument) && next !== undefined) {
      words.push(argument, redactHeaderLine(next, false) ?? redactInventoryText(next))
      index += 1
      const value = argv[index + 1]
      if (takesSplitValue(next, value)) {
        words.push(value === marker ? value : marker)
        index += 1
      }
      continue
    }
    const attached = /^(-H|--header=|--proxy-header=)([\s\S]+)$/u.exec(argument)
    const attachedHeader = attached ? redactHeaderLine(attached[2]!, false) : undefined
    if (attached && attachedHeader !== undefined) {
      words.push(`${attached[1]!}${attachedHeader}`)
      continue
    }
    if (attached && takesSplitValue(attached[2]!, next)) {
      words.push(redactInventoryText(argument), next === marker ? next : marker)
      index += 1
      continue
    }
    if (flag && isSensitiveKey(flag[1]!) && next !== undefined && !next.startsWith("-")) {
      words.push(argument, next === marker ? next : marker)
      index += 1
      continue
    }
    const assignment = /^(-{0,2})([A-Za-z_][A-Za-z0-9_.-]*)=/u.exec(argument)
    if (assignment && ((assignment[1] === "" && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(assignment[2]!)) || isSensitiveKey(assignment[2]!))) {
      words.push(`${assignment[0]}${marker}`)
      continue
    }
    words.push(redactInventoryText(argument))
  }
  return words.map((word) => (word === "" || /[\s"'\\]/u.test(word) ? `"${word.replace(/["\\]/gu, "\\$&")}"` : word)).join(" ")
}
