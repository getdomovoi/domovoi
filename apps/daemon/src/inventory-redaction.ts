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
// rule hides is still read as one, so its own value is hidden too: `--token
// Bearer x` reads `--token [REDACTED] [REDACTED]`. Every rule reads the text
// in work that grows linearly with it. The daemon's durable-text redaction leaves
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

// A URL's user info, its whole path after the host, and every query and
// fragment part, redacted. A path can be the credential itself (a webhook's
// /services/T0/B0/XXXX) and no rule tells which segment is, so the path goes
// whole; an empty path or a bare `/` stays.
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
  const givenPath = question === -1 ? beforeHash : beforeHash.slice(0, question)
  const path = givenPath === "" || givenPath === "/" ? givenPath : `/${marker}`
  const query = question === -1 ? "" : `?${redactUrlParts(beforeHash.slice(question + 1))}`
  const fragment = hash === -1 ? "" : `#${redactUrlParts(rest.slice(hash + 1))}`
  return `${url.slice(0, authorityStart)}${host}${path}${query}${fragment}`
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
function spelled(text: string, quoting: Quoting, wordStart: boolean, command: boolean): string {
  if (quoting === "\"") return `${text.replace(/[\\"$`]/gu, "\\$&")}"`
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
function sourceSpelling(text: string, word: Word, end: number, command: boolean): string {
  if (!command) return text.slice(word.start, end)
  let spelling = ""
  let cursor = word.start
  for (const source of expandingSources(text, word)) {
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
// protocol backstop.
function rewrittenWord(text: string, word: Word, value: string, anchor: number, nested: boolean, command: boolean): string {
  if (value === word.value) return sourceSpelling(text, word, word.end, command)
  const { characters } = word
  let at = Math.min(anchor, commonPrefix(word.value, value))
  while (at > 0 && at < characters.length && characters[at - 1]!.source === characters[at]!.source) at -= 1
  const next = characters[at]
  const opens = nested ? next?.opens : undefined
  const prefix = sourceSpelling(text, word, opens ?? next?.source ?? word.end, command)
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

interface Change { start: number; end: number; text: string }

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

  const change = (token: number, from: number, to: number, text: string) => {
    changes[token]!.push({ start: from - starts[token]!, end: to - starts[token]!, text })
    consumed.add(token)
  }
  // Everything from `from` to the end of the text is redacted.
  const truncate = (token: number, from: number) => {
    change(token, from, ends[token]!, marker)
    stopAfter = token
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
  // next colon is. A header flag read them from the rest of its word, which
  // many flags in one word made quadratic.
  const nameRuns = new Int32Array(joined.length + 1)
  const blankRuns = new Int32Array(joined.length + 1)
  const colons = new Int32Array(joined.length + 1)
  nameRuns[joined.length] = joined.length
  blankRuns[joined.length] = joined.length
  colons[joined.length] = joined.length
  for (let at = joined.length - 1; at >= 0; at -= 1) {
    const character = joined[at]!
    nameRuns[at] = headerNameCharacter.test(character) ? nameRuns[at + 1]! : at
    blankRuns[at] = /\s/u.test(character) ? blankRuns[at + 1]! : at
    colons[at] = character === ":" ? at : colons[at + 1]!
  }

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
    truncate(token, index)
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
    const redacted = redactUrl(url)
    if (redacted === url) return ends[token]!
    change(token, index, ends[token]!, redacted)
    for (let merged = token + 1; merged <= last; merged += 1) {
      dropped[merged] = true
      consumed.add(merged)
    }
    return ends[last]!
  }

  const headerAt = (index: number): number | undefined => {
    if (index > 0 && !wordBoundary.test(joined[index - 1]!)) return undefined
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
    if (index > 0 && !/[\s"'`(=:,{[]/u.test(joined[index - 1]!)) return undefined
    scheme.lastIndex = index
    if (!scheme.test(joined)) return undefined
    const start = scheme.lastIndex
    const value = wordAtIndex(start)
    if (value === undefined) return undefined
    // A value in the next word is that whole word; one in the same word ends
    // where a word of prose would.
    let end = start
    if (value !== token) end = ends[value]!
    else while (end < ends[value]! && !/[\s"'`,;)]/u.test(joined[end]!)) end += 1
    // A value kept (a word of prose, or the marker) or hidden is still read
    // from its start by every rule, so a scheme or flag word in it is read as
    // one: `Bearer Basic x` reads `Bearer [REDACTED] [REDACTED]`. A flag is
    // hidden whole too, since the protocol backstop takes any word after a
    // scheme as its credential: `Bearer --token x` reads `Bearer [REDACTED]
    // [REDACTED]`. A change a rule then makes inside it (`--token=x`) is
    // taken into its marker.
    const kept = end === start || (end - start === marker.length && joined.startsWith(marker, start))
    if (!kept && (joined[start] === "-" || !isSchemeProse(start, end))) change(value, start, end, marker)
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
  const fitted = () => {
    for (let index = cuts.length - 1; index >= 0; index -= 1) {
      const { length, count } = cuts[index]!
      if (length + 1 + marker.length > maximum) continue
      const shortened = `${output.slice(0, length)} ${marker}`
      const read = readBack(shortened, [...meant.slice(0, count), { kind: "word", value: marker }], command)
      if (read !== marker) return read
    }
    return marker
  }
  const readsBack = (whole: string, words: ReadonlyArray<Pick<Token, "kind" | "value">>) => {
    const read = readBack(whole, words, command)
    return read.length <= maximum ? read : fitted()
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
  const line = kept === shown.length ? spellings.join(" ") : [...spellings.slice(0, kept), marker].join(" ")
  const meant = kept === shown.length ? shown : [...shown.slice(0, kept), marker]
  return readBack(line, meant.map((value) => ({ kind: "word", value })), true)
}
