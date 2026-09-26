// A backstop for text a provider's own file supplied. The guarantee lives in
// the daemon's reader (a later slice), which must redact before it emits:
// every `NAME=value` assignment, every value of a sensitive key, flag or
// authorization scheme, and all URL user info read `[REDACTED]`. This check
// does not redact. It refuses text that still carries such a value, so a
// reader that missed one fails instead of leaking.
//
// Each text is read as sent, after one layer of percent, backslash and \u
// decoding, and as the shell assembles its words (quotes joined, $'...'
// escapes decoded). Every key and its value is then judged the same way
// whatever quoting or punctuation joins them: `K=v`, `"K=v"`, `"K": "v"`,
// `K: v`, `--k=v`, `--k v`.
//
// What it cannot catch: a bare opaque value with no key, scheme or known
// prefix in front of it, and a value under more than one layer of encoding.
// It knows forms, not secrets.

const marker = "[REDACTED]"

const keyPairs = new RegExp(String.raw`(?<![\p{L}\p{N}_.\-])(-{1,2})?(["'\x60]?)([A-Za-z_][A-Za-z0-9_.\-]*)(["'\x60]?)(?=(\s*[=:]\s*|\s+)(["'\x60]?)([^\s"'\x60,;}&|)]*))`, "gu")
const sensitiveParts = ["apikey", "accesskey", "privatekey", "sessionkey", "token", "password", "passwd", "secret", "credential", "cookie", "authorization"]
// A key that names where a secret lives, or counts something, rather than
// holding it: --token-file, --api-key-env, --max-tokens.
const pointerSuffixes = ["file", "path", "dir", "env", "name", "type", "helper", "command", "cmd", "url", "tokens", "tokenizer", "count", "limit", "length", "size"]
const schemes = new Set(["bearer", "basic", "token", "digest"])

function isSensitive(key: string): boolean {
  const flat = key.toLowerCase().replace(/[-_.]/gu, "")
  if (flat === "auth" || flat === "pat") return true
  return sensitiveParts.some((part) => flat.includes(part)) && !pointerSuffixes.some((suffix) => flat.endsWith(suffix))
}

// A value after a sensitive key is a credential unless it is the marker alone.
const redacted = (value: string) => value === marker

function pairHoldsValue(flag: string, quoteAfterKey: string, key: string, separator: string, value: string, assignmentStart: boolean): boolean {
  if (value === "") return false
  const joinedBy = separator.trim()
  const envName = /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
  if (joinedBy === "") {
    // `--key value`: only a flag takes the next word as its value.
    return flag !== "" && isSensitive(key) && !value.startsWith("-") && !redacted(value)
  }
  if (isSensitive(key)) {
    // `Authorization: Bearer ...` names a scheme; the scheme rule judges its token.
    if (key.toLowerCase() === "authorization" && schemes.has(value.toLowerCase())) return false
    return !redacted(value)
  }
  // A shell assignment starts a word: node /tmp/config=dev/index.js has none.
  if (joinedBy === "=") return flag === "" && envName && assignmentStart && !redacted(value)
  // `"K": v` and `K_NAME: v`: an environment-style name as a JSON or YAML key.
  // Unquoted, it needs an underscore, so an error code such as `EACCES: ...`
  // stays readable.
  const environmentStyle = /^[A-Z_][A-Z0-9_]+$/u.test(key)
  const keyForm = quoteAfterKey !== "" || (/\s$/u.test(separator) && key.includes("_"))
  return environmentStyle && keyForm && !redacted(value)
}

// An authorization scheme and the word after it, not a flag such as --digest.
// Any value is a credential but the marker and a few words prose uses there.
const schemeValues = /(?<![\p{L}\p{N}_-])(?:Bearer|Basic|Token|Digest)\s+["'\x60]?([^\s"'\x60,;)]+)/giu
const schemeProse = new Set(["authentication", "authorization", "auth", "token", "tokens", "header", "headers", "scheme", "schemes", "credentials"])
const schemeCredential = (value: string) => !redacted(value) && !schemeProse.has(value.toLowerCase())

const shapes: readonly RegExp[] = [
  // Any user info in a URL authority, with or without a password.
  /:\/\/(?!\[REDACTED\]@)[^\s/?#@]+@/u,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/u,
  /\b(?:sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
]

// The text as the shell assembles its words: adjacent quoted and unquoted
// parts joined, backslash escapes taken, and $'...' decoded (\xHH, \nnn octal,
// \uHHHH, \UHHHHHHHH). Words are joined by one space. An unclosed quote runs to
// the end.
function shellWords(text: string): string {
  const words: string[] = []
  let word = ""
  let inWord = false
  let index = 0
  const take = (part: string) => { word += part; inWord = true }
  while (index < text.length) {
    const character = text[index]!
    if (/\s/u.test(character)) {
      if (inWord) words.push(word)
      word = ""
      inWord = false
      index += 1
    } else if (character === "\\") {
      take(text[index + 1] ?? "")
      index += 2
    } else if (character === "'") {
      const end = text.indexOf("'", index + 1)
      const close = end === -1 ? text.length : end
      take(text.slice(index + 1, close))
      index = close + 1
    } else if (character === "$" && text[index + 1] === "'") {
      index += 2
      let part = ""
      while (index < text.length && text[index] !== "'") {
        if (text[index] !== "\\") {
          part += text[index]
          index += 1
          continue
        }
        // A lone backslash at the end escapes nothing.
        const escape = /^\\(?:x([0-9A-Fa-f]{1,2})|([0-7]{1,3})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|(.))/su.exec(text.slice(index)) ?? ["\\"]
        const [whole, hex, octal, short, long, other] = escape
        const code = hex ?? short ?? long
        part += code !== undefined ? String.fromCodePoint(Math.min(Number.parseInt(code, 16), 0x10ffff))
          : octal !== undefined ? String.fromCharCode(Number.parseInt(octal, 8) & 0xff)
          : other ?? ""
        index += whole.length
      }
      take(part)
      index += 1
    } else if (character === "\"" || (character === "$" && text[index + 1] === "\"")) {
      index += character === "$" ? 2 : 1
      let part = ""
      while (index < text.length && text[index] !== "\"") {
        if (text[index] === "\\" && /[$`"\\]/u.test(text[index + 1] ?? "")) index += 1
        part += text[index] ?? ""
        index += 1
      }
      take(part)
      index += 1
    } else {
      take(character)
      index += 1
    }
  }
  if (inWord) words.push(word)
  return words.join(" ")
}

function decoded(value: string): string[] {
  const percent = value.replace(/%([0-9A-Fa-f]{2})/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
  const unescape = (text: string) => text
    .replace(/\\u([0-9A-Fa-f]{4})/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\(.)/gu, "$1")
  return [...new Set([value, percent, unescape(value), unescape(percent), shellWords(value), shellWords(percent)])]
}

export function holdsCredential(value: string): boolean {
  return decoded(value).some((view) => {
    if (shapes.some((shape) => shape.test(view))) return true
    for (const [, schemeValue = ""] of view.matchAll(schemeValues)) if (schemeCredential(schemeValue)) return true
    for (const match of view.matchAll(keyPairs)) {
      const [, flag = "", , key = "", quoteAfterKey = "", separator = "", , pairValue = ""] = match
      const assignmentStart = match.index === 0 || /[\s(;&|`]/u.test(view[match.index - 1]!)
      if (pairHoldsValue(flag, quoteAfterKey, key, separator, pairValue, assignmentStart)) return true
    }
    return false
  })
}
