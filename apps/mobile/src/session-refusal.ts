import {
  repositoryGitFilterErrorCode,
  repositoryGitFilterRefusalSchema,
  type RepositoryGitFilterRefusal,
  type RepositoryGitFilterScope,
} from "@getdomovoi/protocol"

import { DaemonError } from "./lib/daemon"

// A start the daemon refused because checking the repository out would run a
// git filter its own Git config sets (Skills design step 16). The phone shows
// the refusal with the filters it names and points to what is held back; it
// cannot trust (ruling Q67), so it says where trust is granted (ruling Q203
// A). Codex's own refusal of a worktree's .codex config still reaches clients
// as prose with no code, so only this refusal is read.
//
// The desktop and web card words the same refusal in
// packages/ui/src/session-refusal-card.tsx; the phone does not depend on
// packages/ui, so the wording is kept here and held to it by tests.

export type PhoneRefusal = {
  title: string
  code: string
  sentence: string
  // "sops · local git config", one per driver and scope.
  names: string[]
  // Drivers the daemon counted but did not name.
  omitted: number
  // Trusting on desktop or web would lift the refusal: false when the
  // repository cannot be trusted. A trusted repository's filters are lifted
  // by trusting it again from a client that shows them.
  awaitsTrust: boolean
}

const scopeLabel: Record<RepositoryGitFilterScope, string> = {
  local: "local git config",
  worktree: "worktree git config",
  command: "command-line git config",
}

export function phoneRefusalFrom(cause: unknown, repository: string, machine: string): PhoneRefusal | undefined {
  if (!(cause instanceof DaemonError) || cause.code !== repositoryGitFilterErrorCode) return undefined
  const data = repositoryGitFilterRefusalSchema.safeParse(cause.data)
  if (!data.success) return undefined
  const refusal = data.data
  const { trust } = refusal
  return {
    title: "Domovoi did not start this session",
    code: "refused · untrusted git filter",
    sentence: refusalSentence(refusal, repository, machine),
    names: refusal.drivers.map((driver) => `${driver.name} · ${scopeLabel[driver.scope]}`),
    omitted: refusal.omittedDrivers,
    // A trusted refusal means the grant did not acknowledge the git filters,
    // or acknowledged others, so trusting again lifts it too.
    awaitsTrust: trust.state === "trusted" || trust.reason === "not-trusted" || trust.reason === "config-changed",
  }
}

function refusalSentence(refusal: RepositoryGitFilterRefusal, repository: string, machine: string): string {
  const named = refusal.drivers.map((driver) => driver.name).filter((name, index, all) => all.indexOf(name) === index)
  const list = named.length <= 1 ? named.join("") : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`
  const many = named.length + refusal.omittedDrivers > 1
  const lead = `Checking out ${repository} would run the ${list} ${many ? "filter drivers" : "filter driver"}${refusal.omittedDrivers > 0 ? ` and ${refusal.omittedDrivers} more` : ""}`
  const { trust } = refusal
  if (trust.state === "trusted") {
    return `${lead}. ${repository} is trusted on ${machine}, but its Git filters stay held back until they are reviewed: they were not shown when it was trusted, or they changed since.`
  }
  if (trust.reason === "cannot-trust") return `${lead}, and ${repository} cannot be trusted on ${machine}.`
  return `${lead}, which ${many ? "are" : "is"} not trusted on ${machine}.`
}
