// Credential stores in the home directory. The Codex sandbox refuses reads of
// each location, and an approval card hides and hard-gates a path or command
// that names one, in the home directory or anywhere else, through the path
// classifier below.
export type CredentialStore = Readonly<{
  location: `~/${string}`
  // What marks the store on a card, when the location is a directory that
  // also holds ordinary files: projects keep their own .docker directory, and
  // session worktrees live under ~/.domovoi.
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

// Names are compared in one form: Unicode NFC, lower case.
function comparable(text: string): string {
  return text.normalize("NFC").toLowerCase()
}

// Runs of components that name a secret wherever they appear in a path.
const secretSequences: readonly (readonly string[])[] = [
  ...credentialStoreNames.map((parts) => parts.map(comparable)),
  ["gh", "hosts.yml"],
]

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

// Whether a path names a credential store or a secret file. The one classifier
// for card paths, every hop of a link, and every operand on a command line.
export function isCredentialPath(path: string): boolean {
  const { written, collapsed } = pathComponents(path)
  if (written.some(isSecretFileName)) return true
  return secretSequences.some((sequence) => containsSequence(written, sequence) || containsSequence(collapsed, sequence))
}

// The operands of a command line, read the way a shell splits words: quotes
// group, whitespace and control operators separate. Each word is also split on
// "=" and ":", so `--file=x.pem` and `-v x.pem:/y` expose the path, and read
// once more with backslash escapes removed.
export function commandOperands(command: string): string[] {
  const words: string[] = []
  let word = ""
  let inWord = false
  let quote: "'" | "\"" | undefined
  const characters = [...command]
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!
    if (quote === "'") {
      if (character === "'") quote = undefined
      else word += character
      continue
    }
    if (quote === "\"") {
      const next = characters[index + 1]
      if (character === "\\" && next !== undefined && "\"\\$`".includes(next)) {
        word += next
        index += 1
      } else if (character === "\"") {
        quote = undefined
      } else {
        word += character
      }
      continue
    }
    if (character === "'" || character === "\"") {
      quote = character
      inWord = true
      continue
    }
    if (/[\s;|&<>()`]/u.test(character)) {
      if (inWord) words.push(word)
      word = ""
      inWord = false
      continue
    }
    word += character
    inWord = true
  }
  if (inWord) words.push(word)
  return words.flatMap(operandPieces)
}

// One word, whole and split on "=" and ":", each also without backslash escapes.
export function operandPieces(word: string): string[] {
  const pieces = [word, ...word.split(/[=:]/u)]
  return [...pieces, ...pieces.map((piece) => piece.replace(/\\(.)/gu, "$1"))]
}
