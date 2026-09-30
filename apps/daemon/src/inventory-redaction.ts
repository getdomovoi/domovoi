// Redaction for the text a repository's provider files supply to the tool
// inventory: hook and server commands, rules and names. This is the guarantee;
// the protocol's credential backstop behind it only refuses forms it knows, and
// an entry it still refuses is dropped and counted by the reader.
//
// Every text is cut at its first trigger. It is read in every view the
// backstop reads, and in every view of those views: as written, quoted
// strings and all; after one layer of percent decoding; after backslash and
// \u escapes; as the words the shell assembles; and as its double-quoted
// strings alone (a JSON argv). Each of those readings is taken again of every
// view another makes, until no new view appears. A text whose views still
// change past maximumViewDepth readings or maximumViews views is not read
// further: it is cut after its program name, or shown as [REDACTED] alone
// when that name's own views do not settle or hold a trigger; a script in it
// that does not settle cuts the whole text the same way.
//
// A trigger is a scheme word and a blank after it, in any case; a sensitive
// key or flag, an assignment or an environment-style key, where the backstop
// reads one before its separator; a header flag (-H, alone or last among
// short options, --header, --proxy-header); and every credential shape the
// backstop knows (URL user info, a known token prefix, a JSON Web Token, an
// access key, a private key's header). The scheme words, key parts and
// shapes are the protocol's own, read from it rather than copied. Each view
// maps every character to the source text it was read from, so a trigger read
// in any view cuts the text at the first source character it came from: the
// words before it are kept, the word it starts in is kept up to that
// character, and the rest reads [REDACTED].
// No value is judged and no prose is let through, so no view or spelling can
// show what follows a trigger. The script a shell's `-c` option takes (bash,
// zsh and the rest, `-lc` included) is read in turn as text of its own, to a
// bounded depth, and a cut in it cuts the text around it. A command given as
// an argument vector is cut at whole arguments.
//
// Before the cut, a URL keeps its scheme and host; its whole path after the
// host and every query and fragment value (a bare part in whole) read
// [REDACTED]. Text that does not read as shell words (an unclosed quote,
// `$(...)`, backquotes, `<(...)`, `>(...)`, `=(...)`, a `${...}` with an
// operator, `$'...'`, a here-document) is cut where reading stopped. The
// protocol refuses a control or format character anywhere in a text, so the
// text is cut at the word or gap that holds one. The daemon's durable-text
// redaction leaves `DATABASE_URL=x`, `https://tok@host` and `Bearer tok`
// alone, so this pass is separate from it.
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
// that still holds such a character unquoted, is cut after its program name,
// or shown as [REDACTED] alone.
//
// Every output fits the protocol's cap on the field it fills: when it would
// not, whole words are kept while they fit and the rest is [REDACTED]. Last,
// the backstop judges each output once, and one it would still refuse is cut
// after its program name, or shown as [REDACTED] alone. Every step reads the
// text in work that grows linearly with it.

import {
  credentialRules,
  credentialShapeAt,
  holdsCredential,
  isCredentialKey,
  isCredentialLocationKey,
  maximumToolInventoryCommandLength,
  maximumToolInventoryDetailLength,
  maximumToolInventoryEventLength,
  maximumToolInventoryHelperNameLength,
  maximumToolInventoryMatcherLength,
  maximumToolInventoryNameLength,
  maximumToolInventoryRuleLength,
  nameHoldsCredential,
  toolInventoryPathSchema,
} from "@getdomovoi/protocol"

import { operandPieces } from "./credential-stores.js"
import { namesSecretPath } from "./permission-policy.js"

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

// What comes before a scheme word where the protocol backstop does not read
// one (a letter, digit, underscore or hyphen), and before a key or flag (a
// dot too). So `?Bearer x` in a URL's query is a scheme word, and `x-H` no
// flag.
const schemeBoundary = /[\p{L}\p{N}_-]/u
const keyBoundary = /[\p{L}\p{N}_.-]/u
// Words as a pattern's alternatives, each read literally.
const alternatives = (words: readonly string[]) => words.map((word) => word.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&")).join("|")
// A scheme word of the protocol's, in any case, and the blank the backstop
// reads after one. Whatever follows is its value: prose too.
const schemeTrigger = new RegExp(String.raw`(?:${alternatives(credentialRules.schemeWords)})\s`, "iuy")
// A key as the backstop's pattern reads one before its separator: a flag's
// dashes, a quote, the name and a quote.
const keyTrigger = /(-{1,2})?(["'`]?)([A-Za-z_][A-Za-z0-9_.-]*)(["'`]?)/uy
// A header flag: curl's -H, alone or last among short options (-sH), with
// its value in the same word or the next; --header and --proxy-header, as
// curl and wget read them.
const headerFlagTrigger = /-[A-Za-z]*H|--(?:proxy-)?header(?![A-Za-z0-9_-])/uy
const blankCharacter = /\s/u
const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/u
const environmentStyleKey = /^[A-Z_][A-Z0-9_]+$/u
// What an assignment's name comes after at a word's start.
const assignmentBoundary = /[\s(;&|`<]/u
const urlStart = /[A-Za-z][A-Za-z0-9+.-]*:\/\//uy

// Shells whose `-c` option takes a script, read as words in turn. A script
// nested deeper than this cuts the text at its start.
const shells = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "yash"])
const maximumDepth = 4

function isMarker(value: string): boolean {
  return value === marker || value === `"${marker}"` || value === `'${marker}'`
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
// marker. A cut inside a hidden span ends with that span's marker. A cut in a
// query or fragment part's name is moved to the part's start: the name cut
// short would read as a bare part, which is a value in whole.
function writtenUrl(url: string, hides: readonly Change[], given = Number.POSITIVE_INFINITY): string {
  let cut = given
  const authorityStart = url.indexOf("://") + 3
  const query = url.slice(authorityStart).search(/[?#]/u)
  if (query !== -1 && authorityStart + query < cut && cut < url.length) {
    let start = cut
    while (start > authorityStart + query + 1 && !"&;?#=".includes(url[start - 1]!)) start -= 1
    if (url[start - 1] !== "=") cut = start
  }
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
// and ends in the source. The characters of one `${...}` share a spelling. The
// first character of a quoted run notes where its opening quote is.
interface Character { quoting: Quoting; source: number; end: number; opens?: number }

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
  const add = (piece: string, quoting: Quoting, source: number, end = source + 1) => {
    value += piece
    for (let index = 0; index < piece.length; index += 1) {
      characters.push(opening === undefined ? { quoting, source, end } : { quoting, source, end, opens: opening })
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
        if (next !== "\n") add(next, "", index, index + 2)
        index += 2
      }
    } else if (character === "`") return undefined
    else if (character === "$") {
      const end = expansionEnd(text, index, "")
      if (end === undefined) return undefined
      add(text.slice(index, end), "", index, end)
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
function doubleQuotedEnd(text: string, open: number, add: (piece: string, quoting: Quoting, source: number, end?: number) => void): number | undefined {
  let index = open + 1
  while (index < text.length) {
    const character = text[index]!
    if (character === "\"") return index + 1
    if (character === "`") return undefined
    if (character === "\\") {
      const next = text[index + 1]
      if (next !== undefined && "$`\"\\\n".includes(next)) {
        if (next !== "\n") add(next, "\"", index, index + 2)
        index += 2
      } else {
        add("\\", "\"", index)
        index += 1
      }
    } else if (character === "$") {
      const end = expansionEnd(text, index, "\"")
      if (end === undefined) return undefined
      add(text.slice(index, end), "\"", index, end)
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

// Where a text is cut: a token, and how many characters of its value are
// kept. A token cut with none kept is written as the marker in its place, and
// a token index past the last cuts the text after its tokens.
interface CutPlace { token: number; kept: number }

// What the plan decided for each token: its new value, the first character of
// it written again, and whether it was merged into the word before it; and
// the token the output stops after (its value ends in the marker) or before
// (the marker is written in its place).
interface Plan { values: string[]; anchors: number[]; dropped: boolean[]; stopAfter?: number; stopBefore?: number }

// A view of a text as the protocol backstop reads it: its characters, and for
// each where in the text its spelling starts. A character read from other
// text than itself (`%54` as `T`, `\-` as `-`) starts where that text does;
// the blank put between two strings (a JSON argv's) starts at the quote that
// closed the one before. Every view reads the text in order, so a later
// character never starts before an earlier one.
interface View { text: string; from: number[] }

// A view built from another view's characters, each mapped to the text.
class ViewBuilder {
  private readonly parts: string[] = []
  private readonly from: number[] = []
  constructor(private readonly source: View) {}
  // The source's characters from `start` to `end`, as they are.
  copy(start: number, end: number): void {
    this.parts.push(this.source.text.slice(start, end))
    for (let index = start; index < end; index += 1) this.from.push(this.source.from[index]!)
  }
  // `written`, read from the source's characters from `start` on.
  read(written: string, start: number): void {
    this.parts.push(written)
    for (let index = 0; index < written.length; index += 1) this.from.push(this.source.from[start]!)
  }
  // Another view's characters, already mapped to the text.
  append(view: View): void {
    this.parts.push(view.text)
    // One at a time: a long view spread as arguments would overflow the stack.
    for (let index = 0; index < view.text.length; index += 1) this.from.push(view.from[index]!)
  }
  view(): View {
    return { text: this.parts.join(""), from: this.from }
  }
}

// Every match of `pattern` (global) in a view written as `replacement` says.
function replacedView(view: View, pattern: RegExp, replacement: (match: RegExpExecArray) => string): View {
  const builder = new ViewBuilder(view)
  let cursor = 0
  for (const match of view.text.matchAll(pattern)) {
    builder.copy(cursor, match.index)
    builder.read(replacement(match), match.index)
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
    if (closed !== -1) builder.read(" ", closed)
    builder.append(unescaped({ text: text.slice(open + 1, end), from: view.from.slice(open + 1, end) }))
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
    if (words > 0) builder.read(" ", ended)
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
      if (index + 1 < text.length) builder.read(text[index + 1]!, index)
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
        builder.read(written, index)
        index += whole.length
      }
      index += 1
    } else if (character === "\"" || (character === "$" && text[index + 1] === "\"")) {
      startWord()
      index += character === "$" ? 2 : 1
      while (index < text.length && text[index] !== "\"") {
        const escaped = text[index] === "\\" && /[$`"\\]/u.test(text[index + 1] ?? "")
        if (escaped) builder.read(text[index + 1]!, index)
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

// The readings the protocol backstop takes a text through, each read again in
// every view another one makes: one layer of percent encoding; \u escapes and
// then backslash escapes; the words the shell assembles; and the double-quoted
// strings alone. A reading that cannot change the view (no `%`, no backslash,
// no double quote) is not built: it would be the same view, or an empty one.
const viewReadings: ReadonlyArray<(view: View) => View | undefined> = [
  (view) => (view.text.includes("%") ? percentDecoded(view) : undefined),
  (view) => (view.text.includes("\\") ? unescaped(view) : undefined),
  shellWordsView,
  (view) => (view.text.includes("\"") ? quotedStringsView(view) : undefined),
]

// How many readings deep views are read, and how many views of one text are
// read at most. Each reading strips one layer (a quote, an escape, an
// encoding), so a text's views stop changing within as many readings as it
// has layers; one whose views go on changing past either bound is not read
// further, and is cut after its program name. Both bounds keep the work a
// constant number of linear passes.
const maximumViewDepth = 6
const maximumViews = 64

// Whether `read`, a view with the same text as `known`, maps any character
// to an earlier source character; `known` is given the earlier of the two for
// each. Each reading maps a character from where the view it reads maps it,
// so every view read from `known` after that maps as early as one read from
// `read` would.
function mappedEarlier(known: View, read: View): boolean {
  let earlier = false
  for (let index = 0; index < known.from.length; index += 1) {
    if (read.from[index]! < known.from[index]!) {
      known.from[index] = read.from[index]!
      earlier = true
    }
  }
  return earlier
}

// Every view of `text` the protocol backstop reads, and every view of those
// views, as it reads the words a shell hands a command (an argument vector,
// or a script): `"To'ken'"` is `To'ken'` in the shell's words, and `Token`
// in theirs. Each view is read once, the first time its text appears; a view
// with the same text is left out, and only lowers where its characters map.
// Views are read breadth first from the text as written. `settled` is false
// when a view still new, or mapped earlier, would be read more than
// maximumViewDepth readings deep or past maximumViews views: the views
// returned are then only some of them.
function viewsOf(text: string): { views: View[]; settled: boolean } {
  const source: View = { text, from: Array.from({ length: text.length }, (_, index) => index) }
  const byText = new Map<string, View>([[text, source]])
  const views = [source]
  const queue: Array<{ view: View; depth: number }> = [{ view: source, depth: 0 }]
  for (let next = 0; next < queue.length; next += 1) {
    const { view, depth } = queue[next]!
    for (const reading of viewReadings) {
      const read = reading(view)
      if (read === undefined) continue
      const known = byText.get(read.text)
      if (known !== undefined && !mappedEarlier(known, read)) continue
      if (depth >= maximumViewDepth || queue.length >= maximumViews) return { views, settled: false }
      if (known === undefined) {
        byText.set(read.text, read)
        views.push(read)
      }
      queue.push({ view: known ?? read, depth: depth + 1 })
    }
  }
  return { views, settled: true }
}

// Whether a key the backstop's pattern reads at `at` is a trigger: the key
// and the separator after it are one the backstop refuses a value for, as
// its pairHoldsValue judges them, whatever the value is. A flag and a
// sensitive key before blanks; a sensitive key before `=` or `:`; an
// assignment's name at a word's start; an environment-style name before a
// colon, in quotes or with an underscore and a blank after the colon. Only the
// key, its separator and one character after are read.
function keyTriggerAt(text: string, at: number, before: string): boolean {
  keyTrigger.lastIndex = at
  const match = keyTrigger.exec(text)
  if (match === null) return false
  const [whole, flag = "", , key = "", quoteAfterKey = ""] = match
  const keyEnd = at + whole.length
  let joiner = keyEnd
  while (joiner < text.length && blankCharacter.test(text[joiner]!)) joiner += 1
  const sensitive = isCredentialKey(key, credentialRules)
  // A flag that says where a credential lives takes a secret path (#541).
  const location = flag !== "" && isCredentialLocationKey(key, credentialRules)
  if (text[joiner] === "=") return sensitive || location || (flag === "" && environmentName.test(key) && (at === 0 || assignmentBoundary.test(before)))
  if (text[joiner] === ":") {
    const blankAfter = joiner + 1 < text.length && blankCharacter.test(text[joiner + 1]!)
    return sensitive || (environmentStyleKey.test(key) && (quoteAfterKey !== "" || (blankAfter && key.includes("_"))))
  }
  return joiner > keyEnd && flag !== "" && (sensitive || location)
}

// The first index of a view's text where a trigger starts, or undefined. A
// scheme word, a key or a flag is tried at each index where the backstop
// reads one, in constant work apart from its own word and the blanks after
// it, and the protocol finds the first credential shape in linear work.
function firstTriggerIn(text: string): number | undefined {
  const shape = credentialShapeAt(text)
  const end = shape ?? text.length
  for (let at = 0; at < end; at += 1) {
    const before = at === 0 ? "" : text[at - 1]!
    schemeTrigger.lastIndex = at
    if (!schemeBoundary.test(before) && schemeTrigger.test(text)) return at
    if (keyBoundary.test(before)) continue
    headerFlagTrigger.lastIndex = at
    if (headerFlagTrigger.test(text) || keyTriggerAt(text, at, before)) return at
  }
  return shape
}

// Where in `text` the first trigger any view reads starts, or undefined. A
// view's characters start where their spelling does, so the first source
// character a trigger came from is where its first character starts.
// `settled` is false when not every view was read.
interface Cut { at: number | undefined; settled: boolean }
function firstTrigger(text: string): Cut {
  const { views, settled } = viewsOf(text)
  let first: number | undefined
  for (const view of views) {
    const at = firstTriggerIn(view.text)
    if (at !== undefined && (first === undefined || view.from[at]! < first)) first = view.from[at]!
  }
  return { at: first, settled }
}

// Whether a word shown alone has every view read and no trigger in any.
function wordReadsClean(word: string): boolean {
  const { at, settled } = firstTrigger(word)
  return settled && at === undefined
}

// Where shell text is cut: the first source index from which nothing is
// shown, or undefined when it is shown whole. It is the first of: where
// reading it as words stopped; the start of a token that holds a control
// character, or of a gap between tokens that holds one; where a trigger
// starts in any view; and where a shell's script is cut, read as text of its
// own (a script nested too deep is cut at its start). When not every view of
// the text or of a script in it was read, `settled` is false and the text is
// cut after its program name, a word whose own views read clean, or else at
// its start; the text around such a script is cut the same way.
function cutOf(text: string, depth: number, { tokens, stoppedAt }: Lexed = lexShell(text)): Cut {
  let cut = stoppedAt
  const earlier = (at: number) => {
    if (cut === undefined || at < cut) cut = at
  }
  const scripts = shellScripts(tokens)
  const controlAt = (): number | undefined => {
    let gapStart = 0
    for (const [index, token] of tokens.entries()) {
      if (controlCharacter.test(text.slice(gapStart, token.start))) return gapStart
      // A script's control characters are its own text's, read below.
      if (!scripts.has(index) && controlCharacter.test(text.slice(token.start, token.end))) return token.start
      gapStart = token.end
    }
    return stoppedAt === undefined && controlCharacter.test(text.slice(gapStart)) ? gapStart : undefined
  }
  const control = controlAt()
  if (control !== undefined) earlier(control)
  const trigger = firstTrigger(text)
  let { settled } = trigger
  if (trigger.at !== undefined) earlier(trigger.at)
  for (const index of scripts) {
    const word = tokens[index] as Word
    if (cut !== undefined && word.start >= cut) break
    const inner = depth >= maximumDepth ? { at: 0, settled: true } : cutOf(word.value, depth + 1)
    if (!inner.settled) settled = false
    else if (inner.at !== undefined) earlier(word.characters[inner.at]?.source ?? word.start)
  }
  if (!settled) {
    const program = tokens[0]
    earlier(program?.kind === "word" && wordReadsClean(text.slice(program.start, program.end)) ? program.end : 0)
  }
  return { at: cut, settled }
}

// The token a source index `cut` falls in, and how many characters of its
// value have their whole spelling before it.
function cutPlace(tokens: readonly Token[], cut: number): CutPlace {
  const token = tokens.findIndex((candidate) => candidate.end > cut)
  const found = tokens[token]
  if (found === undefined) return { token: tokens.length, kept: 0 }
  if (found.kind === "operator" || found.start >= cut) return { token, kept: 0 }
  let kept = 0
  while (kept < found.characters.length && found.characters[kept]!.end <= cut) kept += 1
  return { token, kept }
}

// The plan for the tokens of shell text or an argument vector, cut at `cut`
// when one is given. `glued` says a token is written with no blank before the
// next one. Before the cut, each URL keeps its scheme and host and hides the
// rest, and each shell's script is redacted as text of its own; the word the
// cut falls in keeps its value up to the cut, then the marker.
function planTokens(tokens: readonly Token[], glued: readonly boolean[], cut: CutPlace | undefined, depth: number, command: boolean): Plan {
  // The tokens' values joined by one space, and where each starts and ends.
  let joined = ""
  const starts: number[] = []
  tokens.forEach((token, index) => {
    if (index > 0) joined += " "
    starts.push(joined.length)
    joined += token.value
  })
  const ends = tokens.map((token, index) => starts[index]! + token.value.length)
  const plan: Plan = { values: tokens.map((token) => token.value), anchors: tokens.map(() => Number.POSITIVE_INFINITY), dropped: tokens.map(() => false) }
  const { values, anchors, dropped } = plan
  const cutToken = cut?.token ?? tokens.length
  const cutKept = cut?.kept ?? 0
  // Where in the joined text the cut is.
  const cutAt = cut === undefined ? Number.POSITIVE_INFINITY : cutToken < tokens.length ? starts[cutToken]! + cutKept : joined.length
  const scripts = shellScripts(tokens)

  // A shell's script before the cut is written as its own redaction, whole,
  // and one the cut falls in as that redaction cut there.
  for (const index of scripts) {
    if (index > cutToken || (index === cutToken && cutKept === 0)) continue
    // The cut is before any script nested too deep; this only keeps a
    // mistaken plan from reading one.
    if (depth >= maximumDepth) {
      plan.stopBefore = index
      break
    }
    const written = redactShell(values[index]!, depth + 1, true, command, Number.POSITIVE_INFINITY, index === cutToken ? cutKept : undefined)
    anchors[index] = 0
    if (index !== cutToken) values[index] = written
    else if (written === marker) plan.stopBefore = index
    else {
      values[index] = written
      plan.stopAfter = index
    }
  }

  // A URL starting at `index` of the joined text, in `token`: it runs to the
  // end of its word, and on through operators written with no blank between
  // them (`https://h/?a=1&b#c`), as the shell would not read it. It is
  // written with what it hides, up to the cut when the cut falls in it. The
  // last token it reads in is returned, or undefined when no URL starts there.
  const urlAt = (token: number, index: number): number | undefined => {
    if (index > 0 && /[A-Za-z0-9+.-]/u.test(joined[index - 1]!)) return undefined
    urlStart.lastIndex = index
    if (!urlStart.test(joined) || urlStart.lastIndex > ends[token]!) return undefined
    let last = token
    // Where each token's text starts in the URL.
    const offsets = [0]
    let url = joined.slice(index, ends[token])
    while (last + 1 < tokens.length && glued[last] && (tokens[last + 1]!.kind === "word" || !/[<>\n]/u.test(tokens[last + 1]!.value))) {
      last += 1
      offsets.push(url.length)
      url += tokens[last]!.value
    }
    const urlCut = cutToken < token || cutToken > last ? Number.POSITIVE_INFINITY : cutToken === token ? cutAt - index : offsets[cutToken - token]! + cutKept
    const written = writtenUrl(url, urlHides(url), urlCut)
    if (written === url) return token
    values[token] = `${values[token]!.slice(0, index - starts[token]!)}${written}`
    anchors[token] = index - starts[token]!
    for (let merged = token + 1; merged <= Math.min(last, cutToken); merged += 1) dropped[merged] = true
    if (urlCut !== Number.POSITIVE_INFINITY) plan.stopAfter = token
    return last
  }
  for (let token = 0; token < tokens.length && starts[token]! < cutAt; token += 1) {
    if (tokens[token]!.kind !== "word" || scripts.has(token)) continue
    for (let index = starts[token]!; index < Math.min(ends[token]!, cutAt); index += 1) {
      const last = urlAt(token, index)
      if (last === undefined) continue
      token = last
      break
    }
  }

  // The token the cut falls in, when no URL or script took it.
  if (cut !== undefined && plan.stopAfter === undefined && plan.stopBefore === undefined) {
    if (cutKept === 0) plan.stopBefore = cutToken
    else {
      values[cutToken] = `${tokens[cutToken]!.value.slice(0, cutKept)}${marker}`
      anchors[cutToken] = cutKept
      plan.stopAfter = cutToken
    }
  }
  return plan
}

const markerWord: Pick<Token, "kind" | "value"> = { kind: "word", value: marker }

// Shell text cut at `cut`, a source index, when one is given, with what each
// URL hides hidden before it. `depth` counts the shells it is nested in;
// `nested` is true inside one. `command` is true for a command line a shell
// runs, whose pattern characters are written so they do not expand. The
// output is at most `maximum` long: when it would be longer, the tokens
// written are kept while they fit with the marker after them. Outside a
// shell, the backstop judges the output once, and one it would still refuse
// is cut after its program name, or is the marker alone.
function redactShell(text: string, depth: number, nested: boolean, command: boolean, maximum: number, cut: number | undefined, lexed: Lexed = lexShell(text)): string {
  const { tokens, stoppedAt } = lexed
  const glued = tokens.map((token, index) => tokens[index + 1]?.start === token.end)
  const stop = stoppedAt === undefined || (cut !== undefined && cut < stoppedAt) ? cut : stoppedAt
  const plan = planTokens(tokens, glued, stop === undefined ? undefined : cutPlace(tokens, stop), depth, command)
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
      const read = readBack(`${output.slice(0, length)} ${marker}`, [...meant.slice(0, count), markerWord], command)
      if (read !== undefined) return read
    }
    return marker
  }
  // The program name, when the first token written is a word kept whole, with
  // the marker after it; otherwise the marker alone.
  const programOnly = () => {
    const first = cuts[0]
    const program = meant[0]
    if (first === undefined || program?.kind !== "word" || plan.stopAfter === 0 || first.length + 1 + marker.length > maximum) return marker
    return readBack(`${output.slice(0, first.length)} ${marker}`, [program, markerWord], command) ?? marker
  }
  // The output read back and fitted to `maximum`; text that does not read
  // back is cut after its program name. Outside a shell, one output the
  // backstop would refuse is cut after its program name, and one that still
  // would be is the marker: at most two checks, each of a fitted output.
  const finish = (whole: string) => {
    const read = readBack(whole, meant, command)
    const result = read === undefined ? programOnly() : read.length <= maximum ? read : fitted()
    if (nested || result === marker || !holdsCredential(result)) return result
    const program = programOnly()
    return program === marker || holdsCredential(program) ? marker : program
  }
  // The rest of the text from `gap` on is cut: a gap with a control
  // character in it is written as one blank.
  const cutRest = (gap: string) => {
    meant.push(markerWord)
    const blank = output === "" ? "" : controlCharacter.test(gap) || (gap === "" && endsInWord) ? " " : gap
    return finish(`${output}${blank}${marker}`)
  }
  for (const [index, token] of tokens.entries()) {
    if (plan.stopBefore === index) return cutRest(text.slice(cursor, token.start))
    // A merged token was written with no blank before it; its text is in the
    // word before it now.
    if (plan.dropped[index]) {
      cursor = token.end
      continue
    }
    const gap = text.slice(cursor, token.start)
    const spelling = token.kind === "word" ? rewrittenWord(text, token, plan.values[index]!, plan.anchors[index]!, nested, command) : token.value
    if (controlCharacter.test(gap) || controlCharacter.test(spelling)) return cutRest(gap)
    output += `${gap}${spelling}`
    meant.push({ kind: token.kind, value: token.kind === "word" ? plan.values[index]! : token.value })
    cursor = token.end
    endsInWord = token.kind === "word"
    cuts.push({ length: output.length, count: meant.length })
    if (plan.stopAfter === index) return finish(output)
  }
  const rest = text.slice(cursor, stoppedAt ?? text.length)
  return plan.stopBefore !== undefined || stoppedAt !== undefined || controlCharacter.test(rest) ? cutRest(rest) : finish(`${output}${rest}`)
}

// Whether a command's word, or a piece of it after `=` or `:`, names a
// credential store or secret file, by the judge the hard gate and the
// approval card use (namesSecretPath, #541). A rule, name or prompt is not a
// command and keeps its paths: `Read(./.env)` is a rule about one.
function namesSecretArgument(word: string): boolean {
  return operandPieces(word).some(namesSecretPath)
}

// Shell text a hook or provider file supplies, cut at its first trigger. A
// command line is also cut at its first word that names a secret path; a
// shell's script is judged as one word, so a path in it cuts at the script.
function redactText(text: string, command: boolean, maximum: number): string {
  const lexed = lexShell(text)
  let { at } = cutOf(text, 0, lexed)
  if (command) {
    const secret = lexed.tokens.find((token) => token.kind === "word" && namesSecretArgument(token.value))
    if (secret !== undefined && (at === undefined || secret.start < at)) at = secret.start
  }
  return redactShell(text, 0, false, command, maximum, at, lexed)
}

// The output when it reads back as exactly the tokens meant, and in a command
// with no word holding a character the shell would expand, so writing a word
// again never splits, joins, runs or expands one; otherwise undefined.
function readBack(output: string, meant: ReadonlyArray<Pick<Token, "kind" | "value">>, command: boolean): string | undefined {
  const { tokens, stoppedAt } = lexShell(output)
  const same = stoppedAt === undefined && tokens.length === meant.length
    && tokens.every((token, index) => token.kind === meant[index]!.kind && token.value === meant[index]!.value
      && (!command || token.kind === "operator" || expandingSources(output, token).length === 0))
  return same ? output : undefined
}

// The words shell text reads as, or undefined when it does not read as words.
// Tests use it to check that emitted text reads back as the words meant.
export function inventoryShellWords(text: string): string[] | undefined {
  const { tokens, stoppedAt } = lexShell(text)
  return stoppedAt === undefined ? tokens.flatMap((token) => (token.kind === "word" ? [token.value] : [])) : undefined
}

// Whether the check this module makes on each output refuses text: the
// protocol backstop's own, not a copy of it. Tests use it to check that the
// check and the inventory schema agree.
export function inventoryBackstopRefuses(text: string): boolean {
  return holdsCredential(text)
}

// Text a shell does not run: a rule, a matcher, a name, a prompt or a URL. It
// keeps its source spelling, a `*` in `Bash(pnpm test:*)` included, and fits
// `maximum`, the cap of the field it fills; a hook's URL or prompt fills its
// command.
export function redactInventoryText(text: string, maximum: number = inventoryFieldCaps.command): string {
  return redactText(text, false, maximum)
}

// A path a repository or the machine names, shown in a file record, a rule's
// detail or a trust refusal: text, cut at its first trigger and fitted to a
// detail's cap, which the protocol also gives a path. A path the protocol's
// path schema still refuses, one with a blank at either end included, is the
// marker. The path as read stays with the caller, for reads and the digest.
export function redactInventoryPath(path: string): string {
  const shown = redactText(path, false, inventoryFieldCaps.detail)
  return toolInventoryPathSchema.safeParse(shown).success ? shown : marker
}

// An environment key name a provider file supplies: shown as it is, or as the
// marker when the name is itself shaped like a credential, as the protocol's
// nameHoldsCredential reads one. The entry is listed either way.
export function redactInventoryEnvKey(key: string): string {
  return nameHoldsCredential(key) ? marker : key
}

// A remote tool server's host and port, from the URL a provider file gives:
// the marker when a label is shaped like a credential. The host is read as
// the URL parser gives it and as it is written in the URL, since the parser
// lower-cases it and an access key id is known by its upper case.
export function redactInventoryHost(host: string, url: string): string {
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/u.exec(url)?.[1] ?? ""
  const written = authority.slice(authority.lastIndexOf("@") + 1)
  return nameHoldsCredential(host, true) || nameHoldsCredential(written, true) ? marker : host
}

// A command line a shell runs: a hook's or a helper's command. Pattern and
// brace characters are written so the shell reads the words shown.
export function redactInventoryCommand(text: string): string {
  return redactText(text, true, inventoryFieldCaps.command)
}

// A command line whose every argument can be a credential no trigger names,
// such as a header helper, which prints header names and values: shown as its
// program alone, with the marker after it when anything follows. A program
// that is not the first shell word (text that opens with an operator or an
// expansion, or does not read as words there), or that the argument vector
// redaction cuts (an assignment, a trigger), is the marker alone. So is a
// first word spelled with an unquoted `#`: it opens a shell comment, which
// the lexer does not model, so it is not the program and its text can be
// anything.
export function redactInventoryProgram(text: string): string {
  const { tokens, stoppedAt } = lexShell(text)
  const first = tokens[0]
  if (first?.kind !== "word" || (stoppedAt !== undefined && stoppedAt < first.end) || text[first.start] === "#") return marker
  const program = redactInventoryArgv([first.value])
  const words = inventoryShellWords(program)
  if (words?.length !== 1 || words[0] !== first.value) return marker
  const rest = tokens.length > 1 || stoppedAt !== undefined || text.slice(first.end).trim() !== ""
  if (!rest) return program
  const shown = `${program} ${marker}`
  return shown.length <= inventoryFieldCaps.command && !holdsCredential(shown) ? shown : marker
}

// Shell text in an argument a hook would pass on to a shell: a command run by
// `$(...)`, backquotes, `<(...)`, `>(...)` or zsh's `=(...)`, a `${...}` that
// is not bare, or `$'...'` and `$"..."`, which are not POSIX quoting.
const runsOrExpands = /\$\(|`|[<>]\(|^=\(|\$\{(?!(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])\})|\$['"]/u

// A command given as an argument vector, cut at whole arguments: at the first
// argument any view of the line of arguments, each shown as one word, reads a
// trigger in; at an argument that holds shell text that runs or expands; and
// at a shell's `-c` script that is cut when read as shell text. A script
// before the cut is shown as its redaction, and each URL with what it hides
// hidden. An argument that holds a control or format character is shown as
// the marker. An argument with any character the shell reads specially, a
// pattern character included, is shown single-quoted, a single quote as
// '"'"', so no shown argument runs, expands or splits. The output is read
// again, as shell text is, and fits the command's cap: the arguments are kept
// while they fit with the marker after them. The backstop judges the output
// once, as it judges shell text.
export function redactInventoryArgv(argv: readonly string[]): string {
  const tokens: Word[] = argv.map((value, index) => ({ kind: "word", start: index, end: index, value, characters: [] }))
  const scripts = shellScripts(tokens)
  const given = argv.map(argumentWord)
  let cut = argv.length
  const trigger = firstTrigger(given.join(" "))
  let { settled } = trigger
  if (trigger.at !== undefined) {
    // The argument whose spelling ends after the trigger's start.
    let end = -1
    for (cut = 0; cut < given.length; cut += 1) {
      end += given[cut]!.length + 1
      if (end > trigger.at) break
    }
  }
  for (let index = 0; index < cut; index += 1) {
    const argument = argv[index]!
    if (namesSecretArgument(argument)) {
      cut = index
      break
    }
    const script = scripts.has(index) ? cutOf(argument, 1) : undefined
    if (script !== undefined && !script.settled) settled = false
    if (script === undefined ? runsOrExpands.test(argument) : !script.settled || script.at !== undefined) {
      cut = index
      break
    }
  }
  // When not every view was read, of the line or of a script in it, the line
  // is cut after its program name when that name's own views read clean, and
  // is the marker alone otherwise.
  if (!settled && argv.length > 0) cut = Math.min(cut, wordReadsClean(given[0]!) ? 1 : 0)
  const plan = planTokens(tokens, tokens.map(() => false), cut < argv.length ? { token: cut, kept: 0 } : undefined, 0, true)
  const kept = plan.values.slice(0, cut).map((word, index) => (controlCharacter.test(argv[index]!) ? marker : word))
  const shown = cut < argv.length ? [...kept, marker] : kept
  const spellings = shown.map(argumentWord)
  // Every argument when the line fits; otherwise the most whole arguments
  // that fit with a blank and the marker after them. The count comes from
  // the arguments' lengths, so the line is built once however many are
  // dropped.
  const cap = inventoryFieldCaps.command
  let fits = shown.length
  if (spellings.reduce((total, spelling) => total + spelling.length + 1, -1) > cap) {
    fits = 0
    let length = 0
    while (fits < spellings.length && length + spellings[fits]!.length + 1 + marker.length <= cap) {
      length += spellings[fits]!.length + 1
      fits += 1
    }
  }
  const line = fits === shown.length ? spellings.join(" ") : [...spellings.slice(0, fits), marker].join(" ")
  const meant = fits === shown.length ? shown : [...shown.slice(0, fits), marker]
  const read = readBack(line, meant.map((value) => ({ kind: "word", value })), true)
  if (read !== undefined && !holdsCredential(read)) return read
  // The program name alone with the marker after it, then the marker alone:
  // at most one more check.
  const program = shown[0]
  if (program === undefined || program === marker || spellings[0]!.length + 1 + marker.length > cap) return marker
  const cutDown = readBack(`${spellings[0]!} ${marker}`, [{ kind: "word", value: program }, markerWord], true)
  return cutDown === undefined || holdsCredential(cutDown) ? marker : cutDown
}
