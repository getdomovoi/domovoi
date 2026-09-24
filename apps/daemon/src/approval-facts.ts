import { lstat, readlink } from "node:fs/promises"
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path"

import type { ExecutionResolution } from "@getdomovoi/protocol"

import {
  canonicalPath,
  commandOperands,
  operandPieces,
  realPathLookupBudgetMs,
  realPathNamesSecret,
  unreadablePath,
  type RealPath,
} from "./credential-stores.js"
import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"
import { namesSecretPath } from "./permission-policy.js"
import { redactDurableText } from "./secret-redaction.js"

// What an approval card says the request can reach. These facts sit next to
// Allow, so they describe the provider's actual limits, and name the file when
// the request is about one.

export type ApprovalScope = Readonly<{ command: string; network: string }>

// No sandbox around the command: Claude Code, OpenCode, Kilo and ACP agents run
// it as the user, with the machine's network.
export const unrestrictedApprovalScope: ApprovalScope = {
  command: "Anything this user account can reach on this machine.",
  network: "Not restricted: this provider runs commands with this machine's network access.",
}

// Codex's reach in each of its sandboxes; codexApprovalScope picks one.
export const codexSandboxReach = {
  read: "Reads anything this user account can read except credential stores and secret files, and writes nothing while the command runs in the Codex sandbox. A request to run outside the sandbox can reach anything this user account can.",
  write: "Writes only in the session worktree and reads anything this user account can read except credential stores and secret files while the command runs in the Codex sandbox. A request to run outside the sandbox can reach anything this user account can.",
} as const

// Every reach line a provider puts on a card. None names a path, so a sealed
// card keeps one as it is; any other line that is not a file line is hidden
// whole. A provider that adds a reach line adds it here, or its sealed cards
// show the hidden form.
const providerReachLines: ReadonlySet<string> = new Set([
  unrestrictedApprovalScope.command,
  codexSandboxReach.read,
  codexSandboxReach.write,
])

// The card is persisted and sent to phones, and the path is the agent's text.
// It is redacted like the command, shown with its control characters escaped so
// it cannot add a line to the card, and shortened in the middle past this many
// characters.
export const maximumApprovalPathLength = 512

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

// Where the path really leads, where the worktree really is, and every link
// followed on the way: each link's own path and its target, as written and as
// read from the link's directory. Canonical is the real path the filesystem
// gives, which also reads a name it treats as another as that name.
export type ResolvedApprovalPath = Readonly<{
  target: string
  workspace: string
  hops: readonly string[]
  canonical?: RealPath
}>

// The path as the request gave it, relative to the directory the request runs
// in, before anything is collapsed: ".." is applied only after the links
// before it are followed, as the filesystem does.
function requestedPath(workspace: string, path: string, cwd: string | undefined): string {
  if (isAbsolute(path)) return path
  const base = cwd === undefined ? workspace : isAbsolute(cwd) ? cwd : `${workspace}${sep}${cwd}`
  return `${base}${sep}${path}`
}

const separators = process.platform === "win32" ? /[\\/]+/u : /\/+/u
// Linux's bound on links followed in one lookup (macOS stops at 32).
const maximumLinksFollowed = 40

// Walk the path one component at a time from its root. A link, including one
// whose target does not exist yet, is replaced by its target before the rest
// of the path is read; ".." then leaves the directory the link led to. A
// component that does not exist is kept as written. Every link followed is
// recorded. Undefined when the links loop past the bound. Every lookup ends at
// the deadline.
async function followPath(path: string, deadline: OperationDeadline): Promise<{ target: string; hops: string[] } | undefined> {
  const root = parse(path).root
  let current = root
  const pending = path.slice(root.length).split(separators).filter((part) => part !== "")
  const hops: string[] = []
  let links = 0
  while (pending.length > 0) {
    const part = pending.shift()!
    if (part === ".") continue
    if (part === "..") { current = dirname(current); continue }
    const next = join(current, part)
    let isLink = false
    try { isLink = (await beforeDeadline(lstat(next), deadline)).isSymbolicLink() } catch (error) {
      if (deadline.signal.aborted) throw error
      /* absent or unreadable: kept as written */
    }
    if (!isLink) { current = next; continue }
    if (++links > maximumLinksFollowed) return undefined
    const target = await beforeDeadline(readlink(next), deadline)
    hops.push(next, target, isAbsolute(target) ? target : join(current, target))
    const targetRoot = parse(target).root
    if (targetRoot !== "") current = targetRoot
    pending.unshift(...target.slice(targetRoot.length).split(separators).filter((item) => item !== ""))
  }
  return { target: current, hops }
}

// Where the path really leads, and where the worktree really is, each followed
// the same way. Undefined when either loops, and then the lexical answer stands.
// A lookup that runs out of time or fails gives the lexical answer with a real
// path that could not be read, so the card treats the path as a credential path.
// The lookups end at the request's deadline when it gives one.
export async function resolveApprovalPath(
  workspace: string,
  path: string,
  cwd?: string,
  deadline?: OperationDeadline,
): Promise<ResolvedApprovalPath | undefined> {
  const requested = requestedPath(workspace, path, cwd)
  const clock = deadline ?? OperationDeadline.start(realPathLookupBudgetMs)
  try {
    const followed = await followPath(requested, clock)
    const realWorkspace = await followPath(resolve(workspace), clock)
    if (followed === undefined || realWorkspace === undefined) return undefined
    return { target: followed.target, workspace: realWorkspace.target, hops: followed.hops, canonical: await canonicalPath(requested, undefined, clock) }
  } catch {
    return { target: resolve(requested), workspace: resolve(workspace), hops: [], canonical: unreadablePath }
  } finally {
    if (deadline === undefined) clock.clear()
  }
}

// A path that names a credential file is hidden whole on the card; the line
// keeps only where the file is.
const hiddenPath = { text: "[REDACTED]", redacted: false }

function affectedFile(input: {
  path: string
  workspace: string
  cwd: string | undefined
  resolved: ResolvedApprovalPath | undefined
  hide: boolean
}): { text: string; redacted: boolean } {
  const shown = (path: string) => input.hide ? hiddenPath : shownPath(path)
  const target = resolve(input.workspace, input.cwd ?? ".", input.path)
  const lexical = within(resolve(input.workspace), target)
  const real = input.resolved ? within(input.resolved.workspace, input.resolved.target) : lexical
  if (real !== undefined) {
    const name = shown(lexical ?? real)
    return { text: fileLine({ form: "inside", file: name.text }), redacted: name.redacted }
  }
  if (lexical !== undefined && input.resolved) {
    const destination = shown(input.resolved.target)
    const link = shown(lexical)
    return {
      text: fileLine({ form: "link", file: destination.text, link: link.text }),
      redacted: destination.redacted || link.redacted,
    }
  }
  const name = shown(target)
  return { text: fileLine({ form: "outside", file: name.text }), redacted: name.redacted }
}

// The three sentences a card's file line takes: the file in the worktree,
// relative to it; a file outside it; and a file outside it reached through a
// link in it. The saved line is read back against these same sentences.
type FileLine =
  | Readonly<{ form: "inside"; file: string }>
  | Readonly<{ form: "outside"; file: string }>
  | Readonly<{ form: "link"; file: string; link: string }>

const fileLineStart = "The file "
const insideEnd = " in the session worktree."
const outsideEnd = ", outside the session worktree."
const linkMiddle = ", outside the session worktree, through a link at "

function fileLine(line: FileLine): string {
  switch (line.form) {
    case "inside": return `${fileLineStart}${line.file}${insideEnd}`
    case "outside": return `${fileLineStart}${line.file}${outsideEnd}`
    case "link": return `${fileLineStart}${line.file}${linkMiddle}${line.link}.`
  }
}

// The wording that separates a line's paths from its sentence. A path that
// holds any of it can be read as other paths, or as another form.
const fileLineWording = [" in the session worktree", ", outside the session worktree", ", through a link at "]

// Every way a saved line reads as one of the three sentences: the inside and
// outside forms at most once each, and the link form once at each place its
// middle wording appears.
function fileLineReadings(affects: string): FileLine[] {
  if (!affects.startsWith(fileLineStart)) return []
  const body = affects.slice(fileLineStart.length)
  const readings: FileLine[] = []
  if (body.endsWith(insideEnd)) readings.push({ form: "inside", file: body.slice(0, -insideEnd.length) })
  if (body.endsWith(outsideEnd)) readings.push({ form: "outside", file: body.slice(0, -outsideEnd.length) })
  if (body.endsWith(".")) {
    const rest = body.slice(0, -1)
    for (let at = rest.indexOf(linkMiddle); at !== -1; at = rest.indexOf(linkMiddle, at + 1)) {
      readings.push({ form: "link", file: rest.slice(0, at), link: rest.slice(at + linkMiddle.length) })
    }
  }
  return readings.filter((reading) => fileLinePaths(reading).every((path) => path !== ""))
}

function fileLinePaths(line: FileLine): string[] {
  return line.form === "link" ? [line.link, line.file] : [line.file]
}

// The directory a request runs in, as the card shows it. It is persisted and
// sent like the file path, so a credential store there, or inside one, as
// written or at its real path, is hidden whole and the line keeps only where
// the directory is; the request is then a hard gate.
export function approvalDirectory(input: { directory: string; workspace: string | undefined; canonical?: RealPath }): {
  text: string
  redacted: boolean
  sensitive: boolean
} {
  const workspace = input.workspace === undefined ? undefined : resolve(input.workspace)
  const directory = workspace === undefined ? input.directory : resolve(workspace, input.directory)
  if (
    namesSecretPath(input.directory)
    || namesSecretPath(directory)
    || realPathNamesSecret(input.canonical, namesSecretPath)
  ) {
    const inside = workspace !== undefined && (directory === workspace || within(workspace, directory) !== undefined)
    return { text: hiddenDirectory(inside), redacted: false, sensitive: true }
  }
  const copy = redactDurableText(input.directory)
  return { text: copy.value, redacted: copy.redacted, sensitive: false }
}

export function approvalFacts(input: {
  path?: string
  workspace: string
  // The directory the request runs in; a relative path is read from here.
  cwd?: string | undefined
  scope: ApprovalScope | undefined
  resolved?: ResolvedApprovalPath | undefined
}): { affects: string; network: string; redacted: boolean; sensitive: boolean } {
  const scope = input.scope ?? unrestrictedApprovalScope
  if (input.path === undefined) return { affects: scope.command, network: scope.network, redacted: false, sensitive: false }
  const sensitive = fileNamesSecret({ path: input.path, workspace: input.workspace, cwd: input.cwd, resolved: input.resolved })
  const file = affectedFile({ path: input.path, workspace: input.workspace, cwd: input.cwd, resolved: input.resolved, hide: sensitive })
  return { affects: file.text, network: scope.network, redacted: file.redacted, sensitive }
}

// A credential file is a hard gate whether the agent named it or any link on
// the way to the file, or the file it ends at, names one.
function fileNamesSecret(input: {
  path: string
  workspace: string
  cwd: string | undefined
  resolved: ResolvedApprovalPath | undefined
}): boolean {
  return namesSecretPath(input.path)
    || namesSecretPath(resolve(input.workspace, input.cwd ?? ".", input.path))
    || (input.resolved !== undefined
      && (namesSecretPath(input.resolved.target)
        || input.resolved.hops.some(namesSecretPath)
        || realPathNamesSecret(input.resolved.canonical, namesSecretPath)))
}

// The directory a request runs in as the agent wrote it, before anything is
// collapsed: a link in it is followed before any ".." after it.
export function requestDirectory(workspace: string, cwd: string | undefined): string {
  if (cwd === undefined) return workspace
  return isAbsolute(cwd) ? cwd : `${workspace}${sep}${cwd}`
}

// Whether a directory is the worktree or inside it, read lexically.
export function inWorktree(workspace: string, directory: string): boolean {
  const root = resolve(workspace)
  const target = resolve(root, directory)
  return target === root || within(root, target) !== undefined
}

// Operands of a command line, read from the directory the request runs in.
export function requestOperands(command: string | undefined, execution: ExecutionResolution): string[] {
  return [
    ...(command === undefined ? [] : commandOperands(command)),
    ...(execution.state === "resolved" && execution.record.kind === "shell"
      ? execution.record.entries.flatMap((entry) => entry.source.kind === "request"
        ? entry.parts.flatMap((part) => part.argv.flatMap(operandPieces))
        : [])
      : []),
  ]
}

// Operands of each package script body, grouped by the manifest it came from,
// since a script runs in its package's directory.
export function scriptOperands(execution: ExecutionResolution): { manifest: string; operands: string[] }[] {
  if (execution.state !== "resolved" || execution.record.kind !== "shell") return []
  return execution.record.entries.flatMap((entry) => entry.source.kind === "package-script"
    ? [{ manifest: entry.source.manifest, operands: entry.parts.flatMap((part) => part.argv.flatMap(operandPieces)) }]
    : [])
}

// Every operand of a command line and of its resolved execution.
export function approvalOperands(command: string | undefined, execution: ExecutionResolution): string[] {
  return [...requestOperands(command, execution), ...scriptOperands(execution).flatMap(({ operands }) => operands)]
}

// The paths a resolved execution record holds in fields the card does not
// show: the directory it runs in, and the manifest each script came from, both
// relative to the worktree's real path.
export function executionRecordPaths(execution: ExecutionResolution): string[] {
  if (execution.state !== "resolved") return []
  const { record } = execution
  return [
    record.cwd,
    ...(record.kind === "shell"
      ? record.entries.flatMap((entry) => entry.source.kind === "package-script" ? [entry.source.manifest] : [])
      : []),
  ]
}

// Whether a resolved execution record holds a credential path in a field the
// card does not show. The command words stay the agent's own text.
export function executionNamesCredentialPath(execution: ExecutionResolution): boolean {
  return executionRecordPaths(execution).some(namesSecretPath)
}

// A file line saved before its path was classified. A word in it that names a
// credential store or secret file hides the whole line's path, and the line
// keeps only where the file is.
export function approvalAffects(affects: string): { text: string; sensitive: boolean } {
  const names = affects.split(/\s+/u).some((word) => (
    [word, word.replace(/[.,;]+$/u, "")].some((candidate) => operandPieces(candidate).some(namesSecretPath))
  ))
  if (!names) return { text: affects, sensitive: false }
  return { text: hiddenFile(savedInWorktree(affects)), sensitive: true }
}

function savedInWorktree(affects: string): boolean {
  return affects.includes(" in the session worktree") && !affects.includes("outside the session worktree")
}

// The paths a saved file line names, in the three sentences affectedFile
// writes. The line is read back only when it reads exactly one way as those
// sentences, no path in that reading holds the sentences' own wording, and
// the reading, rendered again as a card renders a path, gives back the same
// line. A file whose name holds that wording could otherwise be read as other
// paths, and judged at the wrong place. "hidden" when the line already hides
// its path. Undefined when the line cannot be read back as paths: none of
// those sentences, more than one reading, a path that holds their wording, a
// line that does not render back to itself, or a path shortened or with a
// character escaped, which no longer names the file on disk. A Windows path
// whose separator is followed by n, r, t or u reads as escaped too, and so is
// sealed.
const shortenedOrEscaped = /…|\\(?:[nrt]|u[0-9a-f]{4})/u

function savedFilePaths(affects: string): string[] | "hidden" | undefined {
  const readings = fileLineReadings(affects)
  const reading = readings.length === 1 ? readings[0] : undefined
  if (reading === undefined) return undefined
  const paths = fileLinePaths(reading)
  if (paths.some((path) => fileLineWording.some((wording) => path.includes(wording)))) return undefined
  if (paths.some((path) => path.includes("[REDACTED]"))) return "hidden"
  if (paths.some((path) => shortenedOrEscaped.test(path))) return undefined
  const shown = (path: string) => shownPath(path).text
  const rendered = fileLine(reading.form === "link"
    ? { form: "link", file: shown(reading.file), link: shown(reading.link) }
    : { form: reading.form, file: shown(reading.file) })
  return rendered === affects ? paths : undefined
}

// A file line read back from disk, judged as a new card's is: each path it
// names is followed on disk now, under the request's deadline, and a link on
// the way or the file it ends at that names a credential store hides the
// line and makes the card a hard gate. A lookup that fails reads as a
// credential path. A line that names a file it cannot read back as a path
// throws, so the card is sealed. A line that names no file, such as a
// provider's reach, is judged by its words.
export async function savedApprovalAffects(
  affects: string,
  workspace: string,
  deadline: OperationDeadline,
): Promise<{ text: string; sensitive: boolean }> {
  if (affects === hiddenAffectsLine) return { text: affects, sensitive: true }
  const line = approvalAffects(affects)
  if (line.sensitive || !affects.startsWith("The file ")) return line
  const paths = savedFilePaths(affects)
  if (paths === undefined) throw new Error("A saved file line does not name a file Domovoi can check")
  const hidden = { text: hiddenFile(savedInWorktree(affects)), sensitive: true }
  if (paths === "hidden") return hidden
  for (const path of paths) {
    const resolved = await resolveApprovalPath(workspace, path, undefined, deadline)
    if (fileNamesSecret({ path, workspace, cwd: undefined, resolved })) return hidden
  }
  return line
}

export function hiddenFile(inside: boolean): string {
  return inside ? "The file [REDACTED] in the session worktree." : "The file [REDACTED], outside the session worktree."
}

export function hiddenDirectory(inside: boolean): string {
  return inside ? "[REDACTED] in the session worktree" : "[REDACTED], outside the session worktree"
}

// A saved file line with its path hidden, when the path could not be judged.
// A provider's reach line names no path and stays; any other line, whatever
// its format, cannot be shown to be clean and is hidden whole.
const hiddenAffectsLine = "[REDACTED]"

export function hiddenAffects(affects: string): string {
  if (affects.startsWith("The file ")) return hiddenFile(savedInWorktree(affects))
  return providerReachLines.has(affects) ? affects : hiddenAffectsLine
}
