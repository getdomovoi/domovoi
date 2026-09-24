import { realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { namesSecretFile } from "./permission-policy.js"
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

function shown(path: string): { text: string; redacted: boolean } {
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

// Where the path really leads: the nearest part of it that exists, resolved,
// with the parts that do not exist yet appended, and the worktree resolved the
// same way. Undefined only when nothing up to the root resolves.
export async function resolveApprovalPath(workspace: string, path: string): Promise<ResolvedApprovalPath | undefined> {
  const target = resolve(workspace, path)
  let existing = target
  const missing: string[] = []
  let real: string | undefined
  for (;;) {
    try {
      real = join(await realpath(existing), ...missing)
      break
    } catch {
      const parent = dirname(existing)
      if (parent === existing) return undefined
      missing.unshift(basename(existing))
      existing = parent
    }
  }
  let realWorkspace: string
  try { realWorkspace = await realpath(workspace) } catch { realWorkspace = resolve(workspace) }
  return { target: real, workspace: realWorkspace }
}

function affectedFile(input: { path: string; workspace: string; resolved: ResolvedApprovalPath | undefined }): { text: string; redacted: boolean } {
  const target = resolve(input.workspace, input.path)
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
  scope: ApprovalScope | undefined
  resolved?: ResolvedApprovalPath | undefined
}): { affects: string; network: string; redacted: boolean; sensitive: boolean } {
  const scope = input.scope ?? unrestrictedApprovalScope
  if (input.path === undefined) return { affects: scope.command, network: scope.network, redacted: false, sensitive: false }
  const file = affectedFile({ path: input.path, workspace: input.workspace, resolved: input.resolved })
  // A credential file is a hard gate whether the agent named it or a link
  // with an ordinary name leads to it.
  const sensitive = namesSecretFile(input.path)
    || namesSecretFile(resolve(input.workspace, input.path))
    || (input.resolved !== undefined && namesSecretFile(input.resolved.target))
  return { affects: file.text, network: scope.network, redacted: file.redacted, sensitive }
}
