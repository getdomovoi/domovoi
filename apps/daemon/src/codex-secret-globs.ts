import { credentialStores } from "./credential-stores.js"

// The names the card classifier calls secret (namesSecretPath in
// permission-policy.ts, which reads the credential stores too), one rule per
// kind. Every deny list in the Codex sandbox profiles and the history scan
// that names committed copies are generated from this one table, so they
// cannot drift apart.
type SecretNameRule =
  // A file or directory name of one or more components: alone, or followed by
  // a character that ends a name ("daemon.token~", ".ssh (1)").
  | { kind: "name"; name: string }
  // A key or certificate extension after any stem, including none, the same way.
  | { kind: "extension"; extension: string }
  // A private key name where a word starts, with any suffix: id_rsa.pub,
  // backup-id_ed25519, keys/old.id_dsa.
  | { kind: "private-key"; name: string }
  // The .env family: a name that starts with .env, ends with .env or .envrc,
  // or holds .env followed by a dot or by a character that ends a name, or
  // .envrc followed by one.
  | { kind: "env" }

const credentialStoreCardNames = credentialStores.map(({ location, cardName }) => cardName ?? location.slice(2))
const secretFileNames = ["daemon.token", "credentials.json", "gh/hosts.yml"] as const
const secretExtensions = ["pem", "key", "p12", "pfx"] as const
const privateKeyNames = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"] as const

const secretNameRules: readonly SecretNameRule[] = [
  ...[...new Set([...credentialStoreCardNames, ...secretFileNames])].map((name): SecretNameRule => ({ kind: "name", name })),
  ...secretExtensions.map((extension): SecretNameRule => ({ kind: "extension", extension })),
  ...privateKeyNames.map((name): SecretNameRule => ({ kind: "private-key", name })),
  { kind: "env" },
]

// A character that ends a name: anything but a letter, digit, underscore,
// hyphen or dot, as the classifier reads one. Seatbelt (macOS) misreads every
// bracket expression that names both "-" and "." but the range ",-.", so a
// comma counts as part of a name here (measured with codex-cli 0.162.1).
const endsName = "[!_a-zA-Z0-9,-.]"
// A character a word starts after: anything but a letter, digit or underscore.
const startsWord = "[!_a-zA-Z0-9]"

// How a literal name is spelled in a glob.
type Spelling = (text: string) => string

// Codex compares deny globs with letter case in its ripgrep scan on Linux and
// in its own reads on macOS and Linux, and without it on Windows and in
// Seatbelt. Where case counts, each letter is a class of both cases.
const eitherCase: Spelling = (text) => text.replace(/[a-z]/giu, (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`)
const asWritten: Spelling = (text) => text

// The glob forms of one rule, each matching one name at any depth.
function secretNameForms(rule: SecretNameRule, spell: Spelling): string[] {
  switch (rule.kind) {
    case "name":
      return [spell(rule.name), `${spell(rule.name)}${endsName}*`]
    case "extension":
      return [`*.${spell(rule.extension)}`, `*.${spell(rule.extension)}${endsName}*`]
    case "private-key":
      return [`${spell(rule.name)}*`, `*${startsWord}${spell(rule.name)}*`]
    case "env":
      return [
        `${spell(".env")}*`, `*${spell(".env")}`, `*${spell(".env")}.*`, `*${spell(".env")}${endsName}*`,
        `*${spell(".envrc")}`, `*${spell(".envrc")}${endsName}*`,
      ]
  }
}

function secretForms(spell: Spelling): string[] {
  return [...new Set(secretNameRules.flatMap((rule) => secretNameForms(rule, spell)))]
}

// The deny globs for a worktree: each form at any depth, as a file and as a
// directory with everything below it. A form is its own glob, and a group
// never holds an empty branch: Seatbelt reads a regex of at most 1,023 bytes,
// worktree path included, and the globset Codex scans with on Linux and
// Windows skips an empty branch.
export function codexSecretGlobs(platform: NodeJS.Platform = process.platform): readonly string[] {
  return secretForms(platform === "win32" ? asWritten : eitherCase).map((form) => `**/{${form},${form}/**}`)
}

// The same forms as Git pathspecs for the history scan, without letter case.
// Git globs have no {a,b}, so the directory form is its own pathspec.
export const codexSecretPathspecs: readonly string[] = secretForms(asWritten)
  .flatMap((form) => [`:(glob,icase)**/${form}`, `:(glob,icase)**/${form}/**`])

function listed(items: readonly string[]): string {
  return items.length === 1 ? items[0]! : `${items.slice(0, -1).join(", ")} and ${items.at(-1)!}`
}

// What the sandbox refuses, in words, for the notice and the model.
export const codexSecretFileSummary = [
  ".env files",
  `${listed(secretExtensions.map((extension) => `*.${extension}`))} files`,
  `the private keys ${listed(privateKeyNames)}`,
  ...secretFileNames,
  `and credential stores such as ${listed([".ssh", ".aws", ".kube", ".npmrc", ".netrc", ".pypirc"])}`,
].join(", ")
