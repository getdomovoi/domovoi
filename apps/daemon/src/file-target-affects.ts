import { isAbsolute, join, relative, resolve, sep } from "node:path"

import { followedTarget, requestedPath } from "./followed-path.js"
import { namesSecretPath } from "./permission-policy.js"
import { redactDurableText } from "./secret-redaction.js"

// The Affects line of a file tool's card: the file the edit really reaches,
// found the way execution resolution finds it, in the sentence form #541 uses
// for approval facts (affectedFile in approval-facts.ts). Whichever of #541 and
// #545 lands second folds this into approvalFacts.

// The card is persisted and sent to phones, and the path is the agent's text.
// It is redacted like the command, shown with its control characters escaped so
// it cannot add a line to the card, and shortened in the middle past this many
// characters.
const maximumApprovalPathLength = 512

// C0 and C1 controls, line and paragraph separators, and the bidirectional
// overrides and isolates that can reorder what a person reads.
const unsafeCharacter = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu

function escaped(character: string): string {
  if (character === "\n") return "\\n"
  if (character === "\r") return "\\r"
  if (character === "\t") return "\\t"
  return `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`
}

function shownPath(path: string): { text: string; redacted: boolean } {
  const copy = redactDurableText(path)
  const text = copy.value.replace(unsafeCharacter, escaped)
  if (text.length <= maximumApprovalPathLength) return { text, redacted: copy.redacted }
  const head = Math.ceil((maximumApprovalPathLength - 1) / 2)
  const tail = maximumApprovalPathLength - 1 - head
  return { text: `${text.slice(0, head)}…${text.slice(-tail)}`, redacted: copy.redacted }
}

function within(workspace: string, target: string): string | undefined {
  const inside = relative(workspace, target)
  return inside !== "" && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)
    ? inside.split(sep).join("/")
    : undefined
}

// A path that names a credential file is hidden whole on the card; the line
// keeps only where the file is.
const hiddenPath = { text: "[REDACTED]", redacted: false }

// The directory line of a card: the directory the request runs in. It is
// persisted and sent like the file path, so a directory that names a
// credential store, or one the durable redaction changes, is hidden whole and
// the line keeps only where it is, in the form #541 uses (hiddenDirectory in
// approval-facts.ts). Hidden is true then, and the card is a hard gate.
export function cardDirectory(input: { directory: string; workspace: string }): { text: string; hidden: boolean } {
  const workspace = resolve(input.workspace)
  const directory = resolve(workspace, input.directory)
  if (!namesSecretPath(input.directory) && !namesSecretPath(directory) && !redactDurableText(input.directory).redacted) {
    return { text: input.directory, hidden: false }
  }
  const inside = directory === workspace || within(workspace, directory) !== undefined
  return {
    text: inside ? "[REDACTED] in the session worktree" : "[REDACTED], outside the session worktree",
    hidden: true,
  }
}

// Redacted is true when the durable redaction changed a path, which makes the
// card a hard gate the way a secret anywhere else in its text does. Sensitive
// is true when the file is hidden as [REDACTED] for naming a credential file:
// the card is then a hard gate too (ruled for #541), so no standing rule is
// made or used for a file the person cannot see.
export async function fileTargetAffects(input: {
  workspace: string
  path: string
  cwd?: string | undefined
}): Promise<{ text: string; redacted: boolean; sensitive: boolean }> {
  const lexicalTarget = resolve(input.workspace, input.cwd ?? ".", input.path)
  const followed = await followedTarget(input.workspace, input.path, input.cwd)
  const hide = namesSecretPath(input.path)
    || namesSecretPath(lexicalTarget)
    || (followed !== undefined && namesSecretPath(followed.target))
  const shown = (path: string) => hide ? hiddenPath : shownPath(path)
  const lexical = within(resolve(input.workspace), lexicalTarget)
  const real = followed ? within(followed.workspace, followed.target) : lexical
  if (real !== undefined) {
    // The file the edit reaches, which is the one a rule made here names.
    const name = shown(real)
    return { text: `The file ${name.text} in the session worktree.`, redacted: name.redacted, sensitive: hide }
  }
  if (lexical !== undefined && followed) {
    const destination = shown(followed.target)
    const link = shown(lexical)
    return {
      text: `The file ${destination.text}, outside the session worktree, through a link at ${link.text}.`,
      redacted: destination.redacted || link.redacted,
      sensitive: hide,
    }
  }
  const name = shown(lexicalTarget)
  return { text: `The file ${name.text}, outside the session worktree.`, redacted: name.redacted, sensitive: hide }
}

// Every form in which a card's text can name a path it hides (ruled
// 2026-09-24): as written, from the request's directory, where it really leads,
// and each of those relative to the worktree, both as given and as it really
// lies, and each relative form joined to either worktree root again.
export async function hiddenPathForms(input: {
  workspace: string
  path: string
  cwd?: string | undefined
}): Promise<string[]> {
  const workspace = resolve(input.workspace)
  const followed = await followedTarget(input.workspace, input.path, input.cwd)
  const absolute = [
    input.path,
    requestedPath(input.workspace, input.path, input.cwd),
    resolve(workspace, input.cwd ?? ".", input.path),
    ...(followed ? [followed.target] : []),
  ]
  const roots = [workspace, ...(followed ? [followed.workspace] : [])]
  const inside = absolute.flatMap((path) => roots.flatMap((root) => within(root, path) ?? []))
  const forms = new Set([
    ...absolute,
    ...inside,
    // within() names a relative path with "/"; Windows text may use "\".
    ...inside.map((path) => path.split("/").join(sep)),
    ...inside.flatMap((path) => roots.map((root) => join(root, path))),
  ])
  return [...forms].filter((form) => form !== "" && form !== "." && form !== sep)
}

function escapedPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}

// Replace each exact form of a hidden path in the agent's text with
// [REDACTED], and nothing else. A form counts only where it stands as a whole
// path: not inside a longer name (".env" in "x.env" or ".env.example"), but
// before a "/" that continues into the hidden directory. The longest form is
// tried first, so an absolute path is not left half replaced.
export function hidePaths(text: string, forms: readonly string[]): string {
  if (forms.length === 0) return text
  const alternatives = [...new Set(forms)]
    .filter((form) => form !== "")
    .sort((one, other) => other.length - one.length)
    .map(escapedPattern)
  if (alternatives.length === 0) return text
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_.\\-])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_\\-]|\\.[\\p{L}\\p{N}])`,
    "gu",
  )
  return text.replace(pattern, "[REDACTED]")
}
