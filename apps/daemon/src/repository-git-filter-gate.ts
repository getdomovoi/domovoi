import { readGitFilterSettings, readRepositoryGitFilters, repositoryGitFilters, type GitFilterSetting, type RepositoryGitFilter } from "./repository-git-filters.js"
import { readRepositoryProviderConfig, type RepositoryProviderConfig } from "./repository-provider-config.js"
import { projectRootRead, repositoryTrustState } from "./repository-trust-apply.js"
import type { RepositoryTrustGrant } from "./repository-trust-store.js"
import type { RepositoryProviderConfigReader } from "./tool-inventory.js"

// Whether a Git command in a session worktree may run the filters the
// repository's own Git config sets (P8 PR B). Every operation that can run a
// filter (create, fork, transfer in, checkpoint, snapshot, restore, revert,
// transfer out, evidence) asks here first, for the worktree the command runs
// in, and runs its commands in an isolated Git directory
// (isolated-checkout.ts) that reads none of the repository's config. This
// decides what that directory adds:
//
// 1. The worktree's filters, W, as Git reads them there: its config.worktree,
//    included files and onbranch includes count. A config Git cannot read
//    throws (RepositoryGitConfigUnreadableError), and the operation stops.
// 2. W empty: nothing is added.
// 3. Otherwise the project's grant on this machine, looked up now and never
//    taken from an earlier answer (the #662 rule): none refuses not-trusted.
//    A grant whose client never said it showed the git filters
//    (gitFiltersReviewed, repository.trust gitFilters) refuses
//    filters-not-reviewed, once step 4 finds it covers the configuration.
// 4. The project root read now, as tool.inventory and the trust step read it
//    (ruling Q145 A), with its own filters T: its digest must be the one the
//    grant names and nothing in it may refuse trust, else the refusal says
//    config-changed or cannot-trust. A grant made while the config could not
//    be read names a digest that pins no filter, so it never matches a read
//    that lists one.
// 5. W must be T exactly, scope, key and value in Git's order: a worktree
//    that reads other filters than the root (an onbranch include, an edited
//    config.worktree) refuses config-changed (ruling Q144 A's analogue).
// 6. Allowed: T's values are added as command-line config, the values the
//    digest covers, so a change to the repository's config after this read
//    changes nothing that runs. A driver's `required`, when the repository
//    sets it, is reviewed with its commands (the digest and the comparison
//    carry it) and pinned to the reviewed value, since it decides whether Git
//    stores unfiltered bytes when the filter fails.
// 7. Before every command the grant and the project's revoke count are read
//    again (confirm); a revoke or a new grant since step 3 refuses the rest.
//    A command already running finishes within its operation's timeout.
//
// Trust runs the reviewed commands as the person (rulings Q138 A, Q184 A),
// including a command that runs a file in the repository, which an agent's
// edit also changes (ruling Q205 A). .gitattributes is not pinned (ruling
// Q206 A): it only selects which files pass through a reviewed driver.

export type RepositoryFilterTrustSource = {
  projectId: string
  // The project root the grant was made for.
  projectPath: string
  // This machine's grant for the project, read at each call.
  grant(): RepositoryTrustGrant | undefined
  // How many times the project's trust was revoked, read at each call.
  generation(): number
  read?: RepositoryProviderConfigReader | undefined
}

// The project a gated path belongs to: the project root itself, or a session
// worktree of it. Undefined when the path belongs to no open project, which
// holds every repository filter back.
export type RepositoryFilterTrustLookup = (anchor: string) => RepositoryFilterTrustSource | undefined

// not-trusted: no grant, or it was revoked meanwhile. config-changed: the
// configuration read now is not the one trusted, at the root or in the
// worktree. cannot-trust: the root holds input trust cannot cover (ruling
// Q121 A). unreadable: the root's configuration could not be read to compare.
// filters-not-reviewed: the grant covers the configuration, but its client
// never said it showed the git filters (an older client, or a grant made
// before filters could run), so they stay held back until trust is given
// again from a client that shows them.
export type RepositoryFilterRefusalReason = "not-trusted" | "config-changed" | "cannot-trust" | "unreadable" | "filters-not-reviewed"

export type RepositoryFilterGate =
  | {
      open: true
      settings: GitFilterSetting[]
      filters: RepositoryGitFilter[]
      // Command-line config to add: empty unless trusted filters run.
      reviewed: Array<readonly [string, string]>
      projectId: string | undefined
      // Why trust lapsed since the gate opened, or undefined while it holds.
      confirm(): RepositoryFilterRefusalReason | undefined
    }
  | {
      open: false
      settings: GitFilterSetting[]
      filters: RepositoryGitFilter[]
      reason: RepositoryFilterRefusalReason
      projectId: string | undefined
    }

const sameFilters = (left: readonly RepositoryGitFilter[], right: readonly RepositoryGitFilter[]) => (
  left.length === right.length
  && left.every((filter, index) => {
    const other = right[index]!
    return filter.scope === other.scope && filter.key === other.key && filter.value === other.value && filter.required === other.required
  })
)

export async function repositoryFilterGate(input: {
  // The worktree the guarded commands run in.
  worktree: string
  // The path the caller named, which the lookup maps to a project.
  anchor: string
  trust?: RepositoryFilterTrustLookup | undefined
  signal?: AbortSignal | undefined
}): Promise<RepositoryFilterGate> {
  const settings = await readGitFilterSettings(input.worktree, input.signal)
  const filters = repositoryGitFilters(settings)
  if (filters.length === 0) return { open: true, settings, filters, reviewed: [], projectId: undefined, confirm: () => undefined }
  const source = input.trust?.(input.anchor)
  const refuse = (reason: RepositoryFilterRefusalReason): RepositoryFilterGate => ({ open: false, settings, filters, reason, projectId: source?.projectId })
  if (source === undefined) return refuse("not-trusted")
  const generation = source.generation()
  const grant = source.grant()
  if (grant === undefined) return refuse("not-trusted")
  const rootFilters = await readRepositoryGitFilters(source.projectPath, input.signal)
  let config: RepositoryProviderConfig
  try {
    config = await (source.read ?? readRepositoryProviderConfig)(source.projectPath, { ...projectRootRead, gitFilters: rootFilters })
  } catch {
    input.signal?.throwIfAborted()
    return refuse("unreadable")
  }
  input.signal?.throwIfAborted()
  const trust = repositoryTrustState(config, grant)
  if (trust.state !== "trusted") return refuse(trust.reason === "cannot-trust" ? "cannot-trust" : "config-changed")
  if (grant.gitFiltersReviewed !== true) return refuse("filters-not-reviewed")
  if (!sameFilters(filters, rootFilters)) return refuse("config-changed")
  const reviewed: Array<readonly [string, string]> = rootFilters.map(({ key, value }) => [key, value] as const)
  const requiredPins = new Map<string, string>()
  for (const { driver, required } of rootFilters) {
    if (required !== undefined) requiredPins.set(driver, required)
  }
  for (const [driver, required] of requiredPins) reviewed.push([`filter.${driver}.required`, required])
  return {
    open: true,
    settings,
    filters,
    reviewed,
    projectId: source.projectId,
    confirm: () => {
      let current: RepositoryTrustGrant | undefined
      try {
        current = source.grant()
      } catch {
        return "not-trusted"
      }
      return source.generation() === generation && current?.trustedDigest === grant.trustedDigest ? undefined : "not-trusted"
    },
  }
}
