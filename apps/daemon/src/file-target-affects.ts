import { isAbsolute, join, relative, resolve, sep } from "node:path"

import { followedTarget, followPath, requestedPath } from "./followed-path.js"
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
//
// Every spelling the walk produces is judged, as #541 judges the requested
// path, each hop and the final target: the path as given and as requested,
// the lexical path, the path after each link (followedTarget's aliases), the
// walked path and the realpath target. A credential name in any of them hides
// the file, even when the file it leads to is public, since the card's text
// may name the path that way (final check after fc428aba).
export async function fileTargetAffects(input: {
  workspace: string
  path: string
  cwd?: string | undefined
}): Promise<{ text: string; redacted: boolean; sensitive: boolean }> {
  const lexicalTarget = resolve(input.workspace, input.cwd ?? ".", input.path)
  const followed = await followedTarget(input.workspace, input.path, input.cwd)
  const hide = [
    input.path,
    requestedPath(input.workspace, input.path, input.cwd),
    lexicalTarget,
    ...(followed ? [...followed.targetAliases, followed.walkedTarget, followed.target] : []),
  ].some(namesSecretPath)
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

// The path from a directory to a target, with "/", when one can be written:
// not the directory itself, and not a path of only "." and ".." steps, which
// would name every parent in the agent's text.
function from(directory: string, target: string): string | undefined {
  const path = relative(directory, target)
  if (path === "" || isAbsolute(path)) return undefined
  const steps = path.split(sep)
  return steps.every((step) => step === "." || step === "..") ? undefined : steps.join("/")
}

// The rest of a path after a root, as written, with "/": ".." and "." are
// kept, since a link's target can hold them and the text can name the path
// that way. Undefined outside the root, and for a rest of only "." and ".."
// steps.
function writtenWithin(root: string, path: string): string | undefined {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (!path.startsWith(prefix)) return undefined
  const steps = path.slice(prefix.length).split(sep).filter((step) => step !== "")
  return steps.length === 0 || steps.every((step) => step === "." || step === "..") ? undefined : steps.join("/")
}

// A root and a rest from writtenWithin, joined without collapsing "..".
function writtenBelow(root: string, rest: string): string {
  return `${root.endsWith(sep) ? root : `${root}${sep}`}${rest.split("/").join(sep)}`
}

// Every form in which a card's text can name a path it hides (ruled
// 2026-09-24): as written, from the request's directory, where it really leads
// (as realpath writes it, as walked, and after each link on the way), and each
// of those relative to the worktree, both as given and as it really
// lies, and each relative form joined to either worktree root again. The path
// from the request's directory counts too, from the directory as given and
// from where it really lies (round 10). Each relative form is written with "/"
// and with "\", bare and after "./".
export async function hiddenPathForms(input: {
  workspace: string
  path: string
  cwd?: string | undefined
}): Promise<string[]> {
  const workspace = resolve(input.workspace)
  const followed = await followedTarget(input.workspace, input.path, input.cwd)
  const lexical = resolve(workspace, input.cwd ?? ".", input.path)
  // Where the path really leads is written as realpath writes it, as the walk
  // wrote it at the end, and as it stood after each link on the way (each
  // link target as the link spelled it, with the rest still to walk); a text
  // can name any of them (final checks after 8181baf4 and 59484617). The
  // worktree's own spellings, its aliases included, are roots.
  const aliases = followed ? followed.targetAliases : []
  const absolute = [
    input.path,
    requestedPath(input.workspace, input.path, input.cwd),
    lexical,
    ...(followed ? [followed.target, followed.walkedTarget, ...aliases] : []),
  ]
  const roots = [
    workspace,
    ...(followed ? [followed.workspace, followed.walkedWorkspace, ...followed.workspaceAliases] : []),
  ]
  const inside = absolute.flatMap((path) => roots.flatMap((root) => within(root, path) ?? []))
  // The same, with a link target's ".." kept as the link wrote it.
  const writtenInside = absolute.flatMap((path) => roots.flatMap((root) => writtenWithin(root, path) ?? []))
  const directory = resolve(workspace, input.cwd ?? ".")
  const realDirectory = followed ? await followPath(directory) : undefined
  const directories = [directory, ...(realDirectory ? [realDirectory.path, realDirectory.walked] : [])]
  const fromDirectory = [
    from(directory, lexical),
    ...(followed && realDirectory !== undefined
      ? [from(realDirectory.path, followed.target), from(realDirectory.walked, followed.walkedTarget)]
      : []),
    ...aliases.flatMap((alias) => directories.map((spelling) => from(spelling, alias))),
  ].flatMap((path) => path ?? [])
  const relativeForms = [...inside, ...writtenInside, ...fromDirectory].flatMap((path) => {
    const backslashed = path.split("/").join("\\")
    return [path, `./${path}`, backslashed, `.\\${backslashed}`]
  })
  const forms = new Set([
    ...absolute,
    ...relativeForms,
    ...inside.flatMap((path) => roots.map((root) => join(root, path))),
    ...writtenInside.flatMap((path) => roots.map((root) => writtenBelow(root, path))),
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
