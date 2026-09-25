import { isAbsolute, join, parse, relative, resolve, sep } from "node:path"

import { followedTarget, followPath, requestedPath, type FollowedPath, type FollowedTarget } from "./followed-path.js"
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

// One path on a card: the file or directory, the worktree, and the directory
// the request runs in.
type CardPath = { workspace: string; path: string; cwd?: string | undefined }

// A card judges a path on exactly the spellings it hides, and hides exactly
// the spellings it judges: both read the one set pathSpellings builds (final
// check after 3fd053db). Forms is that set.

// The directory line of a card: the directory the request runs in. It is
// persisted and sent like the file path, so a directory any spelling of which
// names a credential store, or one the durable redaction changes, is hidden
// whole and the line keeps only where it is, in the form #541 uses
// (hiddenDirectory in approval-facts.ts). Hidden is true then, and the card is
// a hard gate.
export async function cardDirectory(input: { directory: string; workspace: string }): Promise<{ text: string; hidden: boolean; forms: string[] }> {
  const spellings = await pathSpellings({ workspace: input.workspace, path: input.directory })
  const { forms } = spellings
  if (!namesCredential(spellings) && !redactDurableText(input.directory).redacted) {
    return { text: input.directory, hidden: false, forms }
  }
  const workspace = resolve(input.workspace)
  const directory = resolve(workspace, input.directory)
  const inside = directory === workspace || within(workspace, directory) !== undefined
  return {
    text: inside ? "[REDACTED] in the session worktree" : "[REDACTED], outside the session worktree",
    hidden: true,
    forms,
  }
}

// Redacted is true when the durable redaction changed a path, which makes the
// card a hard gate the way a secret anywhere else in its text does. Sensitive
// is true when the file is hidden as [REDACTED] for naming a credential file:
// the card is then a hard gate too (ruled for #541), so no standing rule is
// made or used for a file the person cannot see.
//
// Sensitive is judged on every spelling in the set, as #541 judges the
// requested path, each hop and the final target, and more: a credential name
// in any spelling of the file, of the worktree it lies in, or of the directory
// the request runs in hides the file, even when the file itself is public,
// since the card's text may name it that way.
export async function fileTargetAffects(input: CardPath): Promise<{ text: string; redacted: boolean; sensitive: boolean; forms: string[] }> {
  const lexicalTarget = resolve(input.workspace, input.cwd ?? ".", input.path)
  const spellings = await pathSpellings(input)
  const { forms, followed } = spellings
  const hide = namesCredential(spellings)
  const shown = (path: string) => hide ? hiddenPath : shownPath(path)
  const lexical = within(resolve(input.workspace), lexicalTarget)
  const real = followed ? within(followed.workspace, followed.target) : lexical
  if (real !== undefined) {
    // The file the edit reaches, which is the one a rule made here names.
    const name = shown(real)
    return { text: `The file ${name.text} in the session worktree.`, redacted: name.redacted, sensitive: hide, forms }
  }
  if (lexical !== undefined && followed) {
    const destination = shown(followed.target)
    const link = shown(lexical)
    return {
      text: `The file ${destination.text}, outside the session worktree, through a link at ${link.text}.`,
      redacted: destination.redacted || link.redacted,
      sensitive: hide,
      forms,
    }
  }
  const name = shown(lexicalTarget)
  return { text: `The file ${name.text}, outside the session worktree.`, redacted: name.redacted, sensitive: hide, forms }
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

// How many directories a path goes down from its filesystem root.
function depth(path: string): number {
  return path.slice(parse(path).root.length).split(sep).filter((step) => step !== "").length
}

// The number of ".." steps a relative form, written with "/", starts with.
function climbs(path: string): number {
  const steps = path.split("/")
  const down = steps.findIndex((step) => step !== "..")
  return down === -1 ? steps.length : down
}

// A path is closed under the pairs of spellings its walks found for one place
// (FollowedPath.links, and each walked path beside its realpath spelling):
// where it starts with one of a pair, it is written with the other as well,
// again and again, since each link on a way can be written either way. A link
// that leads to its own parent can spell without end, so each set is bounded,
// and so is the whole set of forms; past a bound the set is not complete, and
// the card is judged as naming a credential path.
const maximumSpellings = 256
const maximumForms = 50_000

function sameSpellings(
  pairs: ReadonlyArray<readonly [string, string]>,
  seeds: readonly string[],
): { spellings: string[]; complete: boolean } {
  const found = new Set(seeds)
  let frontier = seeds.filter((path) => isAbsolute(path))
  const prefix = (path: string) => path.endsWith(sep) ? path : `${path}${sep}`
  while (frontier.length > 0) {
    const next: string[] = []
    for (const path of frontier) {
      for (const [one, other] of pairs) {
        for (const [from, to] of [[one, other], [other, one]] as const) {
          const swapped = path === from ? to : path.startsWith(prefix(from)) ? `${prefix(to)}${path.slice(prefix(from).length)}` : undefined
          if (swapped === undefined || found.has(swapped)) continue
          if (found.size >= maximumSpellings) return { spellings: [...found], complete: false }
          found.add(swapped)
          next.push(swapped)
        }
      }
    }
    frontier = next
  }
  return { spellings: [...found], complete: true }
}

// The one set a card both judges and hides for a path: every form in which its
// text can name it (ruled 2026-09-24, closed after 3fd053db).
//
// Target spellings: the path as given, as requested from the request's
// directory, the lexical path, the path after each link on the way (each link
// target as the link spelled it, with the rest still to walk), the walked path
// and the realpath target.
//
// Roots, in two places: the worktree, and the directory the request runs in.
// Each place is spelled as given, resolved, as realpath writes it, as walked,
// and after each link on the way to it.
//
// Every absolute spelling, of the target and of each root, is closed under
// the links the three walks crossed (sameSpellings). Every target spelling is
// then listed as it is, and relative to every root of each place: below the
// root with ".." collapsed and as written, and above it with ".." where that
// does not climb to the filesystem root. Each relative form is joined again to
// every root of the same place, and written with "/" and with "\", bare and
// after "./". A relative form is not joined to the other place's roots, which
// would spell a path that is not there.
export type PathSpellings = { forms: string[]; complete: boolean }

async function pathSpellings(input: CardPath): Promise<PathSpellings & { followed: FollowedTarget | undefined }> {
  const workspace = resolve(input.workspace)
  const followed = await followedTarget(input.workspace, input.path, input.cwd)
  const lexical = resolve(workspace, input.cwd ?? ".", input.path)
  const directoryGiven = input.cwd === undefined
    ? input.workspace
    : isAbsolute(input.cwd) ? input.cwd : `${input.workspace}${sep}${input.cwd}`
  const directory = resolve(workspace, input.cwd ?? ".")
  const directoryWalk = await followPath(directory)
  const targetWalk = followed?.walks.target
  const workspaceWalk = followed?.walks.workspace
  const walks = [targetWalk, workspaceWalk, directoryWalk].flatMap((walk) => walk ?? [])
  const pairs = walks.flatMap((walk) => [...walk.links, [walk.walked, walk.path] as const])
  const spelled = (paths: readonly string[]) => sameSpellings(pairs, [...new Set(paths)])
  const walkSpellings = (walk: FollowedPath | undefined) => walk ? [...walk.aliases, walk.walked, walk.path] : []
  const targets = spelled([
    input.path,
    requestedPath(input.workspace, input.path, input.cwd),
    lexical,
    ...walkSpellings(targetWalk),
  ])
  const places = [
    spelled([input.workspace, workspace, ...walkSpellings(workspaceWalk)]),
    spelled([directoryGiven, directory, ...walkSpellings(directoryWalk)]),
  ]
  const forms = new Set(targets.spellings)
  const finished = (complete: boolean) => ({
    forms: [...forms].filter((form) => form !== "" && form !== "." && form !== sep),
    complete,
    followed,
  })
  if (!targets.complete || places.some((place) => !place.complete)) {
    for (const place of places) for (const root of place.spellings) forms.add(root)
    return finished(false)
  }
  for (const { spellings: roots } of places) {
    // Each relative form of a target from any root of this place, collapsed or
    // as written, and whether it climbs.
    const relatives = new Map<string, "collapsed" | "written">()
    for (const root of roots) {
      if (!isAbsolute(root)) continue
      for (const target of targets.spellings) {
        if (!isAbsolute(target)) continue
        const collapsed = from(root, target)
        if (collapsed !== undefined && climbs(collapsed) < depth(root) && !relatives.has(collapsed)) relatives.set(collapsed, "collapsed")
        const written = writtenWithin(root, target)
        if (written !== undefined && !relatives.has(written)) relatives.set(written, "written")
      }
    }
    for (const [path, kind] of relatives) {
      const backslashed = path.split("/").join("\\")
      for (const form of [path, `./${path}`, backslashed, `.\\${backslashed}`]) forms.add(form)
      for (const other of roots) {
        if (!isAbsolute(other)) continue
        if (kind === "written") forms.add(writtenBelow(other, path))
        else if (climbs(path) < depth(other)) forms.add(join(other, path))
      }
      if (forms.size > maximumForms) return finished(false)
    }
  }
  return finished(true)
}

// The judge every card path goes through: a credential name in any form of
// the set, or a set that could not be closed.
function namesCredential(spellings: PathSpellings): boolean {
  return !spellings.complete || spellings.forms.some(namesSecretPath)
}

// The set a card judges and hides for one path (pathSpellings).
export async function hiddenPathForms(input: CardPath): Promise<string[]> {
  return (await pathSpellings(input)).forms
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
