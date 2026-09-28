// A best-effort backup for text a provider's own file supplied. It is not the
// guarantee: the daemon's reader is, and it redacts before it emits, cutting
// each text before the first assignment, sensitive key or flag, authorization
// scheme or credential shape it reads there, in these same views with these
// same rules. This check does not redact. It refuses text that still carries
// such a value in a form it recognises, so a reader that missed one fails
// instead of leaking. A value in a form it does not recognise passes.
//
// Each text is read as sent, after one layer of percent, backslash and \u
// decoding, as the shell assembles its words (quotes joined, $'...' escapes
// decoded), and as its double-quoted strings alone (a JSON argv). Every key and
// its value is then judged the same way whatever quoting or punctuation joins
// them: `K=v`, `"K=v"`, `"K": "v"`, `K: v`, `--k=v`, `--k v`.
//
// What it cannot catch: a bare opaque value with no key, scheme or known
// prefix in front of it, and a value under more than one layer of encoding.
// It knows forms, not secrets.

const marker = "[REDACTED]"

// The words this check reads a credential by. The daemon's reader takes them
// from here, not a copy, so a rule added here is one it acts on too.
export interface CredentialRules {
  // Authorization schemes, in lower case: the word after one is its credential.
  readonly schemeWords: readonly string[]
  // A key whose flattened name (lower case, no `-`, `_` or `.`) holds one of
  // these holds a credential: --api-key, X-Api-Token, client_secret.
  readonly keyParts: readonly string[]
  // Flattened keys that hold one only as the whole name: --auth, --pat.
  readonly exactKeys: readonly string[]
  // A key that names where a secret lives, or counts something, rather than
  // holding it: --token-file, --api-key-env, --max-tokens.
  readonly pointerSuffixes: readonly string[]
  // Known token prefixes, each read before a `-` or `_` and eight or more
  // token characters: sk-..., ghp_..., xoxb-....
  readonly tokenPrefixes: readonly string[]
}

const frozenList = (words: readonly string[]): readonly string[] => Object.freeze([...words])
export const credentialRules: CredentialRules = Object.freeze({
  schemeWords: frozenList(["bearer", "basic", "token", "digest"]),
  keyParts: frozenList(["apikey", "accesskey", "privatekey", "sessionkey", "token", "password", "passwd", "secret", "credential", "cookie", "authorization"]),
  exactKeys: frozenList(["auth", "pat"]),
  pointerSuffixes: frozenList(["file", "path", "dir", "env", "name", "type", "helper", "command", "cmd", "url", "tokens", "tokenizer", "count", "limit", "length", "size"]),
  tokenPrefixes: frozenList(["sk", "ghp", "gho", "github_pat", "xoxb", "xoxa", "xoxp", "xoxr", "xoxs"]),
})

const keyPairs = new RegExp(String.raw`(?<![\p{L}\p{N}_.\-])(-{1,2})?(["'\x60]?)([A-Za-z_][A-Za-z0-9_.\-]*)(["'\x60]?)(?=(\s*[=:]\s*|\s+)(["'\x60]?)([^\s"'\x60,;}&|)]*))`, "gu")
const schemes = new Set(credentialRules.schemeWords)

// Whether a key names a credential by `rules` (these rules unless others are
// given): a flag, a JSON or YAML key, a header name or an assignment's name.
export function isCredentialKey(key: string, rules: CredentialRules = credentialRules): boolean {
  const flat = key.toLowerCase().replace(/[-_.]/gu, "")
  if (rules.exactKeys.includes(flat)) return true
  return rules.keyParts.some((part) => flat.includes(part)) && !rules.pointerSuffixes.some((suffix) => flat.endsWith(suffix))
}
const isSensitive = (key: string) => isCredentialKey(key)

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
// The word after the value is looked at too: a scheme word that opens a line
// of prose ("Token limit exceeded") is not a header, unless an Authorization
// key comes right before it.
// The Authorization key is part of the same match, so each scheme is judged in
// one pass rather than by rescanning the text before it.
// Words as a pattern's alternatives, each read literally.
const alternatives = (words: readonly string[]) => words.map((word) => word.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&")).join("|")
const schemeValues = new RegExp(
  String.raw`(?:(authorization["'\x60]?\s*[=:]\s*["'\x60]?)|(?<![\p{L}\p{N}_-]))(?:${alternatives(credentialRules.schemeWords)})\s+["'\x60]?([^\s"'\x60,;)]+)(?=(?:\s+([^\s"'\x60,;)]+))?)`,
  "giu",
)
// A word of prose, with the punctuation a sentence puts after it.
const sentenceEnd = new Set([".", ",", ";", ":", "!", "?", "\"", "'", "\x60", ")", "]", "}", "\u2019", "\u201d", "\u00bb"])
// Drop the punctuation a sentence ends with, reading each character from the
// end once. A pattern anchored only at the end would restart at every
// position of a long punctuation run.
function withoutSentenceEnd(value: string): string {
  let end = value.length
  while (end > 0 && sentenceEnd.has(value[end - 1]!)) end -= 1
  return value.slice(0, end)
}
const proseWord = /^\p{L}+[.,;:!?"'\x60)\]}\u2019\u201d\u00bb]*$/u
const schemeProse = new Set(["authentication", "authorization", "auth", "token", "tokens", "header", "headers", "scheme", "schemes", "credentials"])
const schemeCredential = (value: string) => !redacted(value) && !schemeProse.has(value.toLowerCase())

// Credentials known by their shape alone, each found where its credential
// starts. Every search reads the text in work that grows linearly with it, so
// the daemon's reader can search a whole file's text with them.
const shapePatterns: readonly RegExp[] = [
  // Any user info in a URL authority, with or without a password: found
  // after the `://`, where the user info starts.
  /(?<=:\/\/)(?!\[REDACTED\]@)[^\s/?#@]+@/u,
  new RegExp(String.raw`\b(?:${alternatives(credentialRules.tokenPrefixes)})[-_][A-Za-z0-9_-]{8,}`, "u"),
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
]

// A JSON Web Token: `eyJ` at a word start, then three runs of base64url
// characters, at least 5, 6 and 6 long, joined by dots. Each run is read to
// its end once. A regular expression tries every `eyJ` of one long run again
// to that run's end, which a run with no dot after it makes quadratic; every
// `eyJ` before a run's end ends its first part there too, and fails the same
// way, so the search goes on from there.
const base64urlCharacter = /[A-Za-z0-9_-]/u
const wordCharacter = /\w/u
function base64urlRunEnd(text: string, start: number): number {
  let end = start
  while (end < text.length && base64urlCharacter.test(text[end]!)) end += 1
  return end
}
function jsonWebTokenAt(text: string): number | undefined {
  let from = 0
  for (let at = text.indexOf("eyJ", from); at !== -1; at = text.indexOf("eyJ", from)) {
    if (at > 0 && wordCharacter.test(text[at - 1]!)) {
      from = at + 1
      continue
    }
    const first = base64urlRunEnd(text, at + 3)
    from = first
    if (first - at - 3 < 5 || text[first] !== ".") continue
    const second = base64urlRunEnd(text, first + 1)
    if (second - first - 1 < 6 || text[second] !== ".") continue
    if (base64urlRunEnd(text, second + 1) - second - 1 >= 6) return at
  }
  return undefined
}

// Where the first credential known by its shape starts in `text`, or
// undefined when it holds none.
export function credentialShapeAt(text: string): number | undefined {
  let first = jsonWebTokenAt(text)
  for (const pattern of shapePatterns) {
    const match = pattern.exec(text)
    if (match !== null && (first === undefined || match.index < first)) first = match.index
  }
  return first
}

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
  // A JSON argv's strings as separate words: ["--api-key","x"] is --api-key x.
  // One forward pass: a backslash escapes the next character, and a string
  // left unclosed ends the reading, since every later quote is unclosed too.
  const quotedStrings = (text: string) => {
    const strings: string[] = []
    let open = text.indexOf("\"")
    while (open !== -1) {
      let end = open + 1
      while (end < text.length && text[end] !== "\"") end += text[end] === "\\" ? 2 : 1
      if (end >= text.length) break
      strings.push(unescape(text.slice(open + 1, end)))
      open = text.indexOf("\"", end + 1)
    }
    return strings.join(" ")
  }
  return [...new Set([value, percent, unescape(value), unescape(percent), shellWords(value), shellWords(percent), quotedStrings(value), quotedStrings(percent)])]
}

export function holdsCredential(value: string): boolean {
  return decoded(value).some((view) => {
    if (credentialShapeAt(view) !== undefined) return true
    for (const match of view.matchAll(schemeValues)) {
      const [, authorizationKey, schemeValue = "", nextWord] = match
      const header = authorizationKey !== undefined
      const prose = !header && proseWord.test(schemeValue) && nextWord !== undefined && proseWord.test(nextWord)
      // The marker, alone or ending a sentence, is judged before anything is
      // trimmed from it: trimming would take its closing bracket.
      if (schemeValue.startsWith(marker) && withoutSentenceEnd(schemeValue.slice(marker.length)) === "") continue
      // Outside a header, a known prose word may end a sentence: "Bearer token."
      // Punctuation alone ("Bearer ...") leaves no word, which is prose.
      const word = header ? schemeValue : withoutSentenceEnd(schemeValue)
      if (word === "") continue
      if (!prose && schemeCredential(word)) return true
    }
    for (const match of view.matchAll(keyPairs)) {
      const [, flag = "", , key = "", quoteAfterKey = "", separator = "", , pairValue = ""] = match
      // A word starts at the text's start, after a separator, or after a
      // redirection such as a here-string (<<<NAME=value); not inside a path.
      const assignmentStart = match.index === 0 || /[\s(;&|`<]/u.test(view[match.index - 1]!)
      if (pairHoldsValue(flag, quoteAfterKey, key, separator, pairValue, assignmentStart)) return true
    }
    return false
  })
}
