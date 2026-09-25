import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { isCredentialPath } from "./credential-stores.js"

// Hidden file names for the card text property tests (round 13). Each name is
// a file under a credential store or named as a secret file, so a card hides
// it. The characters an agent's text puts around a path are placed at the
// start, middle and end of each of its components, and the card's text writes
// the path in each way an agent writes one. A run is seeded: the seed and the
// case count come from DOMOVOI_HIDDEN_NAME_SEED and DOMOVOI_HIDDEN_NAME_CASES
// when set, and every failure names the seed.

const defaultSeed = 0x5eed_0541

export type HiddenNameRun = Readonly<{ seed: number; cases: number }>

export function hiddenNameRun(defaultCases: number): HiddenNameRun {
  const seed = Number.parseInt(process.env["DOMOVOI_HIDDEN_NAME_SEED"] ?? "", 10)
  const cases = Number.parseInt(process.env["DOMOVOI_HIDDEN_NAME_CASES"] ?? "", 10)
  return {
    seed: Number.isSafeInteger(seed) ? seed : defaultSeed,
    cases: Number.isSafeInteger(cases) && cases > 0 ? cases : defaultCases,
  }
}

// Punctuation, shell characters, quotes, a backslash, whitespace, non-ASCII
// letters, a ligature, combining marks and emoji.
export const hiddenNameCharacters: readonly string[] = [
  ",", " ", "\t", "'", "\"", "`", ":", ";", "(", ")", "[", "]", "{", "}", "=", "&", "|", "<", ">",
  "$", "#", "%", "*", "?", "!", "@", "+", "~", "\\", ".", "-",
  // e with acute, sharp s, Cyrillic zhe, a CJK letter, a fullwidth A, the fi
  // ligature, a combining acute and diaeresis, and two emoji
  "\u{e9}", "\u{df}", "\u{416}", "\u{540d}", "\u{ff21}", "\u{fb01}", "\u{301}", "\u{308}", "\u{1f600}", "\u{1f44d}\u{1f3fd}",
]

const coreCharacters = "abcdefghijklmnopqrstuvwxyz0123456789"
const stores = [".ssh", ".aws", ".kube", ".gnupg", ".azure", ".password-store"]
const keyExtensions = [".pem", ".key", ".p12", ".pfx"]

// mulberry32: small, seeded, and the same on every platform.
function generator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

// The relative paths of a run, one per case, with "/" between components.
export function hiddenNamePaths(run: HiddenNameRun): string[] {
  const random = generator(run.seed)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
  const special = () => Array.from({ length: 1 + Math.floor(random() * 2) }, () => pick(hiddenNameCharacters)).join("")
  const core = () => Array.from({ length: 2 + Math.floor(random() * 2) }, () => pick([...coreCharacters])).join("")
  // Special characters at the start, middle and end of a component.
  const spread = () => `${special()}${core()}${special()}${core()}${special()}`
  const leaves: (() => string)[] = [
    () => `${pick(stores)}/${spread()}`,
    () => `.env${special()}${core()}${special()}`,
    () => `${special()}${core()}${special()}.env`,
    () => `${special()}${core()}${special()}${pick(keyExtensions)}`,
    () => `id_${pick(["rsa", "ed25519"])}${special()}${core()}${special()}`,
  ]
  // A combining mark after a marker such as "id_rsa" can compose with its last
  // letter into another name, which is not hidden; such a draw is made again.
  const hidden = (): string => {
    for (;;) {
      const path = `${spread()}/${pick(leaves)()}`
      if (isCredentialPath(path)) return path
    }
  }
  return Array.from({ length: run.cases }, hidden)
}

// Make the file under root. False when the filesystem refuses the name.
export async function createHiddenFile(root: string, path: string): Promise<boolean> {
  if (!isCredentialPath(path)) throw new Error(`The generated path is not hidden: ${JSON.stringify(path)}`)
  const file = join(root, ...path.split("/"))
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, "")
    return true
  } catch {
    return false
  }
}

// Each way an agent writes a path in a command: bare, quoted, after an
// option's "=", and next to a shell operator.
const commandWritings: readonly ((path: string) => string)[] = [
  (path) => path,
  (path) => `'${path}'`,
  (path) => `"${path}"`,
  (path) => `--file=${path}`,
  (path) => `${path};`,
  (path) => `(${path})`,
]

// And in prose: the same, and in a sentence followed by punctuation. A
// command word such as "x.pem," is a path of its own that the card hides with
// its comma, so sentence punctuation is written only in the operation.
const writings: readonly ((path: string) => string)[] = [
  ...commandWritings,
  (path) => `${path},`,
  (path) => `${path}.`,
  (path) => `${path}:`,
]

// The negative controls: none is a path the card hides, so each stays. Each
// holds a hidden name's text inside a longer name. ".env.example" and ".envrc"
// are secret file names to the classifier, which judges the card's own text
// since round 14, so they are not controls here.
export const cardTextControls = "x.env.example, app.envrc.md and src/index.ts"

// The operation and command lines for these paths, the last one at the end of
// the text. The same call with "[REDACTED]" for each path gives the text the
// card shows.
export function cardOperation(paths: readonly string[]): string {
  const written = paths.flatMap((path) => writings.map((write) => write(path)))
  return `Before the deploy, leave ${cardTextControls} alone. Edit ${written.join(" then ")} and last ${paths.at(-1)!}`
}

export function cardCommand(paths: readonly string[]): string {
  const written = paths.flatMap((path) => commandWritings.map((write) => write(path)))
  return `cat src/index.ts ${written.join(" ")} ${paths.at(-1)!}`
}

// The classifier reads a command word "--file=<path>" whole as a path too, and
// the card hides a word it reads as a hidden path whole, option and all.
function optionHidden(text: string): string {
  return text.replaceAll("--file=[REDACTED]", "[REDACTED]")
}

// What is wrong with a card text: a hidden form or the file's name still in
// it, or text around the path that did not stay. Exact text is required when
// the name holds no quote or backslash, which a shell reads as syntax.
export function cardTextFailures(input: {
  label: string
  shown: string
  expected: string
  forms: readonly string[]
  path: string
}): string[] {
  const failures: string[] = []
  const name = input.path.split("/").at(-1)!
  for (const form of [...input.forms, name]) {
    if (input.shown.includes(form)) failures.push(`${input.label} holds ${JSON.stringify(form)}: ${JSON.stringify(input.shown)}`)
  }
  const syntax = /['"`\\]/u.test(input.path)
  const kept = syntax
    ? input.shown.startsWith(input.expected.slice(0, input.expected.indexOf("[REDACTED]")))
    : optionHidden(input.shown) === optionHidden(input.expected)
  if (!kept) failures.push(`${input.label} is ${JSON.stringify(input.shown)}, expected ${JSON.stringify(input.expected)}`)
  return failures
}
