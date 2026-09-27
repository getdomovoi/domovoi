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
// as a bare `Bearer x` does. The daemon's durable-text redaction leaves
// `DATABASE_URL=x`, `https://tok@host` and `Bearer tok` alone, so this pass is
// separate from it.
//
// A word no rule changes keeps its exact source text. A changed word keeps
// its source up to the first character a rule changed and writes the rest in
// the quoting that character was in, closed again, so the output always reads
// back as the same words and a second pass changes nothing. The script given
// to `sh -c` (bash, zsh and the rest, `-lc` included) is read as words in turn,
// to a bounded depth. It errs toward redacting: a value inside a quoted string
// runs to the string's end, and inside a script given to a shell it runs to
// the script's end, so `sh -c 'A=1 run'` reads `sh -c 'A=[REDACTED]'`.
//
// Text that does not read as shell words (an unclosed quote, `$(...)`,
// backquotes, `$'...'`, a here-document) is redacted from the word where
// reading stopped to the end of the text.

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

const wordBoundary = /[\s(;&|`<"'{]/u
const keyPair = /(-{1,2})?(["'`]?)([A-Za-z_][A-Za-z0-9_.-]*)\2(\s*[=:]\s*|\s+)/uy
const urlStart = /[A-Za-z][A-Za-z0-9+.-]*:\/\//uy
const scheme = /(?:Bearer|Basic|Token|Digest)\s+/iuy
const privateKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/uy
const knownShapes: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/gu,
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
const headerLine = /^([A-Za-z0-9!#$%&'"*+.^_`|~-]+)(\s*:\s*)([\s\S]+)$/u
// A header argument that ends at its colon: `-H X-Foo: secret` leaves the
// value in the next word.
const headerWithoutValue = /^[A-Za-z0-9!#$%&'"*+.^_`|~-]+\s*:$/u

// Shells whose `-c` option takes a script, read as words in turn. A script
// nested deeper than this is redacted whole.
const shells = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "yash"])
const maximumDepth = 4

function isMarker(value: string): boolean {
  return value === marker || value === `"${marker}"` || value === `'${marker}'`
}

function redactKnownShapes(text: string): string {
  return knownShapes.reduce((redacted, shape) => redacted.replace(shape, marker), text)
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

// The end of a `$` expansion at `index`, read as literal text, or undefined
// when it runs a command (`$(`) or is not POSIX quoting (`$'...'`, `$"..."`).
// A `${...}` is read to its closing brace and may not hold quotes or another
// expansion, since those are read by rules this lexer does not model.
function expansionEnd(text: string, index: number, quoting: Quoting): number | undefined {
  const next = text[index + 1]
  if (next === "(") return undefined
  if (quoting === "" && (next === "'" || next === "\"")) return undefined
  if (next !== "{") return index + 1
  for (let inner = index + 2; inner < text.length; inner += 1) {
    const character = text[inner]!
    if (character === "}") return inner + 1
    if (/["'`$\\\n]/u.test(character)) return undefined
  }
  return undefined
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
// text with any character the shell treats specially is single-quoted; a
// rewritten URL keeps the operators it was written with (`&`, `;`, `|`), since
// the URL rule reads through them again.
const plainText = /^[A-Za-z0-9_@%+=:,./[\]?#~!^-]*$/u
const plainUrl = /^[A-Za-z0-9_@%+=:,./[\]?#~!^&;|-]*$/u
const singleQuoted = (text: string) => text.replace(/'/gu, "'\"'\"'")
function spelled(text: string, quoting: Quoting, wordStart: boolean, url: boolean): string {
  if (quoting === "\"") return `${text.replace(/[\\"$`]/gu, "\\$&")}"`
  if (quoting === "'") return `${singleQuoted(text)}'`
  if ((url ? plainUrl : plainText).test(text) && !(wordStart && /^[#~]/u.test(text))) return text
  return `'${singleQuoted(text)}'`
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
function rewrittenWord(text: string, word: Word, value: string, anchor: number, url: boolean, nested: boolean): string {
  if (value === word.value) return text.slice(word.start, word.end)
  const { characters } = word
  let at = Math.min(anchor, commonPrefix(word.value, value))
  while (at > 0 && at < characters.length && characters[at - 1]!.source === characters[at]!.source) at -= 1
  const next = characters[at]
  const opens = nested ? next?.opens : undefined
  const prefix = text.slice(word.start, opens ?? next?.source ?? word.end)
  return `${prefix}${spelled(value.slice(at), opens === undefined ? next?.quoting ?? "" : "", prefix === "", url)}`
}

// The word a shell's `-c` option runs as a script, for each shell word in the
// tokens: `sh -c script`, `bash -lc script`, `bash -o pipefail -c script`.
function shellScripts(tokens: readonly Token[]): Set<number> {
  const scripts = new Set<number>()
  tokens.forEach((token, index) => {
    if (token.kind !== "word" || !shells.has(token.value.slice(token.value.lastIndexOf("/") + 1))) return
    let command = false
    let next = index + 1
    while (next < tokens.length) {
      const option = tokens[next]!
      if (option.kind !== "word") return
      if (option.value === "--") {
        next += 1
        break
      }
      if (/^--[A-Za-z-]+$/u.test(option.value)) {
        next += 1
        continue
      }
      if (!/^[-+][A-Za-z]+$/u.test(option.value)) break
      if (option.value.startsWith("-") && option.value.includes("c")) command = true
      // -o and -O take the next word as their argument.
      next += /[oO]/u.test(option.value) ? 2 : 1
    }
    if (command && tokens[next]?.kind === "word") scripts.add(next)
  })
  return scripts
}

// What the rules decided for each token: its new value, the first character a
// rule rewrote, whether the URL rule rewrote it, whether it was merged into
// the word before it, and the token after which everything is dropped.
interface Plan { values: string[]; anchors: number[]; urls: boolean[]; dropped: boolean[]; stopAfter?: number }

interface Change { start: number; end: number; text: string }

// The rules, run over the tokens' values joined by one space. `glued` says a
// token is written with no blank before the next one; `leading` is the first
// source character of each word, so a flag test sees `"-x"` as a quote.
function planTokens(tokens: readonly Token[], glued: readonly boolean[], leading: readonly string[], depth: number, nested: boolean): Plan {
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
  const urls = tokens.map(() => false)
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

  // A private key that runs past its word takes the rest of the text.
  const privateKeyAt = (index: number, token: number): number | undefined => {
    privateKey.lastIndex = index
    const match = privateKey.exec(joined)
    if (!match || index + match[0].length <= ends[token]!) return undefined
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
    urls[token] = true
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
    const text = joined.slice(from, to)
    const line = headerLine.exec(text)
    if (line) {
      const [, name = "", gap = "", value = ""] = line
      scheme.lastIndex = 0
      const kept = scheme.exec(value)?.[0] ?? ""
      const rest = value.slice(kept.length)
      if (rest !== "" && !isMarker(rest)) change(argument, from + name.length + gap.length + kept.length, to, marker)
      return to
    }
    // An argument with a colon that does not read as a header is redacted
    // whole rather than let through (`X Foo: v`). `@file` and `Name;` are left
    // to the other rules.
    if (text.includes(":") && !headerWithoutValue.test(text)) {
      if (!isMarker(text)) change(argument, from, to, marker)
      return to
    }
    // A quoted `"Name:"` is an empty header its author closed; only an
    // unquoted colon takes the next word as its value. A flag there is the
    // next argument, not a value.
    if (!headerWithoutValue.test(text) || quotingAt(argument, to - 1) !== "") return undefined
    const value = argument + 1
    const next = tokens[value]
    if (next?.kind !== "word" || next.value === "" || leading[value] === "-" || isMarker(next.value)) return to
    change(value, starts[value]!, ends[value]!, marker)
    return ends[value]!
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
    // closing quote and keeps its quotes.
    const opening = joined[start]
    if (opening === "\"" || opening === "'") {
      const { end, closed } = quotedEnd(joined, start, ends[value]!)
      if (!isMarker(joined.slice(start, end))) change(value, start, end, closed ? `${opening}${marker}${opening}` : marker)
      return end
    }
    if (nested) {
      if (joined.slice(start) !== marker) truncate(value, start)
      return joined.length
    }
    if (!isMarker(joined.slice(start, ends[value]))) change(value, start, ends[value]!, marker)
    return ends[value]!
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
    const text = joined.slice(start, end)
    const keep = text === "" || text === marker || text.startsWith("-") || schemeProse.has(text.toLowerCase().replace(/[.,;:!?]+$/u, ""))
    if (!keep) change(value, start, end, marker)
    return end
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

  const values = tokens.map((token, index) => {
    if (token.kind !== "word" || dropped[index] || (stopAfter !== undefined && index > stopAfter)) return token.value
    if (scripts.has(index) && !consumed.has(index)) return depth >= maximumDepth ? marker : redactShell(token.value, depth + 1, true)
    let value = token.value
    for (const { start, end, text } of [...changes[index]!].sort((left, right) => right.start - left.start)) {
      value = `${value.slice(0, start)}${text}${value.slice(end)}`
    }
    return redactKnownShapes(value)
  })
  // A shell's script that changed is written again whole, so no escape from
  // its source stands between a key and its [REDACTED].
  const anchors = changes.map((list, index) => (scripts.has(index) && !consumed.has(index) ? 0 : Math.min(Number.POSITIVE_INFINITY, ...list.map(({ start }) => start))))
  return { values, anchors, urls, dropped, ...(stopAfter === undefined ? {} : { stopAfter }) }
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
// shells it is nested in; `nested` is true inside one.
function redactShell(text: string, depth: number, nested: boolean): string {
  const { tokens, stoppedAt } = lexShell(text)
  const glued = tokens.map((token, index) => tokens[index + 1]?.start === token.end)
  const leading = tokens.map((token) => text[token.start] ?? "")
  const plan = planTokens(tokens, glued, leading, depth, nested)
  let output = ""
  let cursor = 0
  let endsInWord = false
  for (const [index, token] of tokens.entries()) {
    // A merged token was written with no blank before it; its text is in the
    // word before it now.
    if (plan.dropped[index]) {
      cursor = token.end
      continue
    }
    output += text.slice(cursor, token.start)
    output += token.kind === "word" ? rewrittenWord(text, token, plan.values[index]!, plan.anchors[index]!, plan.urls[index]!, nested) : token.value
    cursor = token.end
    endsInWord = token.kind === "word"
    if (plan.stopAfter === index) return output
  }
  if (stoppedAt === undefined) return `${output}${text.slice(cursor)}`
  const gap = text.slice(cursor, stoppedAt)
  return `${output}${gap === "" && endsInWord && cursor === stoppedAt ? " " : gap}${marker}`
}

// The words shell text reads as, or undefined when it does not read as words.
// Tests use it to check that emitted text reads back as the words meant.
export function inventoryShellWords(text: string): string[] | undefined {
  const { tokens, stoppedAt } = lexShell(text)
  return stoppedAt === undefined ? tokens.flatMap((token) => (token.kind === "word" ? [token.value] : [])) : undefined
}

export function redactInventoryText(text: string): string {
  return redactShell(text, 0, false)
}

// A command given as an argument vector. Each argument is one word whatever it
// holds, so the same rules run on the arguments as given, and a shell's `-c`
// script is read as shell text. An argument with a blank, quote or backslash
// is shown quoted: in double quotes, or in single quotes when it holds a
// double quote, so no backslash stands between a key and its [REDACTED].
export function redactInventoryArgv(argv: readonly string[]): string {
  const tokens: Word[] = argv.map((value, index) => ({
    kind: "word", start: index, end: index, value, characters: Array.from({ length: value.length }, () => ({ quoting: "", source: 0 })),
  }))
  const plan = planTokens(tokens, tokens.map(() => false), argv.map((value) => value[0] ?? ""), 0, false)
  const words = plan.stopAfter === undefined ? plan.values : plan.values.slice(0, plan.stopAfter + 1)
  return words.map((word) => {
    if (word !== "" && !/[\s"'\\]/u.test(word)) return word
    return word.includes("\"") ? `'${singleQuoted(word)}'` : `"${word.replace(/\\/gu, "\\\\")}"`
  }).join(" ")
}
