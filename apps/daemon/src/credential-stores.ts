import { realpath } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, parse, sep } from "node:path"

import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"

// Credential stores in the home directory. The Codex sandbox refuses reads of
// each location, and an approval card hides and hard-gates a path or command
// that names one, in the home directory or anywhere else, through the path
// classifier below.
export type CredentialStore = Readonly<{
  location: `~/${string}`
  // What marks the store on a card, when the location is a directory that
  // also holds ordinary files: projects keep their own .docker directory, and
  // session worktrees live under ~/.domovoi. The location itself, the whole
  // store, is still one.
  cardName?: string
}>

export const credentialStores: readonly CredentialStore[] = [
  { location: "~/.ssh" },
  { location: "~/.aws" },
  { location: "~/.domovoi", cardName: ".domovoi/daemon.token" },
  { location: "~/.config/gh" },
  { location: "~/.kube" },
  { location: "~/.docker", cardName: ".docker/config.json" },
  { location: "~/.netrc" },
  { location: "~/.gnupg" },
  { location: "~/.azure" },
  { location: "~/.config/gcloud" },
  { location: "~/.git-credentials" },
  { location: "~/.config/git/credentials" },
  { location: "~/.npmrc" },
  { location: "~/.pypirc" },
  { location: "~/.password-store" },
  { location: "~/.terraform.d" },
  { location: "~/.vault-token" },
  { location: "~/.pgpass" },
  { location: "~/.my.cnf" },
  { location: "~/.cargo/credentials.toml" },
  { location: "~/.gem/credentials" },
  { location: "~/.config/op" },
  { location: "~/.local/share/keyrings" },
  { location: "~/Library/Keychains" },
  { location: "~/.codex/auth.json" },
  { location: "~/.claude/.credentials.json" },
]

// The home-relative path that marks each store, one entry per path component.
export const credentialStoreNames: readonly (readonly string[])[] = credentialStores.map(
  ({ location, cardName }) => (cardName ?? location.slice(2)).split("/"),
)

// Names are compared in one form: Unicode NFKC with full case folding and
// without default-ignorable code points, so a compatibility form such as the
// "ﬁ" ligature or a fullwidth letter, and a case pair such as "ß" and "ss",
// read as the name they stand for. Upper then lower case gives the full
// folding that lower case alone does not.
export function comparable(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .toUpperCase()
    .toLowerCase()
    .normalize("NFKC")
}

// Runs of components that name a secret wherever they appear in a path.
const secretSequences: readonly (readonly string[])[] = [
  ...credentialStoreNames.map((parts) => parts.map(comparable)),
  ["gh", "hosts.yml"],
]

// The roots of the stores a card marks by a narrower name. A path that ends at
// one, or reaches into it with a pattern, names every file in the store.
const wholeStores: readonly (readonly string[])[] = credentialStores.flatMap(({ location, cardName }) => (
  cardName === undefined ? [] : [location.slice(2).split("/").map(comparable)]
))
const patternCharacter = /[*?[{]/u

// One component that names a secret file: a key or certificate extension
// after any stem, including none; a private key with any suffix; the .env
// family, a name that starts with .env or ends with .env or .envrc; and the
// files named here.
function isSecretFileName(name: string): boolean {
  return /\.(?:pem|key|p12|pfx)$/u.test(name)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)/u.test(name)
    || /^\.env|\.env(?:rc)?$/u.test(name)
    || name === "daemon.token"
    || name === "credentials.json"
}

function containsSequence(parts: readonly string[], sequence: readonly string[]): boolean {
  for (let start = 0; start + sequence.length <= parts.length; start += 1) {
    if (sequence.every((part, offset) => parts[start + offset] === part)) return true
  }
  return false
}

function namesWholeStore(parts: readonly string[], root: readonly string[]): boolean {
  for (let start = 0; start + root.length <= parts.length; start += 1) {
    if (!root.every((part, offset) => parts[start + offset] === part)) continue
    const rest = parts.slice(start + root.length)
    if (rest.length === 0 || (rest.length === 1 && patternCharacter.test(rest[0]!))) return true
  }
  return false
}

// The components of a path as written, with empty and "." components dropped
// and either slash taken as a separator, and the same components with ".."
// applied. A path is judged on both, so a ".." can neither hide a store nor
// assemble one that only the collapsed form shows.
function pathComponents(path: string): { written: string[]; collapsed: string[] } {
  const written = comparable(path).split(/[/\\]+/u).filter((part) => part !== "" && part !== ".")
  const collapsed: string[] = []
  for (const part of written) {
    if (part === ".." && collapsed.length > 0 && collapsed.at(-1) !== "..") collapsed.pop()
    else collapsed.push(part)
  }
  return { written, collapsed }
}

// Whether a path names a credential store or a secret file, as written. The
// one classifier for card paths, every hop of a link, the directory a request
// runs in, and every operand on a command line.
export function isCredentialPath(path: string): boolean {
  const { written, collapsed } = pathComponents(path)
  if (written.some(isSecretFileName)) return true
  return secretSequences.some((sequence) => containsSequence(written, sequence) || containsSequence(collapsed, sequence))
    || wholeStores.some((root) => namesWholeStore(written, root) || namesWholeStore(collapsed, root))
}

// The forms two path texts are compared in when a card hides a path in its
// own text: the classifier's components, as written and with ".." applied, a
// leading "~" read as the home directory, and whether the path starts at a
// root. A path with no components, such as "." or "/", has no form.
export function pathKeys(path: string): string[] {
  const expanded = /^~(?:[/\\]|$)/u.test(path) ? `${homedir()}${path.slice(1)}` : path
  const root = /^[/\\]/u.test(comparable(expanded)) ? "/" : ""
  const { written, collapsed } = pathComponents(expanded)
  return [...new Set([written, collapsed].filter((parts) => parts.length > 0).map((parts) => `${root}${parts.join("/")}`))]
}

// Whether one character separates path components in the classifier's form.
export function isPathSeparator(character: string): boolean {
  return /^[/\\]+$/u.test(comparable(character))
}

// Longer than any path the system resolves.
const maximumResolvedPathLength = 4096

// How long the real paths behind one request may take to read. A stalled
// network or automounted path ends here instead of holding the session.
export const realPathLookupBudgetMs = 2_000

// A path whose real location could not be read: the lookup ran out of time,
// or the filesystem refused it. It is judged as a credential path.
export const unreadablePath = Object.freeze({ unreadable: true } as const)
export type RealPath = string | typeof unreadablePath | undefined

const componentSeparator = process.platform === "win32" ? /[\\/]+/u : /\/+/u

function realpathBefore(path: string, deadline: OperationDeadline): Promise<string> {
  return beforeDeadline(new Promise<string>((resolve, reject) => {
    realpath.native(path, (error, resolved) => error ? reject(error) : resolve(resolved))
  }), deadline)
}

function isAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}

// A directory and parts below it, joined as written with the separator given.
// A directory that already ends in a separator takes none: on Windows "/" is a
// root as well as "\", and "/" followed by "\" starts a UNC path, so a missing
// path written "/worktrees/x" would name the network share "worktrees", whose
// real path cannot be read (Windows CI after round 15).
export function below(directory: string, parts: readonly string[], separator: string = sep): string {
  return `${withTrailingSeparator(directory, separator)}${parts.join(separator)}`
}

// The directory with one separator after it, as a prefix of the paths below it.
export function withTrailingSeparator(directory: string, separator: string = sep): string {
  const endsInSeparator = separator === "\\" ? /[\\/]$/u : /\/$/u
  return endsInSeparator.test(directory) ? directory : `${directory}${separator}`
}

// Where a path really is on this machine, so a link, or a name the filesystem
// treats as another, reads as the name it reaches. A path that does not exist
// yet is followed one component at a time from its root the way the
// filesystem does: each existing component at its real path, a link before
// any ".." after it, and the rest from the first missing component as
// written. A relative path is read from base; undefined without one. Every
// lookup shares the deadline, and a lookup that times out or is refused gives
// unreadablePath.
export async function canonicalPath(path: string, base?: string, deadline?: OperationDeadline): Promise<RealPath> {
  const expanded = /^~(?:[/\\]|$)/u.test(path) ? `${homedir()}${path.slice(1)}` : path
  if (expanded.length > maximumResolvedPathLength || (!isAbsolute(expanded) && base === undefined)) return undefined
  const requested = isAbsolute(expanded) ? expanded : below(base!, [expanded])
  const clock = deadline ?? OperationDeadline.start(realPathLookupBudgetMs)
  try {
    try { return await realpathBefore(requested, clock) } catch (error) {
      if (!isAbsent(error)) return unreadablePath
    }
    const root = parse(requested).root
    const parts = requested.slice(root.length).split(componentSeparator).filter((part) => part !== "")
    let current = root
    for (const [index, part] of parts.entries()) {
      if (part === ".") continue
      if (part === "..") { current = dirname(current); continue }
      try { current = await realpathBefore(join(current, part), clock) } catch (error) {
        if (!isAbsent(error)) return unreadablePath
        return below(current, parts.slice(index))
      }
    }
    return current
  } finally {
    if (deadline === undefined) clock.clear()
  }
}

// Whether a real path names a credential store or a secret file by this
// classifier; a real path that could not be read does.
export function realPathNamesSecret(path: RealPath, names: (path: string) => boolean = isCredentialPath): boolean {
  return typeof path === "string" ? names(path) : path === unreadablePath
}

// Whether any of these command operands reaches a credential store or a
// secret file at its real path, each relative operand read from cwd. The
// lookups share one deadline, the request's when it gives one.
export async function operandsReachCredentialPath(
  operands: readonly string[],
  cwd: string | undefined,
  deadline?: OperationDeadline,
  names: (path: string) => boolean = isCredentialPath,
): Promise<boolean> {
  return (await operandsAtCredentialPaths(operands, cwd, deadline, names)).length > 0
}

// Each of these command operands whose real path names a credential store or
// a secret file, with that real path, each relative operand read from cwd.
// Names is the judge; callers outside this module pass the union judge,
// namesSecretPath, which this module cannot import.
export async function operandsAtCredentialPaths(
  operands: readonly string[],
  cwd: string | undefined,
  deadline?: OperationDeadline,
  names: (path: string) => boolean = isCredentialPath,
): Promise<{ operand: string; real: RealPath }[]> {
  const clock = deadline ?? OperationDeadline.start(realPathLookupBudgetMs)
  try {
    const found: { operand: string; real: RealPath }[] = []
    for (const operand of new Set(operands)) {
      const real = await canonicalPath(operand, cwd, clock)
      if (realPathNamesSecret(real, names)) found.push({ operand, real })
    }
    return found
  } finally {
    if (deadline === undefined) clock.clear()
  }
}

type QuotedText = { text: string; end: number }

// A single-quoted string: everything up to the closing quote, as written.
function singleQuoted(characters: readonly string[], start: number): QuotedText {
  let text = ""
  let index = start
  while (index < characters.length && characters[index] !== "'") text += characters[index++]
  return { text, end: index + 1 }
}

// A double-quoted string. Where backslash escapes, it escapes only " \ $ and
// `, and a backslash before a newline joins the lines.
function doubleQuoted(characters: readonly string[], start: number, escapes: boolean): QuotedText {
  let text = ""
  let index = start
  while (index < characters.length && characters[index] !== "\"") {
    const character = characters[index]!
    const next = characters[index + 1]
    if (escapes && character === "\\" && next === "\n") {
      index += 2
    } else if (escapes && character === "\\" && next !== undefined && "\"\\$`".includes(next)) {
      text += next
      index += 2
    } else {
      text += character
      index += 1
    }
  }
  return { text, end: index + 1 }
}

const ansiEscapes: Readonly<Record<string, number>> = {
  a: 0x07, b: 0x08, e: 0x1b, E: 0x1b, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b,
  "\\": 0x5c, "'": 0x27, "\"": 0x22, "?": 0x3f,
}

const utf8 = new TextEncoder()
const utf8Text = new TextDecoder()

// Up to count digits of one base from start, as a number.
function escapedValue(characters: readonly string[], start: number, digits: RegExp, count: number, radix: number): { value: number; end: number } | undefined {
  let text = ""
  while (text.length < count && digits.test(characters[start + text.length] ?? "")) text += characters[start + text.length]
  return text === "" ? undefined : { value: Number.parseInt(text, radix), end: start + text.length }
}

// A \u or \U value as bash writes it: one byte through 0x7f, then the UTF-8
// pattern stretched to six bytes, surrogates included; nothing past 0x7fffffff.
function unicodeBytes(value: number): number[] {
  if (value <= 0x7f) return [value]
  if (value > 0x7fffffff) return []
  const length = value <= 0x7ff ? 2 : value <= 0xffff ? 3 : value <= 0x1fffff ? 4 : value <= 0x3ffffff ? 5 : 6
  const bytes = Array.from({ length }, (_, index) => 0x80 | ((value >>> (6 * (length - 1 - index))) & 0x3f))
  bytes[0] = ((0xff00 >> length) & 0xff) | (value >>> (6 * (length - 1)))
  return bytes
}

// An ANSI-C quoted string, $'...', decoded the way bash does before the
// command runs. Bash works on bytes: a literal character is its UTF-8 bytes,
// an octal escape keeps the low byte of its value, \x is one byte, \u and \U
// are UTF-8, and \c is the control form of the next byte. The quoted text ends
// at its first NUL byte, the rest of the word goes on after the closing quote,
// and the bytes read as UTF-8.
function ansiCQuoted(characters: readonly string[], start: number): QuotedText {
  const bytes: number[] = []
  let index = start
  while (index < characters.length && characters[index] !== "'") {
    const character = characters[index]!
    const next = characters[index + 1]
    if (character !== "\\" || next === undefined) {
      bytes.push(...utf8.encode(character))
      index += 1
      continue
    }
    let escaped: { bytes: number[]; end: number } | undefined
    if (Object.hasOwn(ansiEscapes, next)) {
      escaped = { bytes: [ansiEscapes[next]!], end: index + 2 }
    } else if (/[0-7]/u.test(next)) {
      const octal = escapedValue(characters, index + 1, /[0-7]/u, 3, 8)!
      escaped = { bytes: [octal.value & 0xff], end: octal.end }
    } else if (next === "x" || next === "u" || next === "U") {
      const hex = escapedValue(characters, index + 2, /[0-9a-f]/iu, next === "x" ? 2 : next === "u" ? 4 : 8, 16)
      if (hex !== undefined) escaped = { bytes: next === "x" ? [hex.value] : unicodeBytes(hex.value), end: hex.end }
    } else if (next === "c" && characters[index + 2] !== undefined && characters[index + 2] !== "'") {
      // A backslash after \c escapes the character after it for the quote,
      // so \c\\ and \c\' are the control form of the backslash, and the
      // quote in \c\' stays in the text.
      const target = characters[index + 2]!
      const after = characters[index + 3]
      const [first, ...rest] = utf8.encode(target)
      const control = first === 0x3f ? 0x7f : first! & 0x1f
      escaped = target === "\\" && (after === "\\" || after === "'")
        ? { bytes: after === "'" ? [control, 0x27] : [control], end: index + 4 }
        : { bytes: [control, ...rest], end: index + 3 }
    }
    if (escaped === undefined) {
      bytes.push(...utf8.encode(character + next))
      index += 2
    } else {
      bytes.push(...escaped.bytes)
      index = escaped.end
    }
  }
  const nul = bytes.indexOf(0)
  return { text: utf8Text.decode(new Uint8Array(nul === -1 ? bytes : bytes.slice(0, nul))), end: index + 1 }
}

// A command line read the way a shell splits words: quotes group and are
// decoded, and whitespace and control operators separate. A POSIX shell
// escapes with a backslash: before a newline it joins the lines, and unquoted
// it keeps the character after it in the word, so an escaped quote opens
// nothing. PowerShell and cmd read a backslash as an ordinary character.
export type ShellReading = "posix" | "backslash-literal"

export function shellWords(command: string, reading: ShellReading = "posix"): string[] {
  return shellWordSpans(command, reading).map(({ text }) => text)
}

// Each shell word with where it is written in the command: start and end are
// string offsets, and text is the word as the shell decodes it.
export type ShellWordSpan = Readonly<{ text: string; start: number; end: number }>

export function shellWordSpans(command: string, reading: ShellReading = "posix"): ShellWordSpan[] {
  const escapes = reading === "posix"
  const words: ShellWordSpan[] = []
  let word = ""
  let inWord = false
  let wordStart = 0
  const characters = [...command]
  const offsets: number[] = []
  let offset = 0
  for (const character of characters) {
    offsets.push(offset)
    offset += character.length
  }
  offsets.push(offset)
  const at = (index: number) => offsets[Math.min(index, characters.length)]!
  const begin = (index: number) => {
    if (!inWord) wordStart = index
    inWord = true
  }
  let index = 0
  while (index < characters.length) {
    const character = characters[index]!
    const next = characters[index + 1]
    let quoted: QuotedText | undefined
    if (escapes && character === "\\" && next === "\n") {
      index += 2
      continue
    }
    if (escapes && character === "\\" && next !== undefined) {
      begin(index)
      word += character + next
      index += 2
      continue
    }
    if (escapes && character === "$" && next === "'") quoted = ansiCQuoted(characters, index + 2)
    else if (escapes && character === "$" && next === "\"") quoted = doubleQuoted(characters, index + 2, escapes)
    else if (character === "'") quoted = singleQuoted(characters, index + 1)
    else if (character === "\"") quoted = doubleQuoted(characters, index + 1, escapes)
    if (quoted !== undefined) {
      begin(index)
      word += quoted.text
      index = quoted.end
      continue
    }
    if (/[\s;|&<>()`]/u.test(character)) {
      if (inWord) words.push({ text: word, start: at(wordStart), end: at(index) })
      word = ""
      inWord = false
    } else {
      begin(index)
      word += character
    }
    index += 1
  }
  if (inWord) words.push({ text: word, start: at(wordStart), end: at(index) })
  return words
}

// The operands of a command line: its words as a POSIX shell and as a shell
// that takes backslash literally reads them, each also split on "=" and ":",
// so `--file=x.pem` and `-v x.pem:/y` expose the path, and read once more
// with backslash escapes removed.
export function commandOperands(command: string): string[] {
  const words = new Set([...shellWords(command), ...shellWords(command, "backslash-literal")])
  return [...new Set([...words].flatMap(operandPieces))]
}

// The quotes, brackets and punctuation that open or end a name in prose: the
// ASCII ones below, and outside ASCII any opening, closing, initial or final
// quote, dash or other punctuation, such as a curly quote, a guillemet, a
// fullwidth bracket, an em dash, an ellipsis or an ideographic full stop
// (round 15).
const asciiOpening = new Set([..."\"'`([{<"])
const asciiClosing = new Set([..."\"'`)]}>,.;:!?"])
const proseOpening = /^[\p{Ps}\p{Pi}\p{Pf}\p{Po}\p{Pd}]$/u
const proseClosing = /^[\p{Pe}\p{Pi}\p{Pf}\p{Po}\p{Pd}]$/u

function opensName(character: string): boolean {
  return asciiOpening.has(character) || (character.codePointAt(0)! > 0x7f && proseOpening.test(character))
}

function closesName(character: string): boolean {
  return asciiClosing.has(character) || (character.codePointAt(0)! > 0x7f && proseClosing.test(character))
}

// A candidate without the punctuation that opens and ends it. Read one code
// point at a time, so a long run of punctuation costs linear time.
function withoutProse(candidate: string): string {
  const characters = [...candidate]
  let start = 0
  let end = characters.length
  while (start < end && opensName(characters[start]!)) start += 1
  while (end > start && closesName(characters[end - 1]!)) end -= 1
  return characters.slice(start, end).join("")
}

const nonNameRun = /[^\p{L}\p{M}\p{N}\p{Pc}.\-~/\\]+/gu

// The start of a word up to the end of its last run between non-name
// characters that names a secret, so a name that holds a comma or a
// parenthesis is read whole whatever follows it: an em dash, a line suffix
// such as ":12" or "#L3", or a closing quote (round 15). Undefined when no
// run does.
function secretPrefix(word: string, names: (path: string) => boolean): string | undefined {
  let end: number | undefined
  let from = 0
  for (const separator of word.matchAll(nonNameRun)) {
    if (names(word.slice(from, separator.index))) end = separator.index
    from = separator.index + separator[0].length
  }
  if (names(word.slice(from))) end = word.length
  return end === undefined ? undefined : word.slice(0, end)
}

// The paths the agent's own text on a card can name, for the classifier to
// judge (owner ruling 2026-09-25): each word between spaces, each run in it
// between characters that are neither name characters nor separators, such as
// a quote, a comma or a parenthesis, the start of each word up to its last run
// that names a secret, and the text's operands as a shell reads them, for a
// quoted name that holds a space. Each is read without the punctuation that
// opens and ends it, so a sentence around a path stays. Names is the judge the
// caller keeps candidates by; a candidate it does not hide is dropped by the
// caller, so reading too many only costs time.
export function textOperands(text: string, names: (path: string) => boolean = isCredentialPath): string[] {
  const words = text.split(/\s+/u)
  const runs = words.flatMap((word) => [
    word,
    ...word.split(nonNameRun),
    ...[secretPrefix(word, names)].filter((prefix) => prefix !== undefined),
  ])
  const candidates = [...runs, ...commandOperands(text)].map(withoutProse)
  return [...new Set(candidates)].filter((candidate) => candidate !== "")
}

// One word, whole and split on "=" and ":", each also without backslash escapes.
export function operandPieces(word: string): string[] {
  const pieces = [word, ...word.split(/[=:]/u)]
  return [...pieces, ...pieces.map((piece) => piece.replace(/\\(.)/gu, "$1"))]
}
