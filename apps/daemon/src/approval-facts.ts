import { isAbsolute, relative, resolve, sep } from "node:path"

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

export function approvalFacts(input: {
  path?: string
  workspace: string
  scope: ApprovalScope | undefined
}): { affects: string; network: string } {
  const scope = input.scope ?? unrestrictedApprovalScope
  if (input.path === undefined) return { affects: scope.command, network: scope.network }
  const target = resolve(input.workspace, input.path)
  const inside = relative(resolve(input.workspace), target)
  const affects = inside !== "" && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)
    ? `The file ${inside.split(sep).join("/")} in the session worktree.`
    : `The file ${target}, outside the session worktree.`
  return { affects, network: scope.network }
}
