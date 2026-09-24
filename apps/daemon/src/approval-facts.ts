import { lstat, readlink } from "node:fs/promises"
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path"

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

export type ResolvedApprovalPath = Readonly<{ target: string; workspace: string }>

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
// component that does not exist is kept as written. Undefined when the links
// loop past the bound.
async function followPath(path: string): Promise<string | undefined> {
  const root = parse(path).root
  let current = root
  const pending = path.slice(root.length).split(separators).filter((part) => part !== "")
  let links = 0
  while (pending.length > 0) {
    const part = pending.shift()!
    if (part === ".") continue
    if (part === "..") { current = dirname(current); continue }
    const next = join(current, part)
    let isLink = false
    try { isLink = (await lstat(next)).isSymbolicLink() } catch { /* absent or unreadable: kept as written */ }
    if (!isLink) { current = next; continue }
    if (++links > maximumLinksFollowed) return undefined
    const target = await readlink(next)
    const targetRoot = parse(target).root
    if (targetRoot !== "") current = targetRoot
    pending.unshift(...target.slice(targetRoot.length).split(separators).filter((item) => item !== ""))
  }
  return current
}

// Where the path really leads, and where the worktree really is, each followed
// the same way. Undefined when either loops, and then the lexical answer stands.
export async function resolveApprovalPath(workspace: string, path: string, cwd?: string): Promise<ResolvedApprovalPath | undefined> {
  const target = await followPath(requestedPath(workspace, path, cwd))
  const realWorkspace = await followPath(resolve(workspace))
  if (target === undefined || realWorkspace === undefined) return undefined
  return { target, workspace: realWorkspace }
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
    return { text: `The file ${name.text} in the session worktree.`, redacted: name.redacted }
  }
  if (lexical !== undefined && input.resolved) {
    const destination = shown(input.resolved.target)
    const link = shown(lexical)
    return {
      text: `The file ${destination.text}, outside the session worktree, through a link at ${link.text}.`,
      redacted: destination.redacted || link.redacted,
    }
  }
  const name = shown(target)
  return { text: `The file ${name.text}, outside the session worktree.`, redacted: name.redacted }
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
  // A credential file is a hard gate whether the agent named it or a link
  // with an ordinary name leads to it.
  const sensitive = namesSecretPath(input.path)
    || namesSecretPath(resolve(input.workspace, input.cwd ?? ".", input.path))
    || (input.resolved !== undefined && namesSecretPath(input.resolved.target))
  const file = affectedFile({ path: input.path, workspace: input.workspace, cwd: input.cwd, resolved: input.resolved, hide: sensitive })
  return { affects: file.text, network: scope.network, redacted: file.redacted, sensitive }
}
