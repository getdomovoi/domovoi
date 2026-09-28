// Redaction for the text a repository's provider files supply to the tool
// inventory: hook and server commands, rules and names. This is the guarantee;
// the protocol's credential backstop behind it only refuses forms it knows, and
// an entry it still refuses is dropped and counted by the reader.
//
// The text is read the way a POSIX shell reads it: into words, each with its
// value after quote removal and backslash escapes, and operators between them.
// Every decision is made on those values, so no quoting or escaping can move a
// secret out of the word a rule redacts. Every `NAME=value` at a word start,
// every value after a sensitive key, flag or authorization scheme, every
// header value after a header flag whatever the header is called (the next
// word too, when a header word ends at an unquoted colon, and the whole
// argument when one with a colon does not read as a header), every URL path
// after the host (in whole), every URL query and fragment part (a bare part
// with no equals sign in whole), and all URL user info become [REDACTED]. A
// header value that opens with an authorization scheme keeps the scheme word,
// as a bare `Bearer x` does. A scheme or flag word inside a value another
// rule hides or reads past (a URL, a header's value, a shell's script) is
// still read as one, so its own value is hidden too: `--token Bearer x` reads
// `--token [REDACTED] [REDACTED]`, and `--token 'https://h/ Token' x` reads
// `--token '[REDACTED]' [REDACTED]`. When such a word's value is in its own
// shell word and the rule that took that word did not hide all of it (a URL
// keeps its host and each query name, a header keeps its name and a scheme
// word), the word is hidden from that scheme word, key or flag to its end:
// `'https://host Token x y'` reads `'https://host [REDACTED]'`. A scheme word
// or flag starts where the protocol backstop reads one, after a `/`, `?` or
// `#` too, and its value starts after one opening quote, as there. The text
// is read in the backstop's other views as well (one layer of percent
// decoding, backslash and \u escapes, the shell words of the percent-decoded
// text, a JSON argv's double-quoted strings): a scheme word or key read only
// in one (`%54oken x y`, `Token%20x y`, `api%5fkey=x`) is mapped back to the
// text it was read from and its value hidden as above, its word from the
// trigger to its end when the value is in the same word. Every output is then
// judged as the backstop judges scheme and key values, in all its views, and
// one it would still refuse is cut before the token it reads the trigger in,
// the rest the marker. Every rule reads the text in work that grows linearly with it. The daemon's durable-text redaction leaves
// `DATABASE_URL=x`, `https://tok@host` and `Bearer tok` alone, so this pass is
// separate from it.
//
// A word no rule changes keeps its exact source text. A changed word keeps
// its source up to the first character a rule changed and writes the rest in
// the quoting that character was in, closed again, so the output always reads
// back as the same words and a second pass changes nothing. Unquoted, the rest
// is single-quoted from its first character the shell reads specially. This
// reader does not model pathname patterns (`*`, `?`, `[`) or brace expansion
// (`{a,b}`), which turn one word into several or none. In a command line a
// shell runs (a hook's or helper's command, any argument vector), each
// unquoted one is escaped with a backslash where source text is kept, and a
// rewritten rest is single-quoted from it. A rule, matcher, name, prompt or
// URL is not run by a shell and keeps its `*` as written. The output is read
// again, and text that does not read back as the words meant, or a command
// that still holds such a character unquoted, is redacted whole. The protocol refuses a
// control or format character anywhere in a text (a newline, a tab, a
// backslash and newline), and drops the entry with it, so the text is redacted
// from the word or gap that would carry one to the end. The script given
// to `sh -c` (bash, zsh and the rest, `-lc` included) is read as words in turn,
// to a bounded depth. It errs toward redacting: a value inside a quoted string
// runs to the string's end, and inside a script given to a shell it runs to
// the script's end, so `sh -c 'A=1 run'` reads `sh -c 'A=[REDACTED]'`.
//
// Text that does not read as shell words (an unclosed quote, `$(...)`,
// backquotes, `<(...)`, `>(...)`, `=(...)`, a `${...}` with an operator,
// `$'...'`, a here-document) is redacted from the word where reading stopped
// to the end of the text.
//
// Every output fits the protocol's cap on the field it fills: when it would
// not, whole words are kept while they fit and the rest is redacted.

import {
  maximumToolInventoryCommandLength,
  maximumToolInventoryDetailLength,
  maximumToolInventoryEventLength,
  maximumToolInventoryHelperNameLength,
  maximumToolInventoryMatcherLength,
  maximumToolInventoryNameLength,
  maximumToolInventoryRuleLength,
} from "@getdomovoi/protocol"

const marker = "[REDACTED]"

// The protocol's cap on each inventory text field, in UTF-16 code units, which
// it refuses a longer text for: the caps the protocol exports and holds
// toolInventoryEntrySchema's fields to, named by the field each one fills.
// Redaction can write a longer text than it read (a backslash before a
// pattern character, quotes around an argument, the marker after a short
// value), so every output is fitted to its field's cap: whole words are kept
// while they fit and the rest is hidden behind the marker. An entry the
// protocol would take before redaction is never dropped for it.
export const inventoryFieldCaps = {
  // A hook's, helper's or local tool server's command.
  command: maximumToolInventoryCommandLength,
  // A permission rule's detail.
  detail: maximumToolInventoryDetailLength,
  // A hook's matcher.
  matcher: maximumToolInventoryMatcherLength,
  // A tool server's, plugin's or skill's name.
  name: maximumToolInventoryNameLength,
  // A helper's name.
  helperName: maximumToolInventoryHelperNameLength,
  // A permission rule's rule.
  rule: maximumToolInventoryRuleLength,
  // A hook's event.
  event: maximumToolInventoryEventLength,
} as const

// What the protocol refuses in any text: control and format characters and
// line and paragraph separators.
const controlCharacter = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

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

const wordBoundary = /[\s(;&|`<"'{]/u
const keyPair = /(-{1,2})?(["'`]?)([A-Za-z_][A-Za-z0-9_.-]*)\2(\s*[=:]\s*|\s+)/uy
const urlStart = /[A-Za-z][A-Za-z0-9+.-]*:\/\//uy
const scheme = /(?:Bearer|Basic|Token|Digest)\s+/iuy
const schemeWord = /(?:Bearer|Basic|Token|Digest)/iuy
// A scheme word starts wherever the protocol backstop reads one: after
// anything but a letter, digit, underscore or hyphen, so `?Bearer x` in a
// URL's query is one too.
const schemeBoundary = /[\p{L}\p{N}_-]/u
// What ends a key's value as the protocol backstop reads it.
const valueStop = /[\s"'`,;}&|)]/u
// A private key's header, and the footer that ends it.
const privateKeyHeader = /-----BEGIN [A-Z ]*PRIVATE KEY-----/uy
const privateKeyFooter = /-----END [A-Z ]*PRIVATE KEY-----/gu
const privateKeyShape = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu
// Shapes after a JSON Web Token, which withoutJsonWebTokens finds.
const tokenShapes: readonly RegExp[] = [
  /\b(?:sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/gu,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
]

// Flags that take a whole `Name: value` header line: curl's -H, --header and
// --proxy-header, and wget's --header. -H can hold its value in the same word.
const headerFlag = /(-H|--header|--proxy-header)(=|\s+)?/uy
// A field name is an RFC 9110 token, apostrophe and backtick included. The
// double quote is not a token character, but an argument can hold a quoted
// name (`"X-Foo":value`), so it is accepted too. Names are matched on a word's
// value, after the shell has removed its quotes and escapes.
// An argument reads as a header line (`Name: value`) when a name, blanks, a
// colon, blanks and a value make all of it; one that ends at its colon
// (`-H X-Foo: secret`) leaves the value in the next word.
const headerNameCharacter = /[A-Za-z0-9!#$%&'"*+.^_`|~-]/u

// Shells whose `-c` option takes a script, read as words in turn. A script
// nested deeper than this is redacted whole.
const shells = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "yash"])
const maximumDepth = 4

function isMarker(value: string): boolean {
  return value === marker || value === `"${marker}"` || value === `'${marker}'`
}

function redactKnownShapes(text: string): string {
  return tokenShapes.reduce((redacted, shape) => redacted.replace(shape, marker), withoutJsonWebTokens(text.replace(privateKeyShape, marker)))
}

// A JSON Web Token: `eyJ` at a word start, then three runs of base64url
// characters, at least 5, 6 and 6 long, joined by dots. Each run is read to
// its end once. A regular expression tried every `eyJ` in one long run again
// to that run's end, which a run with no dot after it made quadratic; every
// `eyJ` before a run's end ends its first part there too, and fails the same
// way, so the search goes on from there.
const base64urlCharacter = /[A-Za-z0-9_-]/u
function base64urlRunEnd(text: string, start: number): number {
  let end = start
  while (end < text.length && base64urlCharacter.test(text[end]!)) end += 1
  return end
}
function withoutJsonWebTokens(text: string): string {
  const pieces: string[] = []
  let copied = 0
  let from = 0
  for (let at = text.indexOf("eyJ", from); at !== -1; at = text.indexOf("eyJ", from)) {
    if (at > 0 && /\w/u.test(text[at - 1]!)) {
      from = at + 1
      continue
    }
    const first = base64urlRunEnd(text, at + 3)
    from = first
    if (first - at - 3 < 5 || text[first] !== ".") continue
    const second = base64urlRunEnd(text, first + 1)
    if (second - first - 1 < 6 || text[second] !== ".") continue
    const third = base64urlRunEnd(text, second + 1)
    if (third - second - 1 < 6) continue
    pieces.push(text.slice(copied, at), marker)
    copied = third
    from = third
  }
  if (pieces.length === 0) return text
  pieces.push(text.slice(copied))
  return pieces.join("")
}

// A span of text and what it is written as instead.
interface Change { start: number; end: number; text: string }

// A query or fragment starting at `offset` in its URL: each `name=value` part
// keeps its name, and a bare part is a value in whole, since `?opaque` or
// `#opaque` can be the token itself.
function urlPartHides(payload: string, offset: number, hides: Change[]): void {
  let partStart = 0
  for (let index = 0; index <= payload.length; index += 1) {
    if (index < payload.length && payload[index] !== "&" && payload[index] !== ";") continue
    const part = payload.slice(partStart, index)
    if (part !== "" && !isMarker(part)) {
      const equals = part.indexOf("=")
      const value = part.slice(equals + 1)
      if (equals === -1) hides.push({ start: offset + partStart, end: offset + index, text: marker })
      else if (value !== "" && !isMarker(value)) hides.push({ start: offset + partStart + equals + 1, end: offset + index, text: marker })
    }
    partStart = index + 1
  }
}

// What a URL hides, in order: its user info, its whole path after the host,
// and every query and fragment part. A path can be the credential itself (a
// webhook's /services/T0/B0/XXXX) and no rule tells which segment is, so the
// path goes whole; an empty path or a bare `/` stays. What it keeps (the
// scheme, the host, a part's name) is kept as written.
function urlHides(url: string): Change[] {
  const hides: Change[] = []
  const authorityStart = url.indexOf("://") + 3
  const authorityEnd = url.slice(authorityStart).search(/[/?#]/u)
  const authorityStop = authorityEnd === -1 ? url.length : authorityStart + authorityEnd
  const at = url.slice(authorityStart, authorityStop).lastIndexOf("@")
  if (at !== -1) hides.push({ start: authorityStart, end: authorityStart + at, text: marker })
  const rest = url.slice(authorityStop)
  const hash = rest.indexOf("#")
  const beforeHash = hash === -1 ? rest : rest.slice(0, hash)
  const question = beforeHash.indexOf("?")
  const givenPath = question === -1 ? beforeHash : beforeHash.slice(0, question)
  if (givenPath !== "" && givenPath !== "/") hides.push({ start: authorityStop, end: authorityStop + givenPath.length, text: `/${marker}` })
  if (question !== -1) urlPartHides(beforeHash.slice(question + 1), authorityStop + question + 1, hides)
  if (hash !== -1) urlPartHides(rest.slice(hash + 1), authorityStop + hash + 1, hides)
  return hides
}

// A URL written with what it hides, up to `cut`: from there the rest is the
// marker. A cut inside a hidden span ends with that span's marker.
function writtenUrl(url: string, hides: readonly Change[], cut = Number.POSITIVE_INFINITY): string {
  const pieces: string[] = []
  let cursor = 0
  for (const hide of hides) {
    if (hide.start >= cut) break
    pieces.push(url.slice(cursor, hide.start), hide.text)
    cursor = hide.end
    if (cursor > cut) return pieces.join("")
  }
  if (cut === Number.POSITIVE_INFINITY) return `${pieces.join("")}${url.slice(cursor)}`
  const kept = `${pieces.join("")}${url.slice(cursor, cut)}`
  return kept.endsWith(marker) ? kept : `${kept}${marker}`
}

// The quoting a character of a word's value was written in: none, single or
// double quotes.
type Quoting = "" | "'" | "\""

// One character of a word's value: its quoting and where its spelling starts
// in the source. The characters of one `${...}` share a spelling. The first
// character of a quoted run notes where its opening quote is.
interface Character { quoting: Quoting; source: number; opens?: number }

interface Word { kind: "word"; start: number; end: number; value: string; characters: Character[] }
interface Operator { kind: "operator"; start: number; end: number; value: string }
type Token = Word | Operator

// The tokens read, and where reading stopped when the text is not shell words.
interface Lexed { tokens: Token[]; stoppedAt?: number }

const blank = /[ \t\r\f\v]/u
const wordStop = /[ \t\r\f\v\n;&|<>()]/u
// Longest first, so `&&` is read before `&`.
const operators = ["&&", "||", ";;", "|&", ">>", ">&", ">|", "<&", "<>", "&", "|", ";", "<", ">", "(", ")", "\n"]

function lexShell(text: string): Lexed {
  const tokens: Token[] = []
  let index = 0
  while (index < text.length) {
    if (blank.test(text[index]!)) index += 1
    else if (text.startsWith("\\\n", index)) index += 2
    // A here-document's body is not words.
    else if (text.startsWith("<<", index)) return { tokens, stoppedAt: index }
    else {
      const operator = operators.find((candidate) => text.startsWith(candidate, index))
      // `<(...)` and `>(...)` run a command, and so does zsh's `=(...)`; an
      // array (`A=(...)`) is not read as words either. Reading stops there, at
      // the word the `=` ends.
      if (operator !== undefined && /[<>]$/u.test(operator) && text[index + operator.length] === "(") return { tokens, stoppedAt: index }
      const previous = tokens.at(-1)
      if (operator === "(" && previous?.kind === "word" && previous.end === index && text[index - 1] === "=") {
        tokens.pop()
        return { tokens, stoppedAt: previous.start }
      }
      if (operator !== undefined) {
        tokens.push({ kind: "operator", start: index, end: index + operator.length, value: operator })
        index += operator.length
        continue
      }
      const word = wordAt(text, index)
      if (!word) return { tokens, stoppedAt: index }
      tokens.push(word)
      index = word.end
    }
  }
  return { tokens }
}

// A `${...}` with no operator, and so no operand: a name, a positional
// parameter or a special parameter.
const bareParameter = /\$\{(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])\}/uy

// The end of a `$` expansion at `index`, read as literal text, or undefined
// when it runs a command (`$(`) or is not POSIX quoting (`$'...'`, `$"..."`).
// A `${...}` is read only when it is bare: an operator's operand (`-`, `+`,
// `?`, `=`, `#`, `%`, `/`, `^`, `,`, `@` and the `:` forms) is shell text
// that can hold a value, and this lexer does not model it.
function expansionEnd(text: string, index: number, quoting: Quoting): number | undefined {
  const next = text[index + 1]
  if (next === "(") return undefined
  if (quoting === "" && (next === "'" || next === "\"")) return undefined
  if (next !== "{") return index + 1
  bareParameter.lastIndex = index
  return bareParameter.test(text) ? bareParameter.lastIndex : undefined
}

// The shell word at `start`, or undefined when it does not read as one.
function wordAt(text: string, start: number): Word | undefined {
  let value = ""
  const characters: Character[] = []
  let opening: number | undefined
  const add = (piece: string, quoting: Quoting, source: number) => {
    value += piece
    for (let index = 0; index < piece.length; index += 1) {
      characters.push(opening === undefined ? { quoting, source } : { quoting, source, opens: opening })
      opening = undefined
    }
  }
  let index = start
  while (index < text.length && !wordStop.test(text[index]!)) {
    const character = text[index]!
    if (character === "'") {
      const close = text.indexOf("'", index + 1)
      if (close === -1) return undefined
      opening = index
      for (let inner = index + 1; inner < close; inner += 1) add(text[inner]!, "'", inner)
      opening = undefined
      index = close + 1
    } else if (character === "\"") {
      opening = index
      const end = doubleQuotedEnd(text, index, add)
      opening = undefined
      if (end === undefined) return undefined
      index = end
    } else if (character === "\\") {
      const next = text[index + 1]
      if (next === undefined) {
        add("\\", "", index)
        index += 1
      } else {
        // A backslash and newline join two lines; any other character is literal.
        if (next !== "\n") add(next, "", index)
        index += 2
      }
    } else if (character === "`") return undefined
    else if (character === "$") {
      const end = expansionEnd(text, index, "")
      if (end === undefined) return undefined
      add(text.slice(index, end), "", index)
      index = end
    } else {
      add(character, "", index)
      index += 1
    }
  }
  return { kind: "word", start, end: index, value, characters }
}

// A double-quoted string opening at `open`: its characters are added, and the
// index past its closing quote returned. A backslash escapes only $ ` " \ and
// a newline there; before anything else it is itself literal.
function doubleQuotedEnd(text: string, open: number, add: (piece: string, quoting: Quoting, source: number) => void): number | undefined {
  let index = open + 1
  while (index < text.length) {
    const character = text[index]!
    if (character === "\"") return index + 1
    if (character === "`") return undefined
    if (character === "\\") {
      const next = text[index + 1]
      if (next !== undefined && "$`\"\\\n".includes(next)) {
        if (next !== "\n") add(next, "\"", index)
        index += 2
      } else {
        add("\\", "\"", index)
        index += 1
      }
    } else if (character === "$") {
      const end = expansionEnd(text, index, "\"")
      if (end === undefined) return undefined
      add(text.slice(index, end), "\"", index)
      index = end
    } else {
      add(character, "\"", index)
      index += 1
    }
  }
  return undefined
}

// Text written inside `quoting` and closed, reading back as `text`. A single
// quote inside single quotes is written '"'"' rather than '\'', whose
// backslash the protocol backstop reads as a value after a key. Unquoted,
// text is single-quoted from its first character the shell treats specially,
// operators a URL was read through (`&`, `;`, `|`) included, so it stays one
// word; the plain text before that stays bare, so a quote never opens between
// a URL's `://` and its user info. In a command, a pattern character (`?`,
// `[`) is not plain either; the marker is, as it is this pass's own text.
const plainCharacter = /[A-Za-z0-9_@%+=:,./[\]?#~!^-]/u
const plainCommandCharacter = /[A-Za-z0-9_@%+=:,./\]#~!^-]/u
const singleQuoted = (text: string) => text.replace(/'/gu, "'\"'\"'")
// Inside double quotes a character escaped right after the marker is
// single-quoted between two double-quoted runs instead: the protocol backstop
// reads `[REDACTED]\"` after a scheme word or sensitive key as a value that is
// not the marker.
const doubleQuoted = (text: string) => text.replace(/[\\"$`]/gu, (character: string, at: number) => (text.endsWith(marker, at) ? `"'${character}'"` : `\\${character}`))
function spelled(text: string, quoting: Quoting, wordStart: boolean, command: boolean): string {
  if (quoting === "\"") return `${doubleQuoted(text)}"`
  if (quoting === "'") return `${singleQuoted(text)}'`
  const plainAt = (index: number) => (command ? plainCommandCharacter : plainCharacter).test(text[index]!)
  let plain = 0
  while (plain < text.length) {
    if (text.startsWith(marker, plain)) plain += marker.length
    else if (plainAt(plain) && !(wordStart && plain === 0 && /[#~]/u.test(text[0]!))) plain += 1
    else break
  }
  return plain === text.length ? text : `${text.slice(0, plain)}'${singleQuoted(text.slice(plain))}'`
}

// The source index of each character of a word the shell would expand as a
// pathname pattern or a brace expansion: written bare (not quoted, escaped or
// part of a `$` expansion) and not inside the marker. `$?`, `$*` and `$[`
// belong to their `$`; a `[` or `[[` word is the test command; a `{` expands
// only with a `,` or `..` and a `}` after it.
function expandingSources(text: string, word: Word): number[] {
  const { value, characters } = word
  const exempt = new Set<number>()
  for (let at = value.indexOf(marker); at !== -1; at = value.indexOf(marker, at + marker.length)) {
    for (let offset = 0; offset < marker.length; offset += 1) exempt.add(at + offset)
  }
  const bare = (index: number) => characters[index]?.quoting === "" && text[characters[index]!.source] === value[index]
  // Whether a `,` or `..` with a `}` after it comes at or after each index,
  // read once from the end on the first `{`: searching the rest of the word
  // for each `{` made a long run of them quadratic.
  let expandsFrom: Uint8Array | undefined
  const expandsAfter = (index: number) => {
    if (expandsFrom === undefined) {
      const closesFrom = new Uint8Array(value.length + 2)
      expandsFrom = new Uint8Array(value.length + 1)
      for (let at = value.length - 1; at >= 0; at -= 1) {
        closesFrom[at] = value[at] === "}" ? 1 : closesFrom[at + 1]!
        const separates = (value[at] === "," && closesFrom[at + 1] === 1) || (value[at] === "." && value[at + 1] === "." && closesFrom[at + 2] === 1)
        expandsFrom[at] = separates ? 1 : expandsFrom[at + 1]!
      }
    }
    return expandsFrom[index + 1] === 1
  }
  const sources: number[] = []
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    if (!"*?[{".includes(character) || exempt.has(index) || !bare(index)) continue
    if (index > 0 && value[index - 1] === "$" && bare(index - 1) && characters[index - 1]!.source === characters[index]!.source - 1) continue
    if (character === "[" && (value === "[" || value === "[[")) continue
    if (character === "{" && !expandsAfter(index)) continue
    sources.push(characters[index]!.source)
  }
  return sources
}

// A word's source from its start to `end`. In a command, a backslash goes
// before each character the shell would expand, so it reads as the same word;
// other text (a rule, a matcher, a name) keeps its exact source.
function sourceSpelling(text: string, word: Word, end: number, command: boolean, start = word.start): string {
  if (!command) return text.slice(start, end)
  let spelling = ""
  let cursor = start
  for (const source of expandingSources(text, word)) {
    if (source < start) continue
    if (source >= end) break
    spelling += `${text.slice(cursor, source)}\\`
    cursor = source
  }
  return `${spelling}${text.slice(cursor, end)}`
}

// An argument shown as one shell word that reads back as itself: bare when
// every character is plain, otherwise single-quoted whole.
function argumentWord(word: string): string {
  return word !== "" && spelled(word, "", true, true) === word ? word : `'${singleQuoted(word)}'`
}

function commonPrefix(left: string, right: string): number {
  let index = 0
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1
  return index
}

// A word with its value replaced: its source up to `anchor` (or to the first
// changed character, if that is earlier), then the rest of the value written
// in the quoting of the character there, closed again. Inside a shell's
// script, a rewrite that starts a quoted run is written before its opening
// quote instead: the script is quoted again in the word around it, and an
// escaped quote between a key and its [REDACTED] reads as a value to the
// protocol backstop. For the same reason no source escape is kept right after
// an `=` or `:`: the backstop reads the backslash in `X-Api-Token:\ [REDACTED]`
// as the header's value, so the word is written again from that escape, as
// `X-Api-Token:' [REDACTED]'`. A word written again from its first character
// drops the empty quotes its source opened with (`''"'"'x`), whose quote the
// backstop would read after a scheme word once the script is quoted again.
function rewrittenWord(text: string, word: Word, value: string, anchor: number, nested: boolean, command: boolean): string {
  if (value === word.value) return sourceSpelling(text, word, word.end, command)
  const { characters } = word
  let at = Math.min(anchor, commonPrefix(word.value, value))
  while (at > 0 && at < characters.length && characters[at - 1]!.source === characters[at]!.source) at -= 1
  for (let index = 1; index < at; index += 1) {
    const separator = word.value[index - 1]
    const escaped = characters[index]!.quoting === "" && text[characters[index]!.source] === "\\"
    if (escaped && (separator === "=" || separator === ":") && text[characters[index - 1]!.source] === separator) {
      at = index
      break
    }
  }
  const next = characters[at]
  const opens = nested ? next?.opens : undefined
  const start = at === 0 && next !== undefined ? next.opens ?? next.source : word.start
  const prefix = sourceSpelling(text, word, opens ?? next?.source ?? word.end, command, start)
  return `${prefix}${spelled(value.slice(at), opens === undefined ? next?.quoting ?? "" : "", prefix === "", command)}`
}

// The word a shell's `-c` option runs as a script, for each shell word in the
// tokens: `sh -c script`, `bash -lc script`, `bash -o pipefail -c script`.
function shellScripts(tokens: readonly Token[]): Set<number> {
  // What the options read from each index come to: the index of the word
  // after them and whether a -c is among them, or undefined when an operator
  // comes first. Read once from the end, since what follows an option does
  // not depend on the shell word before it: reading them again for each
  // shell word made `sh -o sh -o ...` quadratic.
  const scans: Array<{ next: number; command: boolean } | undefined> = []
  const scanFrom = (index: number) => (index >= tokens.length ? { next: index, command: false } : scans[index])
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const option = tokens[index]!
    if (option.kind !== "word") scans[index] = undefined
    else if (option.value === "--") scans[index] = { next: index + 1, command: false }
    else if (/^--[A-Za-z-]+$/u.test(option.value)) scans[index] = scanFrom(index + 1)
    else if (!/^[-+][A-Za-z]+$/u.test(option.value)) scans[index] = { next: index, command: false }
    else {
      // -o and -O take the next word as their argument.
      const rest = scanFrom(index + (/[oO]/u.test(option.value) ? 2 : 1))
      scans[index] = rest && { next: rest.next, command: rest.command || (option.value.startsWith("-") && option.value.includes("c")) }
    }
  }
  const scripts = new Set<number>()
  tokens.forEach((token, index) => {
    if (token.kind !== "word" || !shells.has(token.value.slice(token.value.lastIndexOf("/") + 1))) return
    const scan = scanFrom(index + 1)
    if (scan?.command && tokens[scan.next]?.kind === "word") scripts.add(scan.next)
  })
  return scripts
}

// What the rules decided for each token: its new value, the first character a
// rule rewrote, whether it was merged into the word before it, which tokens
// are a shell's script, and the token after which everything is dropped.
interface Plan { values: string[]; anchors: number[]; dropped: boolean[]; scripts: Set<number>; stopAfter?: number }

// One token's changes in order, overlapping ones made one: a change that
// holds another keeps its own text, and two that only overlap become the
// marker over both. Rules read inside a value another rule hid, so a change
// there (a flag's `=value` in the flag hidden after a scheme) is taken into
// the one around it. Sorted once and merged in one pass.
function mergedChanges(list: readonly Change[]): Change[] {
  const sorted = [...list].sort((left, right) => left.start - right.start || right.end - left.end)
  const merged: Change[] = []
  for (const change of sorted) {
    const last = merged.at(-1)
    if (last === undefined || (change.start >= last.end && change.start !== last.start)) merged.push(change)
    else if (change.end > last.end) merged[merged.length - 1] = { start: last.start, end: change.end, text: marker }
  }
  return merged
}

// A view of the joined text as the protocol backstop reads it: its characters,
// and for each the span of joined text it was read from. A character read
// from other text than itself (`%54` as `T`, `\-` as `-`), or put between two
// strings (the blank that joins a JSON argv's strings), is decoded.
interface View { text: string; from: number[]; to: number[] }

// A view built from another view's characters, each mapped to the joined text.
class ViewBuilder {
  private readonly parts: string[] = []
  private readonly from: number[] = []
  private readonly to: number[] = []
  constructor(private readonly source: View) {}
  // The source's characters from `start` to `end`, as they are.
  copy(start: number, end: number): void {
    this.parts.push(this.source.text.slice(start, end))
    for (let index = start; index < end; index += 1) {
      this.from.push(this.source.from[index]!)
      this.to.push(this.source.to[index]!)
    }
  }
  // `written`, read from the source's characters from `start` to `end`.
  read(written: string, start: number, end: number): void {
    this.parts.push(written)
    for (let index = 0; index < written.length; index += 1) {
      this.from.push(this.source.from[start]!)
      this.to.push(this.source.to[end - 1]!)
    }
  }
  // Another view's characters, already mapped to the joined text.
  append(view: View): void {
    this.parts.push(view.text)
    // One at a time: a long view spread as arguments would overflow the stack.
    for (let index = 0; index < view.text.length; index += 1) {
      this.from.push(view.from[index]!)
      this.to.push(view.to[index]!)
    }
  }
  view(): View {
    return { text: this.parts.join(""), from: this.from, to: this.to }
  }
}

// Every match of `pattern` (global) in a view written as `replacement` says.
function replacedView(view: View, pattern: RegExp, replacement: (match: RegExpExecArray) => string): View {
  const builder = new ViewBuilder(view)
  let cursor = 0
  for (const match of view.text.matchAll(pattern)) {
    builder.copy(cursor, match.index)
    builder.read(replacement(match), match.index, match.index + match[0].length)
    cursor = match.index + match[0].length
  }
  builder.copy(cursor, view.text.length)
  return builder.view()
}

// The protocol backstop's decodings, each as it writes them in `decoded`:
// one layer of percent encoding; \u escapes and then backslash escapes.
const percentDecoded = (view: View) => replacedView(view, /%([0-9A-Fa-f]{2})/gu, ([, hex]) => String.fromCharCode(Number.parseInt(hex!, 16)))
const unescaped = (view: View) => replacedView(
  replacedView(view, /\\u([0-9A-Fa-f]{4})/gu, ([, hex]) => String.fromCharCode(Number.parseInt(hex!, 16))),
  /\\(.)/gu,
  ([, character]) => character!,
)

// A view's double-quoted strings alone, each unescaped, joined by one blank
// read from the closing quote before it: a JSON argv's strings as words. As
// the backstop reads them, a string left unclosed ends the reading.
function quotedStringsView(view: View): View {
  const { text } = view
  const builder = new ViewBuilder(view)
  let closed = -1
  for (let open = text.indexOf("\""); open !== -1; open = text.indexOf("\"", closed + 1)) {
    let end = open + 1
    while (end < text.length && text[end] !== "\"") end += text[end] === "\\" ? 2 : 1
    if (end >= text.length) break
    if (closed !== -1) builder.read(" ", closed, closed + 1)
    builder.append(unescaped({ text: text.slice(open + 1, end), from: view.from.slice(open + 1, end), to: view.to.slice(open + 1, end) }))
    closed = end
  }
  return builder.view()
}

// An ANSI C escape inside $'...', as the backstop reads one.
const ansiEscape = /\\(?:x([0-9A-Fa-f]{1,2})|([0-7]{1,3})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|(.))/suy

// A view read as the backstop's shellWords reads text: quotes joined, backslash
// escapes taken, $'...' decoded, words joined by one blank read from the blank
// that ended the word before. An escape is read where it stands, not from a
// copy of the rest of the text, so many escapes stay linear.
function shellWordsView(view: View): View {
  const { text } = view
  const builder = new ViewBuilder(view)
  let inWord = false
  let words = 0
  let ended = -1
  const startWord = () => {
    if (inWord) return
    if (words > 0) builder.read(" ", ended, ended + 1)
    words += 1
    inWord = true
  }
  let index = 0
  while (index < text.length) {
    const character = text[index]!
    if (/\s/u.test(character)) {
      if (inWord) ended = index
      inWord = false
      index += 1
    } else if (character === "\\") {
      startWord()
      if (index + 1 < text.length) builder.read(text[index + 1]!, index, index + 2)
      index += 2
    } else if (character === "'") {
      startWord()
      const end = text.indexOf("'", index + 1)
      const close = end === -1 ? text.length : end
      builder.copy(index + 1, close)
      index = close + 1
    } else if (character === "$" && text[index + 1] === "'") {
      startWord()
      index += 2
      while (index < text.length && text[index] !== "'") {
        if (text[index] !== "\\") {
          builder.copy(index, index + 1)
          index += 1
          continue
        }
        ansiEscape.lastIndex = index
        const escape = ansiEscape.exec(text)
        if (escape === null) {
          // A lone backslash at the end escapes nothing.
          index += 1
          continue
        }
        const [whole, hex, octal, short, long, other] = escape
        const code = hex ?? short ?? long
        const written = code !== undefined ? String.fromCodePoint(Math.min(Number.parseInt(code, 16), 0x10ffff))
          : octal !== undefined ? String.fromCharCode(Number.parseInt(octal, 8) & 0xff)
          : other ?? ""
        builder.read(written, index, index + whole.length)
        index += whole.length
      }
      index += 1
    } else if (character === "\"" || (character === "$" && text[index + 1] === "\"")) {
      startWord()
      index += character === "$" ? 2 : 1
      while (index < text.length && text[index] !== "\"") {
        const escaped = text[index] === "\\" && /[$`"\\]/u.test(text[index + 1] ?? "")
        if (escaped) builder.read(text[index + 1]!, index, index + 2)
        else builder.copy(index, index + 1)
        index += escaped ? 2 : 1
      }
      index += 1
    } else {
      startWord()
      builder.copy(index, index + 1)
      index += 1
    }
  }
  return builder.view()
}

// Every view of `text` the protocol backstop reads besides the words the
// shell assembles, which the rules read already: percent-decoded, unescaped
// (as written and percent-decoded), percent-decoded shell words, and the
// double-quoted strings (as written and percent-decoded). A view with the
// same text as the words is left out, and so is a second view with one text.
function backstopViews(text: string): View[] {
  const words: View = { text, from: Array.from({ length: text.length }, (_, index) => index), to: Array.from({ length: text.length }, (_, index) => index + 1) }
  const percent = percentDecoded(words)
  const views = [percent, unescaped(words), unescaped(percent), shellWordsView(percent), quotedStringsView(words), quotedStringsView(percent)]
  const seen = new Set([text])
  return views.filter((view) => {
    if (seen.has(view.text)) return false
    seen.add(view.text)
    return true
  })
}

// The backstop's judgement of a key and its value, as `pairHoldsValue` in the
// protocol makes it: whether it refuses the text for that value.
const sentenceEnd = new Set([".", ",", ";", ":", "!", "?", "\"", "'", "`", ")", "]", "}", "\u2019", "\u201d", "\u00bb"])
const authorizationSchemes = new Set(["bearer", "basic", "token", "digest"])
function backstopRefusesPair(flag: string, quoteAfterKey: string, key: string, separator: string, value: string, assignmentStart: boolean): boolean {
  if (value === "") return false
  const joinedBy = separator.trim()
  if (joinedBy === "") return flag !== "" && isSensitiveKey(key) && !value.startsWith("-") && value !== marker
  if (isSensitiveKey(key)) return !(key.toLowerCase() === "authorization" && authorizationSchemes.has(value.toLowerCase())) && value !== marker
  if (joinedBy === "=") return flag === "" && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) && assignmentStart && value !== marker
  const keyForm = quoteAfterKey !== "" || (/\s$/u.test(separator) && key.includes("_"))
  return /^[A-Z_][A-Z0-9_]+$/u.test(key) && keyForm && value !== marker
}
// A key as the backstop's keyPairs pattern reads one, before its separator.
const viewKey = /(-{1,2})?(["'`]?)([A-Za-z_][A-Za-z0-9_.-]*)(["'`]?)/uy

// A trigger found in a view: the view's index where it starts, and where the
// value after it starts and ends.
interface ViewTrigger { start: number; valueStart: number; valueEnd: number }

// A word of prose after a scheme word, with the punctuation a sentence puts
// after it, as the backstop reads one.
const proseWord = /^\p{L}+[.,;:!?"'`)\]}’”»]*$/u

// Every scheme word and key in a view whose value the protocol backstop reads
// as a credential or would refuse the text for, judged one of two ways. To
// hide: a scheme word's value unless it is the marker (a word of prose too,
// which the backstop lets through), read at every scheme word. To refuse:
// exactly as the backstop does, prose and an Authorization key before the
// scheme included, each search going on past the value it read. Either way a
// key's value counts when the backstop would refuse it. Each is read in
// constant work apart from its own key, separator and value, from facts read
// once from the view's end, so the reading is linear.
function viewTriggers(view: View, judge: "hide" | "refuse"): ViewTrigger[] {
  const { text } = view
  const blankEnds = new Int32Array(text.length + 1)
  const schemeValueEnds = new Int32Array(text.length + 1)
  const keyValueEnds = new Int32Array(text.length + 1)
  blankEnds[text.length] = text.length
  schemeValueEnds[text.length] = text.length
  keyValueEnds[text.length] = text.length
  for (let at = text.length - 1; at >= 0; at -= 1) {
    const character = text[at]!
    blankEnds[at] = /\s/u.test(character) ? blankEnds[at + 1]! : at
    schemeValueEnds[at] = /[\s"'`,;)]/u.test(character) ? at : schemeValueEnds[at + 1]!
    keyValueEnds[at] = /[\s"'`,;}&|)]/u.test(character) ? at : keyValueEnds[at + 1]!
  }
  const afterQuote = (at: number) => (at < text.length && /["'`]/u.test(text[at]!) ? at + 1 : at)
  // Where an Authorization key and its separator end right before `at`, the
  // start of that key; read backwards over a quote, blanks, `=` or `:`,
  // blanks and a quote, as the backstop's pattern reads them forwards.
  const authorizationBefore = (at: number): number | undefined => {
    let index = at
    if (index > 0 && /["'`]/u.test(text[index - 1]!)) index -= 1
    while (index > 0 && /\s/u.test(text[index - 1]!)) index -= 1
    if (index === 0 || !"=:".includes(text[index - 1]!)) return undefined
    index -= 1
    while (index > 0 && /\s/u.test(text[index - 1]!)) index -= 1
    if (index > 0 && /["'`]/u.test(text[index - 1]!)) index -= 1
    const key = index - "authorization".length
    return key >= 0 && text.slice(key, index).toLowerCase() === "authorization" ? key : undefined
  }
  // Where the backstop's next search for a scheme starts: past the value
  // its last match read.
  let schemeFrom = 0
  const triggers: ViewTrigger[] = []
  for (let at = 0; at < text.length; at += 1) {
    const before = at === 0 ? "" : text[at - 1]!
    schemeWord.lastIndex = at
    if (schemeWord.test(text)) {
      const blanks = schemeWord.lastIndex
      const valueStart = afterQuote(blankEnds[blanks]!)
      const valueEnd = schemeValueEnds[valueStart]!
      const authorization = judge === "refuse" ? authorizationBefore(at) : undefined
      const header = authorization !== undefined && authorization >= schemeFrom
      const read = blankEnds[blanks]! > blanks && valueEnd > valueStart && (header || (!schemeBoundary.test(before) && at >= schemeFrom))
      if (read) {
        // The marker, alone or ending a sentence, is judged as the backstop
        // judges it; the punctuation after it is read once.
        let ending = valueEnd
        while (ending > valueStart + marker.length && sentenceEnd.has(text[ending - 1]!)) ending -= 1
        const markerOnly = ending === valueStart + marker.length && text.startsWith(marker, valueStart)
        if (judge === "hide") {
          if (!markerOnly) triggers.push({ start: at, valueStart, valueEnd })
        } else {
          schemeFrom = valueEnd
          const value = text.slice(valueStart, valueEnd)
          const nextStart = blankEnds[valueEnd]!
          const nextEnd = schemeValueEnds[nextStart]!
          const prose = !header && proseWord.test(value) && nextStart > valueEnd && nextEnd > nextStart && proseWord.test(text.slice(nextStart, nextEnd))
          let word = value
          if (!header) {
            let end = value.length
            while (end > 0 && sentenceEnd.has(value[end - 1]!)) end -= 1
            word = value.slice(0, end)
          }
          if (!markerOnly && word !== "" && !prose && word !== marker && !schemeProse.has(word.toLowerCase())) {
            triggers.push({ start: header ? authorization : at, valueStart, valueEnd })
          }
        }
      }
    }
    if (/[\p{L}\p{N}_.-]/u.test(before)) continue
    viewKey.lastIndex = at
    const key = viewKey.exec(text)
    if (key === null) continue
    const [whole, flag = "", , name = "", quoteAfterKey = ""] = key
    const separatorStart = at + whole.length
    const blanks = blankEnds[separatorStart]!
    const joiner = text[blanks]
    const separatorEnd = joiner === "=" || joiner === ":" ? blankEnds[blanks + 1]! : blanks
    if (separatorEnd === separatorStart) continue
    const valueStart = afterQuote(separatorEnd)
    const valueEnd = keyValueEnds[valueStart]!
    // Only whether the value is empty, opens with a hyphen, or is the marker
    // or a scheme word matters, so a longer value is read no further than
    // one character past the marker's length.
    const value = text.slice(valueStart, Math.min(valueEnd, valueStart + marker.length + 1))
    const assignmentStart = at === 0 || /[\s(;&|`<]/u.test(before)
    if (backstopRefusesPair(flag, quoteAfterKey, name, text.slice(separatorStart, separatorEnd), value, assignmentStart)) {
      triggers.push({ start: at, valueStart, valueEnd })
    }
  }
  return triggers
}

// Whether a trigger reads as one only in its view: some character from the
// one before it to its value's start was decoded, or does not follow the one
// before it in the joined text. A trigger read from the joined text as it is
// was read by the rules already.
function decodedTrigger(view: View, joined: string, { start, valueStart }: ViewTrigger): boolean {
  const first = Math.max(start - 1, 0)
  for (let index = first; index < valueStart; index += 1) {
    const from = view.from[index]!
    if (view.to[index]! - from !== 1 || joined[from] !== view.text[index]) return true
    if (index > first && from !== view.to[index - 1]) return true
  }
  return false
}

// Where the protocol backstop would first read a scheme word or key in text
// it refuses for the value after it, in any view it reads, or undefined when
// no such trigger is there. An output is checked with it, so a spelling the
// rules chose that still reads as a value (a quote pairing changed by a
// hidden string, a backslash kept before the marker) is cut there rather
// than left for the backstop to drop the whole entry.
function refusalAt(text: string): number | undefined {
  const words: View = { text, from: Array.from({ length: text.length }, (_, index) => index), to: Array.from({ length: text.length }, (_, index) => index + 1) }
  const percent = percentDecoded(words)
  const views = [words, percent, unescaped(words), unescaped(percent), shellWordsView(words), shellWordsView(percent), quotedStringsView(words), quotedStringsView(percent)]
  const seen = new Set<string>()
  let first: number | undefined
  for (const view of views) {
    if (seen.has(view.text)) continue
    seen.add(view.text)
    for (const trigger of viewTriggers(view, "refuse")) {
      const at = view.from[trigger.start]!
      if (first === undefined || at < first) first = at
    }
  }
  return first
}

// The rules, run over the tokens' values joined by one space. `glued` says a
// token is written with no blank before the next one; `leading` is the first
// source character of each word, so a flag test sees `"-x"` as a quote.
function planTokens(tokens: readonly Token[], glued: readonly boolean[], leading: readonly string[], depth: number, nested: boolean, command: boolean): Plan {
  let joined = ""
  const starts: number[] = []
  const owners: number[] = []
  tokens.forEach((token, index) => {
    if (index > 0) {
      joined += " "
      owners.push(-1)
    }
    starts.push(joined.length)
    joined += token.value
    for (let offset = 0; offset < token.value.length; offset += 1) owners.push(index)
  })
  const ends = tokens.map((token, index) => starts[index]! + token.value.length)
  const changes: Change[][] = tokens.map(() => [])
  const consumed = new Set<number>()
  const dropped = tokens.map(() => false)
  const scripts = shellScripts(tokens)
  let stopAfter: number | undefined

  // Whether the rules run in the second pass below, and the character it
  // reads there and that character's token.
  let passing = false
  let passAt = -1
  let passToken = -1
  // What the first pass hid, as a count of hiding changes over each index of
  // the joined text: one more where a change starts, one fewer where it ends.
  // A URL counts only the spans it hides, not the host or names it keeps.
  const hiding = new Int32Array(joined.length + 1)
  const hide = (from: number, to: number) => {
    hiding[from]! += 1
    hiding[to]! -= 1
  }
  // Filled after the first pass: how many characters before each index
  // nothing hid, so whether a span was hidden is asked in constant time.
  const shown = new Int32Array(joined.length + 1)
  const hidden = (from: number, to: number) => shown[to]! - shown[from]! === 0

  // Each URL the first pass changed: the token it starts in and the last
  // token it read in, where it starts, its text, the spans it hides, its
  // change, and where a later rule cut it. `urlOf` names the URL each of its
  // tokens belongs to, and `urlOffsets` where each token's text starts in it.
  interface UrlRead { token: number; last: number; index: number; url: string; hides: Change[]; change: Change; cut: number }
  const urls: UrlRead[] = []
  const urlOf = new Int32Array(tokens.length).fill(-1)
  const urlOffsets = new Int32Array(tokens.length)
  // Where the second pass hid a word from a trigger to its end, per token.
  const tails = new Float64Array(tokens.length).fill(Number.POSITIVE_INFINITY)
  // The word from `at` to its end is hidden. In a URL the first pass changed,
  // its text was written as one change, so the URL is cut there instead.
  const hideTail = (token: number, at: number) => {
    const read = urlOf[token] === -1 ? undefined : urls[urlOf[token]!]
    if (read !== undefined && (token !== read.token || at >= read.index)) {
      read.cut = Math.min(read.cut, urlOffsets[token]! + at - (token === read.token ? read.index : starts[token]!))
    } else if (at < tails[token]!) {
      tails[token] = at
      changes[token]!.push({ start: at - starts[token]!, end: ends[token]! - starts[token]!, text: marker })
    }
  }

  // Where a same-word value is checked to, when its rule reads less of it.
  let sameWordStop = Number.POSITIVE_INFINITY
  // A change is recorded and true returned. The second pass records a value
  // in a later word than the one it reads; a value that is a later shell's
  // script hides that script whole. A value in the same word is that word's
  // rule's to hide (a URL's, a header's) or, in a shell's script, the
  // script's own when it is read on its own. When that rule took the word
  // without hiding all of the value (a URL's host or a query name, a header's
  // name before a scheme word it keeps), the word is hidden from the trigger
  // the second pass read, the scheme word, key, flag or header flag, to its
  // end.
  const change = (token: number, from: number, to: number, text: string): boolean => {
    if (passing && token === passToken) {
      if (scripts.has(token) || hidden(from, Math.max(from, Math.min(to, sameWordStop)))) return false
      hideTail(token, passAt)
    } else if (passing && scripts.has(token)) changes[token]!.push({ start: 0, end: ends[token]! - starts[token]!, text: marker })
    else {
      changes[token]!.push({ start: from - starts[token]!, end: to - starts[token]!, text })
      if (!passing) hide(from, to)
    }
    consumed.add(token)
    return true
  }
  // Everything from `from` to the end of the text is redacted.
  const truncate = (token: number, from: number) => {
    if (change(token, from, ends[token]!, marker)) stopAfter = stopAfter === undefined ? token : Math.min(stopAfter, token)
  }
  const wordAtIndex = (index: number): number | undefined => {
    const owner = owners[index]
    return owner === undefined || owner === -1 || tokens[owner]!.kind !== "word" ? undefined : owner
  }
  const quotingAt = (token: number, index: number): Quoting => (tokens[token] as Word).characters[index - starts[token]!]?.quoting ?? ""
  // Whether the joined text from `from` to `to` is the marker, compared only
  // when the lengths agree.
  const isMarkerAt = (from: number, to: number) => (to - from === marker.length || to - from === marker.length + 2) && isMarker(joined.slice(from, to))

  // Facts about the joined text, read once from the end so a rule asks them
  // in constant time wherever it starts: where the run of header-name
  // characters, and of blanks, starting at each index ends, and where the
  // next colon is, and where a key's value as the protocol backstop reads it
  // ends. A header flag read them from the rest of its word, which many flags
  // in one word made quadratic.
  const nameRuns = new Int32Array(joined.length + 1)
  const blankRuns = new Int32Array(joined.length + 1)
  const colons = new Int32Array(joined.length + 1)
  const valueStops = new Int32Array(joined.length + 1)
  nameRuns[joined.length] = joined.length
  blankRuns[joined.length] = joined.length
  colons[joined.length] = joined.length
  valueStops[joined.length] = joined.length
  for (let at = joined.length - 1; at >= 0; at -= 1) {
    const character = joined[at]!
    nameRuns[at] = headerNameCharacter.test(character) ? nameRuns[at + 1]! : at
    blankRuns[at] = /\s/u.test(character) ? blankRuns[at + 1]! : at
    colons[at] = character === ":" ? at : colons[at + 1]!
    valueStops[at] = valueStop.test(character) ? at : valueStops[at + 1]!
  }
  // The first word at or after each token, or -1.
  const nextWords = new Int32Array(tokens.length + 1)
  nextWords[tokens.length] = -1
  for (let at = tokens.length - 1; at >= 0; at -= 1) nextWords[at] = tokens[at]!.kind === "word" ? at : nextWords[at + 1]!

  // A private key that runs past its word takes the rest of the text. Its
  // body runs to the first footer after its header, or to the end: that
  // footer is found once and kept for every header before it, where each
  // header searching on to it again made many headers quadratic.
  let footer: { start: number; end: number } | undefined
  const privateKeyAt = (index: number, token: number): number | undefined => {
    privateKeyHeader.lastIndex = index
    if (!privateKeyHeader.test(joined)) return undefined
    const body = privateKeyHeader.lastIndex
    if (footer === undefined || footer.start < body) {
      privateKeyFooter.lastIndex = body
      const found = privateKeyFooter.exec(joined)
      footer = found ? { start: found.index, end: found.index + found[0].length } : { start: Number.POSITIVE_INFINITY, end: joined.length }
    }
    if (footer.end <= ends[token]!) return undefined
    // In the second pass the header's own word was read already (hidden by
    // the URL it is in, read on its own as a shell's script, or cut here by
    // the first pass), so the body is the rest of the text from the next word.
    if (passing) {
      const next = nextWords[token + 1]
      if (next !== undefined && next !== -1) truncate(next, starts[next]!)
    } else truncate(token, index)
    return joined.length
  }

  // A URL runs to the end of its word, and on through operators written with
  // no blank between them (`https://h/?a=1&b#c`), as the shell would not read it.
  const urlAt = (index: number, token: number): number | undefined => {
    if (index > 0 && /[A-Za-z0-9+.-]/u.test(joined[index - 1]!)) return undefined
    urlStart.lastIndex = index
    if (!urlStart.test(joined) || urlStart.lastIndex > ends[token]!) return undefined
    let last = token
    let url = joined.slice(index, ends[token])
    while (last + 1 < tokens.length && glued[last] && (tokens[last + 1]!.kind === "word" || !/[<>\n]/u.test(tokens[last + 1]!.value))) {
      last += 1
      url += tokens[last]!.value
    }
    const hides = urlHides(url)
    const redacted = writtenUrl(url, hides)
    if (redacted === url) return ends[token]!
    const read: UrlRead = { token, last, index, url, hides, change: { start: index - starts[token]!, end: ends[token]! - starts[token]!, text: redacted }, cut: Number.POSITIVE_INFINITY }
    changes[token]!.push(read.change)
    consumed.add(token)
    // Each token's text in the URL, and the spans it hides in the joined text.
    let hideIndex = 0
    for (let part = token, offset = 0; part <= last; offset += ends[part]! - (part === token ? index : starts[part]!), part += 1) {
      urlOf[part] = urls.length
      urlOffsets[part] = offset
      const from = part === token ? index : starts[part]!
      const length = ends[part]! - from
      // A span can run on into the next token's text.
      while (hideIndex < hides.length && hides[hideIndex]!.start < offset + length) {
        const { start, end } = hides[hideIndex]!
        hide(from + Math.max(start - offset, 0), from + Math.min(end - offset, length))
        if (end > offset + length) break
        hideIndex += 1
      }
    }
    urls.push(read)
    for (let merged = token + 1; merged <= last; merged += 1) {
      dropped[merged] = true
      consumed.add(merged)
    }
    return ends[last]!
  }

  // A header flag starts where a sensitive flag does: after anything but a
  // letter, digit, underscore, dot or hyphen, so `?-H X-Foo: v` in a URL's
  // query is one too.
  const headerAt = (index: number): number | undefined => {
    if (index > 0 && /[\p{L}\p{N}_.-]/u.test(joined[index - 1]!)) return undefined
    headerFlag.lastIndex = index
    const match = headerFlag.exec(joined)
    if (!match) return undefined
    const [whole, flag = "", separator = ""] = match
    // --headers is another flag; only -H takes its value in the same word.
    if (separator === "" && flag !== "-H") return undefined
    const from = index + whole.length
    const argument = wordAtIndex(from)
    if (argument === undefined) return undefined
    const to = ends[argument]!
    // The argument from `from` to `to`: a name, then blanks and a colon.
    const nameEnd = Math.min(nameRuns[from]!, to)
    const colon = Math.min(blankRuns[nameEnd]!, to)
    const named = nameEnd > from && colon < to && joined[colon] === ":"
    const afterBlanks = named ? Math.min(blankRuns[colon + 1]!, to) : to
    // Where the value of a header line starts: after the blanks after its
    // colon, or on the last of them when nothing else follows.
    const valueStart = !named ? undefined : afterBlanks < to ? afterBlanks : afterBlanks > colon + 1 ? to - 1 : undefined
    if (valueStart !== undefined) {
      // A value that opens with an authorization scheme keeps the scheme word.
      let kept = valueStart
      schemeWord.lastIndex = valueStart
      if (schemeWord.test(joined) && schemeWord.lastIndex < to && /\s/u.test(joined[schemeWord.lastIndex]!)) kept = Math.min(blankRuns[schemeWord.lastIndex]!, to)
      if (kept === to || isMarkerAt(kept, to)) return to
      change(argument, kept, to, marker)
      // Every rule reads the value it hid, so a scheme or flag word in it is
      // still read as one.
      return kept
    }
    // An argument with a colon that does not read as a header is redacted
    // whole rather than let through (`X Foo: v`); when it ends at an unquoted
    // colon (`X;Foo:`), the next word is taken as its value too. `@file` and
    // `Name;` are left to the other rules.
    const unreadable = colons[from]! < to && !(named && colon + 1 === to)
    let resume: number | undefined
    if (unreadable && !isMarkerAt(from, to)) {
      change(argument, from, to, marker)
      resume = from
    }
    // A quoted `"Name:"` is an empty header its author closed; only an
    // unquoted colon takes the next word as its value. A flag there is the
    // next argument, not a value.
    if (to === from || joined[to - 1] !== ":" || quotingAt(argument, to - 1) !== "") return resume ?? (unreadable ? to : undefined)
    const value = argument + 1
    const next = tokens[value]
    if (next?.kind !== "word" || next.value === "" || leading[value] === "-" || isMarkerAt(starts[value]!, ends[value]!)) return resume ?? to
    change(value, starts[value]!, ends[value]!, marker)
    return resume ?? starts[value]!
  }

  const pairAt = (index: number, token: number): number | undefined => {
    if (index > 0 && /[\p{L}\p{N}_.-]/u.test(joined[index - 1]!)) return undefined
    keyPair.lastIndex = index
    const match = keyPair.exec(joined)
    if (!match) return undefined
    const [whole, flag = "", keyQuote = "", key = "", separator = ""] = match
    if (index + flag.length + keyQuote.length * 2 + key.length > ends[token]!) return undefined
    const start = index + whole.length
    const value = wordAtIndex(start)
    if (value === undefined) return undefined
    const joinedBy = separator.trim()
    const wordStart = index === 0 || wordBoundary.test(joined[index - 1]!)
    const quotedKey = keyQuote !== "" || quotingAt(token, index + flag.length) !== ""
    const first = start === starts[value] ? leading[value]! : joined[start]!
    let redacts: boolean
    if (joinedBy === "") redacts = flag !== "" && isSensitiveKey(key) && first !== "-"
    else if (isSensitiveKey(key)) {
      // `Authorization: Bearer x` names a scheme; the scheme rule takes its value.
      scheme.lastIndex = start
      redacts = !(key.toLowerCase() === "authorization" && scheme.test(joined))
    } else if (joinedBy === "=") redacts = flag === "" && keyQuote === "" && wordStart && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
    else redacts = /^[A-Z_][A-Z0-9_]+$/u.test(key) && (quotedKey || key.includes("_"))
    if (!redacts) return undefined
    // A value in the key's own word counts as hidden when the value the
    // protocol backstop reads after the key is: its first run, after one
    // opening quote. The rest of the word can be a URL's next query part
    // (`?access_token=x&mode=fast`), whose name the URL keeps. When that run is
    // empty, a sensitive key's value is the rest of its word (`--token ,x`); an
    // assignment's (`;b=&d`) is empty.
    const valueFrom = /["'`]/u.test(joined[start]!) ? start + 1 : start
    const stop = valueStops[valueFrom]!
    sameWordStop = stop === valueFrom && isSensitiveKey(key) ? Number.POSITIVE_INFINITY : stop
    // A value that is one quoted string in the text (a JSON value) ends at its
    // closing quote and keeps its quotes. Every rule reads a value it hid, so
    // a scheme or flag word in it is still read as one.
    const opening = joined[start]
    if (opening === "\"" || opening === "'") {
      const { end, closed } = quotedEnd(joined, start, ends[value]!)
      if (!isMarkerAt(start, end)) change(value, start, end, closed ? `${opening}${marker}${opening}` : marker)
      return start
    }
    if (nested) {
      if (!(joined.length - start === marker.length && joined.startsWith(marker, start))) truncate(value, start)
      return joined.length
    }
    if (!isMarkerAt(start, ends[value]!)) change(value, start, ends[value]!, marker)
    return start
  }

  // A word of prose kept after a scheme word, with the punctuation a sentence
  // puts after it. The punctuation is read once from the end: an anchored
  // pattern restarted at every character of a long run of it.
  const isSchemeProse = (start: number, end: number) => {
    let trimmed = end
    while (trimmed > start && ".,;:!?".includes(joined[trimmed - 1]!)) trimmed -= 1
    return schemeProse.has(joined.slice(start, trimmed).toLowerCase())
  }
  const schemeAt = (index: number, token: number): number | undefined => {
    if (index > 0 && schemeBoundary.test(joined[index - 1]!)) return undefined
    scheme.lastIndex = index
    if (!scheme.test(joined)) return undefined
    const start = scheme.lastIndex
    const value = wordAtIndex(start)
    if (value === undefined) return undefined
    // A value in the next word is that whole word; one in the same word ends
    // where a word of prose would. The protocol backstop reads a value after
    // one opening quote, so one in the same word starts past it and the
    // quote is kept: `Token "x y"` reads `Token "[REDACTED] y"`.
    let valueStart = start
    if (value === token && valueStart + 1 < ends[value]! && /["'`]/u.test(joined[valueStart]!)) valueStart += 1
    let end = valueStart
    if (value !== token) end = ends[value]!
    else while (end < ends[value]! && !/[\s"'`,;)]/u.test(joined[end]!)) end += 1
    // A value kept (a word of prose, or the marker) or hidden is still read
    // from its start by every rule, so a scheme or flag word in it is read as
    // one: `Bearer Basic x` reads `Bearer [REDACTED] [REDACTED]`. A flag is
    // hidden whole too, since the protocol backstop takes any word after a
    // scheme as its credential: `Bearer --token x` reads `Bearer [REDACTED]
    // [REDACTED]`. A change a rule then makes inside it (`--token=x`) is
    // taken into its marker.
    const kept = end === valueStart || (end - valueStart === marker.length && joined.startsWith(marker, valueStart))
    if (!kept && (joined[valueStart] === "-" || !isSchemeProse(valueStart, end))) change(value, valueStart, end, marker)
    return start
  }

  let index = 0
  while (index < joined.length && stopAfter === undefined) {
    const token = owners[index]!
    if (token === -1) {
      index += 1
      continue
    }
    // An operator holds no value, and a shell's script is read on its own.
    if (tokens[token]!.kind === "operator" || scripts.has(token)) {
      index = ends[token]!
      continue
    }
    index = (joined.startsWith("-----BEGIN ", index) ? privateKeyAt(index, token) : undefined)
      ?? urlAt(index, token) ?? headerAt(index) ?? pairAt(index, token) ?? schemeAt(index, token) ?? index + 1
  }
  // The second pass, independent of the first. The pass above moves past a
  // word a rule took (a URL to its end, a header's name and the scheme word
  // that opens its value, a shell's script), so a word in there that makes
  // the next word a value was not read: `--token 'https://h/ Token' x` hid
  // the URL and showed `x` with nothing left to name it. Here every rule
  // whose value can be the next word (a scheme word, a sensitive key or flag,
  // a header's name, a private key's header) is tried at every character of
  // the original words, whatever the pass above took, and each value it
  // finds in a later word is hidden. A value it finds in the same word that
  // the pass above did not hide hides that word from the rule's start to its
  // end: `'https://host Token x'` kept the host whole. What it finds joins
  // the changes above and is merged with them once, so no rule decides what
  // another reads.
  // Each rule reads in constant work apart from what it matches, so the pass
  // is linear too. A value in the same word counts as hidden when the first
  // pass hid every character of it, or the text already held the marker there.
  for (let at = joined.indexOf(marker); at !== -1; at = joined.indexOf(marker, at + marker.length)) hide(at, at + marker.length)
  for (let at = 0, depth = 0; at < joined.length; at += 1) {
    depth += hiding[at]!
    shown[at + 1] = shown[at]! + (depth === 0 ? 1 : 0)
  }
  passing = true
  sameWordStop = Number.POSITIVE_INFINITY
  footer = undefined
  for (let at = 0; at < joined.length && (stopAfter === undefined || at < ends[stopAfter]!); at += 1) {
    const token = owners[at]!
    if (token === -1 || tokens[token]!.kind === "operator") continue
    passAt = at
    passToken = token
    if (joined.startsWith("-----BEGIN ", at)) privateKeyAt(at, token)
    headerAt(at)
    pairAt(at, token)
    sameWordStop = Number.POSITIVE_INFINITY
    schemeAt(at, token)
  }
  // The views the protocol backstop reads besides the words (percent-decoded,
  // unescaped, its shell words of the percent-decoded text, a JSON argv's
  // strings) are read too: `%54oken x y` and `Token%20x y` are a scheme and
  // its value there, and `api%5fkey=x` a key. A scheme word or key read only
  // in a view is mapped back to the joined text it came from, and its value
  // hidden as the second pass hides one: a value in a later word hides that
  // word whole, and one in the same word that the first pass did not hide
  // hides the word from where the trigger's text starts to its end. A value
  // that is not a word (an operator the view read into it) hides the
  // trigger's own word from there instead. Each view is read in linear work.
  for (const view of backstopViews(joined)) {
    for (const trigger of viewTriggers(view, "hide")) {
      if (!decodedTrigger(view, joined, trigger)) continue
      const start = view.from[trigger.start]!
      const token = wordAtIndex(start)
      if (token === undefined || (stopAfter !== undefined && token > stopAfter)) continue
      const valueFrom = view.from[trigger.valueStart]!
      const valueTo = view.to[trigger.valueEnd - 1]!
      const value = wordAtIndex(valueFrom)
      passAt = start
      passToken = token
      sameWordStop = Number.POSITIVE_INFINITY
      if (value === token) change(token, valueFrom, valueTo, marker)
      else if (value !== undefined) change(value, starts[value]!, ends[value]!, marker)
      else if (!scripts.has(token)) hideTail(token, start)
    }
  }
  // A URL cut in the second pass is written again up to its cut.
  for (const read of urls) if (read.cut !== Number.POSITIVE_INFINITY) read.change.text = writtenUrl(read.url, read.hides, read.cut)
  const merged = changes.map(mergedChanges)
  const values = tokens.map((token, index) => {
    if (token.kind !== "word" || dropped[index] || (stopAfter !== undefined && index > stopAfter)) return token.value
    // A script is fitted as part of the text around it.
    if (scripts.has(index) && !consumed.has(index)) return depth >= maximumDepth ? marker : redactShell(token.value, depth + 1, true, command, Number.POSITIVE_INFINITY)
    // The value is built once from its changes in order, not again for each.
    const pieces: string[] = []
    let cursor = 0
    for (const { start, end, text } of merged[index]!) {
      pieces.push(token.value.slice(cursor, start), text)
      cursor = end
    }
    pieces.push(token.value.slice(cursor))
    return redactKnownShapes(pieces.join(""))
  })
  // A shell's script that changed is written again whole, so no escape from
  // its source stands between a key and its [REDACTED].
  const anchors = merged.map((list, index) => (scripts.has(index) && !consumed.has(index) ? 0 : list[0]?.start ?? Number.POSITIVE_INFINITY))
  return { values, anchors, dropped, scripts, ...(stopAfter === undefined ? {} : { stopAfter }) }
}

// The end of a quoted string in a value that opens at `start`, past its
// closing quote, and whether it closes before `limit`.
function quotedEnd(text: string, start: number, limit: number): { end: number; closed: boolean } {
  const quote = text[start]
  let index = start + 1
  while (index < limit && text[index] !== quote) index += quote === "\"" && text[index] === "\\" ? 2 : 1
  return index < limit ? { end: index + 1, closed: true } : { end: limit, closed: false }
}

// Shell text with every value the rules find redacted. `depth` counts the
// shells it is nested in; `nested` is true inside one. `command` is true for a
// command line a shell runs, whose pattern characters are written so they do
// not expand. The output is at most `maximum` long: when it would be longer,
// the tokens written are kept while they fit with the marker after them.
function redactShell(text: string, depth: number, nested: boolean, command: boolean, maximum: number): string {
  const { tokens, stoppedAt } = lexShell(text)
  const glued = tokens.map((token, index) => tokens[index + 1]?.start === token.end)
  const leading = tokens.map((token) => text[token.start] ?? "")
  const plan = planTokens(tokens, glued, leading, depth, nested, command)
  let output = ""
  let cursor = 0
  let endsInWord = false
  // The tokens the output is meant to read back as.
  const meant: Array<Pick<Token, "kind" | "value">> = []
  // Where the output can be cut: its length, and the tokens meant, after each
  // token written.
  const cuts: Array<{ length: number; count: number }> = []
  // The longest run of whole tokens written that fits with the marker after
  // it and reads back, or the marker alone. A cut is measured before it is
  // built, so one too long is never built: the work stays linear in the
  // output and the cap, not the output times its tokens.
  // A cut is also no longer than `limit`, when one is given.
  const fitted = (limit = Number.POSITIVE_INFINITY) => {
    for (let index = cuts.length - 1; index >= 0; index -= 1) {
      const { length, count } = cuts[index]!
      if (length + 1 + marker.length > maximum || length > limit) continue
      const shortened = `${output.slice(0, length)} ${marker}`
      const read = readBack(shortened, [...meant.slice(0, count), { kind: "word", value: marker }], command)
      if (read !== marker) return read
    }
    return marker
  }
  // An output the protocol backstop would still refuse is cut as a long one
  // is, before the token where it reads the trigger: whole tokens before it
  // are kept, and the rest is the marker. Each cut is shorter than
  // the last, so the checks end.
  const accepted = (result: string) => {
    let checked = result
    let longest = Number.POSITIVE_INFINITY
    for (let at = refusalAt(checked); at !== undefined && checked !== marker; at = refusalAt(checked)) {
      checked = fitted(Math.min(at, longest))
      // The kept text before ` [REDACTED]`, less one: the next cut is shorter.
      longest = checked.length - marker.length - 2
    }
    return checked
  }
  const readsBack = (whole: string, words: ReadonlyArray<Pick<Token, "kind" | "value">>) => {
    const read = readBack(whole, words, command)
    return accepted(read.length <= maximum ? read : fitted())
  }
  // The rest of the text from `gap` on is redacted: a gap with a control
  // character in it is written as one blank.
  const redactRest = (gap: string) => {
    meant.push({ kind: "word", value: marker })
    const blank = output === "" ? "" : " "
    return readsBack(`${output}${controlCharacter.test(gap) ? blank : gap === "" && endsInWord ? " " : gap}${marker}`, meant)
  }
  for (const [index, token] of tokens.entries()) {
    // A merged token was written with no blank before it; its text is in the
    // word before it now.
    if (plan.dropped[index]) {
      cursor = token.end
      continue
    }
    const gap = text.slice(cursor, token.start)
    const spelling = token.kind === "word" ? rewrittenWord(text, token, plan.values[index]!, plan.anchors[index]!, nested, command) : token.value
    if (controlCharacter.test(gap) || controlCharacter.test(spelling)) return redactRest(gap)
    output += `${gap}${spelling}`
    meant.push({ kind: token.kind, value: token.kind === "word" ? plan.values[index]! : token.value })
    cursor = token.end
    endsInWord = token.kind === "word"
    cuts.push({ length: output.length, count: meant.length })
    if (plan.stopAfter === index) return readsBack(output, meant)
  }
  if (stoppedAt === undefined) {
    const rest = text.slice(cursor)
    return controlCharacter.test(rest) ? redactRest(rest) : readsBack(`${output}${rest}`, meant)
  }
  return redactRest(text.slice(cursor, stoppedAt))
}

// The output when it reads back as exactly the tokens meant, and in a command
// with no word holding a character the shell would expand, so writing a word
// again never splits, joins, runs or expands one; otherwise the marker alone.
function readBack(output: string, meant: ReadonlyArray<Pick<Token, "kind" | "value">>, command: boolean): string {
  const { tokens, stoppedAt } = lexShell(output)
  const same = stoppedAt === undefined && tokens.length === meant.length
    && tokens.every((token, index) => token.kind === meant[index]!.kind && token.value === meant[index]!.value
      && (!command || token.kind === "operator" || expandingSources(output, token).length === 0))
  return same ? output : marker
}

// The words shell text reads as, or undefined when it does not read as words.
// Tests use it to check that emitted text reads back as the words meant.
export function inventoryShellWords(text: string): string[] | undefined {
  const { tokens, stoppedAt } = lexShell(text)
  return stoppedAt === undefined ? tokens.flatMap((token) => (token.kind === "word" ? [token.value] : [])) : undefined
}

// Whether the protocol backstop would refuse text for a scheme's or key's
// value, as this module mirrors it. Tests use it to check that the mirror and
// the backstop agree, so the two cannot drift apart unseen.
export function inventoryBackstopRefuses(text: string): boolean {
  return refusalAt(text) !== undefined
}

// Text a shell does not run: a rule, a matcher, a name, a prompt or a URL. It
// keeps its source spelling, a `*` in `Bash(pnpm test:*)` included, and fits
// `maximum`, the cap of the field it fills; a hook's URL or prompt fills its
// command.
export function redactInventoryText(text: string, maximum: number = inventoryFieldCaps.command): string {
  return redactShell(text, 0, false, false, maximum)
}

// A command line a shell runs: a hook's or a helper's command. Pattern and
// brace characters are written so the shell reads the words shown.
export function redactInventoryCommand(text: string): string {
  return redactShell(text, 0, false, true, inventoryFieldCaps.command)
}

// Shell text in an argument a hook would pass on to a shell: a command run by
// `$(...)`, backquotes, `<(...)`, `>(...)` or zsh's `=(...)`, a `${...}` that
// is not bare, or `$'...'` and `$"..."`, which are not POSIX quoting.
const runsOrExpands = /\$\(|`|[<>]\(|^=\(|\$\{(?!(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])\})|\$['"]/u

// A command given as an argument vector. Each argument is one word whatever it
// holds, so the same rules run on the arguments as given, and a shell's `-c`
// script is read as shell text. An argument that holds shell text that runs or
// expands is redacted from that argument on, as unreadable shell text is. An
// argument that holds a control or format character is shown as the marker.
// An argument with any character the shell reads specially, a pattern
// character included, is shown single-quoted, a single quote as '"'"', so no
// shown argument runs, expands or splits, and no backslash stands between a
// key and its [REDACTED]. The output is read again, as shell text is, and fits
// the command's cap: the arguments are kept while they fit with the marker
// after them.
export function redactInventoryArgv(argv: readonly string[]): string {
  const tokens: Word[] = argv.map((value, index) => ({
    kind: "word", start: index, end: index, value, characters: Array.from({ length: value.length }, () => ({ quoting: "", source: 0 })),
  }))
  const plan = planTokens(tokens, tokens.map(() => false), argv.map((value) => value[0] ?? ""), 0, false, true)
  const words = plan.stopAfter === undefined ? plan.values : plan.values.slice(0, plan.stopAfter + 1)
  // Any other argument is judged as given. A shell's script was read as shell
  // text already, and must still read.
  const unreadable = words.findIndex((word, index) => (plan.scripts.has(index) ? lexShell(word).stoppedAt !== undefined : runsOrExpands.test(argv[index]!)))
  const shown = (unreadable === -1 ? words : [...words.slice(0, unreadable), marker]).map((word) => (controlCharacter.test(word) ? marker : word))
  const spellings = shown.map(argumentWord)
  // Every argument when the line fits; otherwise the most whole arguments
  // that fit with a blank and the marker after them. The count comes from
  // the arguments' lengths, so the line is built once however many are
  // dropped.
  const cap = inventoryFieldCaps.command
  let kept = shown.length
  if (spellings.reduce((total, spelling) => total + spelling.length + 1, -1) > cap) {
    kept = 0
    let length = 0
    while (kept < spellings.length && length + spellings[kept]!.length + 1 + marker.length <= cap) {
      length += spellings[kept]!.length + 1
      kept += 1
    }
  }
  // A line the protocol backstop would still refuse keeps the arguments that
  // end before where it reads the trigger, with the marker after them; each
  // try keeps fewer, so the checks end.
  for (;;) {
    const line = kept === shown.length ? spellings.join(" ") : [...spellings.slice(0, kept), marker].join(" ")
    const meant = kept === shown.length ? shown : [...shown.slice(0, kept), marker]
    const read = readBack(line, meant.map((value) => ({ kind: "word", value })), true)
    const at = read === marker ? undefined : refusalAt(read)
    if (at === undefined) return read
    let before = 0
    for (let length = spellings[0]!.length; before < kept && length <= at; length += 1 + (spellings[before + 1]?.length ?? 0)) before += 1
    kept = Math.min(before, kept - 1)
  }
}
