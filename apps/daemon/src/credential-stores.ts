import { realpath } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"
import { promisify } from "node:util"

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
function comparable(text: string): string {
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

const realpathNative = promisify(realpath.native)

// Longer than any path the system resolves.
const maximumResolvedPathLength = 4096

// Where a path really is on this machine: the real path of the path, or of
// its nearest existing ancestor with the rest as written, so a link, or a
// name the filesystem treats as another, reads as the name it reaches. A
// relative path is read from base; undefined without one. Asynchronous, so a
// slow or automounted path never stalls the daemon.
export async function canonicalPath(path: string, base?: string): Promise<string | undefined> {
  const expanded = /^~(?:[/\\]|$)/u.test(path) ? `${homedir()}${path.slice(1)}` : path
  if (expanded.length > maximumResolvedPathLength || (!isAbsolute(expanded) && base === undefined)) return undefined
  const requested = isAbsolute(expanded) ? expanded : `${base!}${sep}${expanded}`
  try { return await realpathNative(requested) } catch { /* absent or unreadable: try its ancestors */ }
  let current = resolve(requested)
  const rest: string[] = []
  for (;;) {
    const parent = dirname(current)
    if (parent === current) return undefined
    rest.unshift(basename(current))
    current = parent
    try { return join(await realpathNative(current), ...rest) } catch { /* keep walking up */ }
  }
}

// Whether a path names a credential store or a secret file at its real path.
async function isCredentialPathOnDisk(path: string, base?: string): Promise<boolean> {
  const canonical = await canonicalPath(path, base)
  return canonical !== undefined && isCredentialPath(canonical)
}

// Whether any of these command operands reaches a credential store or a
// secret file at its real path, each relative operand read from cwd.
export async function operandsReachCredentialPath(operands: readonly string[], cwd: string | undefined): Promise<boolean> {
  for (const operand of new Set(operands)) {
    if (await isCredentialPathOnDisk(operand, cwd)) return true
  }
  return false
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

const ansiEscapes: Readonly<Record<string, string>> = {
  a: "\u0007", b: "\b", e: "\u001b", E: "\u001b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
  "\\": "\\", "'": "'", "\"": "\"", "?": "?",
}

// Up to count digits of one base from start, as a character.
function escapedCharacter(characters: readonly string[], start: number, digits: RegExp, count: number, radix: number): QuotedText | undefined {
  let value = ""
  while (value.length < count && digits.test(characters[start + value.length] ?? "")) value += characters[start + value.length]
  const point = Number.parseInt(value, radix)
  if (value === "" || point > 0x10ffff) return undefined
  return { text: String.fromCodePoint(point), end: start + value.length }
}

// An ANSI-C quoted string, $'...': the escapes decoded the way the shell does
// before the command runs.
function ansiCQuoted(characters: readonly string[], start: number): QuotedText {
  let text = ""
  let index = start
  while (index < characters.length && characters[index] !== "'") {
    const character = characters[index]!
    const next = characters[index + 1]
    if (character !== "\\" || next === undefined) {
      text += character
      index += 1
      continue
    }
    const decoded = Object.hasOwn(ansiEscapes, next) ? { text: ansiEscapes[next]!, end: index + 2 }
      : /[0-7]/u.test(next) ? escapedCharacter(characters, index + 1, /[0-7]/u, 3, 8)
      : next === "x" ? escapedCharacter(characters, index + 2, /[0-9a-f]/iu, 2, 16)
      : next === "u" ? escapedCharacter(characters, index + 2, /[0-9a-f]/iu, 4, 16)
      : next === "U" ? escapedCharacter(characters, index + 2, /[0-9a-f]/iu, 8, 16)
      : next === "c" && characters[index + 2] !== undefined
        ? { text: String.fromCodePoint(characters[index + 2]!.codePointAt(0)! & 0x1f), end: index + 3 }
        : undefined
    if (decoded === undefined) {
      text += character + next
      index += 2
    } else {
      text += decoded.text
      index = decoded.end
    }
  }
  return { text, end: index + 1 }
}

// A command line read the way a shell splits words: quotes group and are
// decoded, and whitespace and control operators separate. A POSIX shell
// escapes with a backslash: before a newline it joins the lines, and unquoted
// it keeps the character after it in the word, so an escaped quote opens
// nothing. PowerShell and cmd read a backslash as an ordinary character.
export type ShellReading = "posix" | "backslash-literal"

export function shellWords(command: string, reading: ShellReading = "posix"): string[] {
  const escapes = reading === "posix"
  const words: string[] = []
  let word = ""
  let inWord = false
  const characters = [...command]
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
      word += character + next
      inWord = true
      index += 2
      continue
    }
    if (escapes && character === "$" && next === "'") quoted = ansiCQuoted(characters, index + 2)
    else if (escapes && character === "$" && next === "\"") quoted = doubleQuoted(characters, index + 2, escapes)
    else if (character === "'") quoted = singleQuoted(characters, index + 1)
    else if (character === "\"") quoted = doubleQuoted(characters, index + 1, escapes)
    if (quoted !== undefined) {
      word += quoted.text
      inWord = true
      index = quoted.end
      continue
    }
    if (/[\s;|&<>()`]/u.test(character)) {
      if (inWord) words.push(word)
      word = ""
      inWord = false
    } else {
      word += character
      inWord = true
    }
    index += 1
  }
  if (inWord) words.push(word)
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

// One word, whole and split on "=" and ":", each also without backslash escapes.
export function operandPieces(word: string): string[] {
  const pieces = [word, ...word.split(/[=:]/u)]
  return [...pieces, ...pieces.map((piece) => piece.replace(/\\(.)/gu, "$1"))]
}
