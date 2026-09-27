// Redaction for the text a repository's provider files supply to the tool
// inventory: hook and server commands, rules and names. This is the guarantee;
// the protocol's credential backstop behind it only refuses forms it knows, and
// an entry it still refuses is dropped and counted by the reader.
//
// Every `NAME=value` at a word start, every value after a sensitive key, flag
// or authorization scheme, every URL query and fragment value, and all URL user
// info become [REDACTED]. The daemon's durable-text redaction leaves
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
  while (index < text.length && !/[\s;&|()<>]/u.test(text[index]!)) {
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

// A URL's user info, and every query and fragment value, redacted.
function redactUrl(url: string): string {
  const authorityStart = url.indexOf("://") + 3
  const authorityEnd = url.slice(authorityStart).search(/[/?#]/u)
  const authorityStop = authorityEnd === -1 ? url.length : authorityStart + authorityEnd
  const authority = url.slice(authorityStart, authorityStop)
  const at = authority.lastIndexOf("@")
  const host = at === -1 ? authority : `${marker}@${authority.slice(at + 1)}`
  const rest = url.slice(authorityStop).replace(/([?#&;])([^=&;#]*)=([^&;#]*)/gu, (whole, separator: string, name: string, value: string) => (
    value === "" ? whole : `${separator}${name}=${marker}`
  ))
  return `${url.slice(0, authorityStart)}${host}${rest}`
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
  return knownShapes.reduce((redacted, shape) => redacted.replace(shape, marker), output)
}

// A command given as an argument vector. A sensitive flag's next argument and
// the whole value of an assignment argument are redacted as units, since an
// argument is one word however many spaces it holds.
export function redactInventoryArgv(argv: readonly string[]): string {
  const words: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    const flag = /^-{1,2}([A-Za-z_][A-Za-z0-9_.-]*)$/u.exec(argument)
    const next = argv[index + 1]
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
