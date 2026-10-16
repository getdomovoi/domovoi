import { credentialStores } from "./credential-stores.js"

// The names the card classifier calls secret (namesSecretPath in
// permission-policy.ts, which reads the credential stores too). Every deny
// list in the Codex sandbox profiles and the history scan that names
// committed copies are generated from these groups, so they cannot drift
// apart. A form matches one whole file or directory name, written in lower
// case; what may follow it differs by group.

// A character the classifier reads as ending a name, by its two readings
// (#545's list, and the command-line reading with the credential stores).
// Both end a name at any ASCII character but a letter, digit, underscore,
// hyphen or dot. The list's reading also ends one at any other character, a
// letter such as é included; the command-line reading lets a name go on
// through any letter, digit or mark. Seatbelt (macOS) misreads a bracket
// expression that names both "-" and "." and cannot read one with a non-ASCII
// character (measured with codex-cli 0.162.1), so the ASCII characters are
// written as ranges and the others as "not printable ASCII".
const endsInAscii = "[ -,:-@[-^`{-~]"
const notAscii = "[! -~]"
// A character a word starts after: anything but a letter, digit or underscore.
const startsWord = "[!_a-zA-Z0-9]"

type SecretGroup = Readonly<{
  forms: readonly string[]
  // What may follow a form: everything below it as a directory, and the
  // characters that end a name under either reading or only both ("ascii"),
  // or any characters ("any"), or nothing but a directory's contents ("none").
  after: "either-reading" | "ascii" | "any" | "none"
}>

// #545's list (listedSecretFileNames): the files and stores it names, and a
// key or certificate extension after any stem, including none.
const listedNames = [
  "daemon.token", "credentials.json", "gh/hosts.yml", ".ssh", ".docker/config.json", ".netrc", ".npmrc", ".pypirc",
] as const
const secretExtensions = ["pem", "key", "p12", "pfx"] as const
const privateKeyNames = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"] as const

// The other credential stores by card name. A card name a listed name already
// covers at any depth (.domovoi/daemon.token) is left out.
const storeNames = credentialStores
  .map(({ location, cardName }) => cardName ?? location.slice(2))
  .filter((name) => !listedNames.some((listed) => name === listed || name.endsWith(`/${listed}`)))

const secretGroups: readonly SecretGroup[] = [
  { forms: [...listedNames, ...secretExtensions.map((extension) => `*.${extension}`)], after: "either-reading" },
  { forms: storeNames, after: "ascii" },
  // A private key where a word starts, with any suffix: id_rsa.pub,
  // backup-id_ed25519, keys/old.id_dsa.
  { forms: [...privateKeyNames, ...privateKeyNames.map((name) => `*${startsWord}${name}`)], after: "any" },
  // The .env family: a name that starts with .env, ends with .env or .envrc,
  // or holds .env. or either followed by a character that ends a name.
  {
    forms: [".env*", "*.env", "*.env.*", ...[".env", ".envrc"].flatMap((name) => [`*${name}${endsInAscii}*`, `*${name}${notAscii}*`]), "*.envrc"],
    after: "none",
  },
]

// What a group's forms may be followed by, the whole name first.
function tails(after: SecretGroup["after"]): string[] {
  switch (after) {
    case "either-reading":
      return ["", "/**", `${endsInAscii}*`, `${endsInAscii}*/**`, `${notAscii}*`, `${notAscii}*/**`]
    case "ascii":
      return ["", "/**", `${endsInAscii}*`, `${endsInAscii}*/**`]
    case "any":
      return ["*", "*/**"]
    case "none":
      return ["", "/**"]
  }
}

// How the letters of a form are spelled; bracket expressions stay as written.
type Spelling = (form: string) => string

// Codex compares deny globs with letter case in its ripgrep scan on Linux,
// and without it on Windows and in Seatbelt, which refused DAEMON.TOKEN by
// **/daemon.token on a case-sensitive APFS volume too. Where case counts, each
// letter is a class of both cases.
const eitherCase: Spelling = (form) => form.split(/(\[[^\]]*\])/u)
  .map((part) => part.startsWith("[") ? part : part.replace(/[a-z]/giu, (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`))
  .join("")
const asWritten: Spelling = (form) => form

// The longest glob a group renders to, as written. Seatbelt reads a regex of
// at most 1,017 bytes, worktree path included, and writes a rule for every
// ancestor directory of each glob, so fewer, shorter globs let the profile
// load under a longer worktree path (768 bytes, codex.test.ts).
const maximumGlobLength = 200

function render(forms: readonly string[], after: SecretGroup["after"]): string[] {
  const [first, ...rest] = tails(after)
  const names = `**/{${forms.join(",")}}`
  if (first === "") return [names, rest.length === 1 ? `${names}${rest[0]!}` : `${names}{${rest.join(",")}}`]
  return [`${names}{${[first!, ...rest].join(",")}}`]
}

// A group's forms in runs whose globs stay within the longest glob, measured
// as written so every platform shares the runs.
function runs({ forms, after }: SecretGroup): string[][] {
  const result: string[][] = []
  for (const form of forms) {
    const last = result.at(-1)
    if (last !== undefined && render([...last, form], after).every((glob) => glob.length <= maximumGlobLength)) last.push(form)
    else result.push([form])
  }
  return result
}

// The deny globs for a worktree, each at any depth: as a file and as a
// directory with everything below it. A brace group never holds an empty
// branch, which the globset Codex scans with on Linux and Windows skips.
export function codexSecretGlobs(platform: NodeJS.Platform = process.platform): readonly string[] {
  const spell = platform === "darwin" || platform === "win32" ? asWritten : eitherCase
  return secretGroups.flatMap((group) => runs(group).flatMap((forms) => render(forms.map(spell), group.after)))
}

// The same names as Git pathspecs for the history scan, without letter case.
// Git globs have no {a,b}, so each form and tail is its own pathspec.
export const codexSecretPathspecs: readonly string[] = [...new Set(secretGroups.flatMap(({ forms, after }) =>
  forms.flatMap((form) => tails(after).map((tail) => `:(glob,icase)**/${form}${tail}`))))]

function listed(items: readonly string[]): string {
  return items.length === 1 ? items[0]! : `${items.slice(0, -1).join(", ")} and ${items.at(-1)!}`
}

// What the sandbox refuses, in words, for the notice and the model.
export const codexSecretFileSummary = [
  ".env files",
  `${listed(secretExtensions.map((extension) => `*.${extension}`))} files`,
  `the private keys ${listed(privateKeyNames)}`,
  "daemon.token",
  "credentials.json",
  "gh/hosts.yml",
  `and credential stores such as ${listed([".ssh", ".aws", ".kube", ".npmrc", ".netrc", ".pypirc"])}`,
].join(", ")
