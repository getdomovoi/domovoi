import {
  maximumRepositoryTrustRefusals,
  maximumRepositoryTrustThreadRestarts,
  type RepositoryTrustState,
  type ToolInventoryEntry,
  type ToolInventoryGitFilters,
  type ToolInventoryProvider,
} from "@getdomovoi/protocol"

import { claudeEntryHeldBack, claudeRepositoryFiles, claudeRepositoryLoad } from "./claude-repository-trust.js"
import { codexEntryHeldBack, codexRepositoryFiles, codexRepositoryLoad } from "./codex-repository-trust.js"
import {
  readRepositoryProviderConfig,
  type RepositoryConfigDocuments,
  type RepositoryEntryHeldBack,
  type RepositoryProviderConfig,
  type RepositoryProviderConfigOptions,
} from "./repository-provider-config.js"
import type { RepositoryTrustGrant } from "./repository-trust-store.js"
import type { RepositoryProviderConfigReader } from "./tool-inventory.js"

// The one place that decides whether a repository's own agent configuration
// is trusted (slice P6a), and what the inventory reports held back, so what
// loads and what is reported come from the same rules.
//
// The trust step reads the project root; a session runs in a linked worktree
// of it, whose configuration can differ. A session's verdict reads its own
// worktree, at the call that opens its thread or starts its turn, and never
// relies on an earlier trust answer (#662 round 1): the documents it gives are
// the ones the digest it compared was computed from. Claude Code (P6b,
// claude-repository-trust.ts) and Codex (P6c, codex-repository-trust.ts) each
// load parts of a trusted verdict's documents.

// Why a session's repository configuration is held back. Codes, not prose:
// the notice that words them comes with the later slices (ruling Q153 A).
//   not-trusted: no grant is on record for the repository.
//   cannot-trust: the worktree holds input the digest does not cover (Q121).
//   config-changed: the worktree's configuration is not the one trusted (Q144).
//   unreadable: the worktree's configuration could not be read.
export type RepositoryTrustHeldBackReason = "not-trusted" | "cannot-trust" | "config-changed" | "unreadable"

// A trusted verdict's documents are the files as written, secrets included:
// they are handed to the adapter and never sent, stored or logged.
export type RepositoryTrustVerdict =
  | { state: "trusted"; configDigest: string; documents: RepositoryConfigDocuments }
  | { state: "held-back"; reason: RepositoryTrustHeldBackReason }

// A repository's trust against the configuration read now. A refusal wins over
// any grant: the input it names is outside what the digest covers (ruling Q121
// A). A grant counts only for the digest it names; for any other it is shown
// as the earlier grant of a changed configuration. The reader already redacted
// each refusal's path, and the protocol caps how many are listed.
export function repositoryTrustState(
  config: Pick<RepositoryProviderConfig, "configDigest" | "trustRefusals">,
  grant: RepositoryTrustGrant | undefined,
): RepositoryTrustState {
  if (config.trustRefusals.length > 0) {
    return {
      state: "untrusted",
      reason: "cannot-trust",
      refusals: config.trustRefusals.slice(0, maximumRepositoryTrustRefusals)
        .map(({ provider, reason, path }) => ({ provider, code: reason, path })),
      omittedRefusals: Math.max(0, config.trustRefusals.length - maximumRepositoryTrustRefusals),
    }
  }
  if (grant === undefined) return { state: "untrusted", reason: "not-trusted" }
  const { trustedDigest, trustedAt, trustedBy } = grant
  return trustedDigest === config.configDigest
    ? { state: "trusted", trustedDigest, trustedAt, trustedBy }
    : { state: "untrusted", reason: "config-changed", trustedDigest, trustedAt, trustedBy }
}

// A session worktree's verdict under this machine's grant for its repository.
// Trusted only when the worktree holds nothing that refuses trust and its
// digest is the one the grant names. A read that fails holds the worktree
// back: its error names no path or value (ruling Q123), and the session opens
// as it would untrusted.
export async function repositoryTrustVerdict(
  worktree: string,
  grant: RepositoryTrustGrant | undefined,
  read: RepositoryProviderConfigReader = readRepositoryProviderConfig,
): Promise<RepositoryTrustVerdict> {
  if (grant === undefined) return { state: "held-back", reason: "not-trusted" }
  let config: RepositoryProviderConfig
  try {
    config = await read(worktree, { heldBack: repositoryEntryHeldBack, documents: true })
  } catch {
    return { state: "held-back", reason: "unreadable" }
  }
  const trust = repositoryTrustState(config, grant)
  return trust.state === "trusted"
    ? { state: "trusted", configDigest: config.configDigest, documents: config.documents }
    : { state: "held-back", reason: trust.reason }
}

// The documents a session may load, or undefined when it is held back.
export async function trustedRepositoryConfig(
  worktree: string,
  grant: RepositoryTrustGrant | undefined,
  read?: RepositoryProviderConfigReader,
): Promise<RepositoryConfigDocuments | undefined> {
  const verdict = await repositoryTrustVerdict(worktree, grant, read)
  return verdict.state === "trusted" ? verdict.documents : undefined
}

// The files whose every entry an adapter keeps from its agent unless the
// repository is trusted. Each claim is pinned by a test of the adapter's real
// behaviour: Claude Code starts with settingSources ["user"], so it never
// reads the repository's settings or .mcp.json, and is given parts of them
// only under a trusted verdict (claude.test.ts); Codex marks every path it
// consults for trust untrusted, so it loads nothing from .codex itself,
// refuses a worktree holding a config.toml or hooks.json there unless it is
// trusted, and is given only the servers trustedEntryHeldBack reports under a
// trusted verdict (codex-repository-config.test.ts). Nothing else is claimed
// (ruling Q128 A): Domovoi's own skill catalog reads the skill folders into
// prompts, and OpenCode, Kilo and the ACP agents are stated in P7.
const heldBackFiles: Readonly<Record<string, ReadonlySet<string>>> = {
  "claude-code": claudeRepositoryFiles,
  codex: codexRepositoryFiles,
}

export const repositoryEntryHeldBack: RepositoryEntryHeldBack = (provider: string, entry: ToolInventoryEntry) => (
  Object.hasOwn(heldBackFiles, provider) && heldBackFiles[provider]!.has(entry.file)
)

// The policy under a trusted verdict whose documents are `documents`: Claude
// Code's and Codex's entries are held back unless the plan its adapter passes
// loads them (claude-repository-trust.ts, slice P6b; codex-repository-trust.ts,
// slice P6c); every other provider's are marked as when untrusted.
export function trustedEntryHeldBack(documents: RepositoryConfigDocuments): RepositoryEntryHeldBack {
  const claude = claudeRepositoryLoad(documents)
  const codex = codexRepositoryLoad(documents)
  return (provider, entry) => {
    if (provider === "claude-code" && claudeRepositoryFiles.has(entry.file)) return claudeEntryHeldBack(entry, claude)
    if (provider === "codex" && codexRepositoryFiles.has(entry.file)) return codexEntryHeldBack(entry, codex)
    return repositoryEntryHeldBack(provider, entry)
  }
}

// The providers as the inventory reports them under `trust`. The reader
// marked them with repositoryEntryHeldBack; a trusted repository's are marked
// again from the documents the same read returned, so what is reported as
// loading is what an adapter would load from that digest. The documents never
// leave this function.
export function heldBackUnder(config: RepositoryProviderConfig, trust: RepositoryTrustState): ToolInventoryProvider[] {
  if (trust.state !== "trusted") return config.providers
  const heldBack = trustedEntryHeldBack(config.documents)
  return config.providers.map((provider) => ({
    ...provider,
    entries: provider.entries.map((entry) => ({ ...entry, heldBack: heldBack(provider.provider, entry) })),
  }))
}

// The repository's git filters as the inventory reports them under `trust`:
// the reader marks every one held back, and a trusted grant for the digest
// read now whose client reviewed the filters runs them (P8 PR B,
// repository-git-filter-gate.ts), in every session worktree that reads the
// same filters as the root.
export function gitFiltersUnder(
  filters: ToolInventoryGitFilters,
  trust: RepositoryTrustState,
  grant: RepositoryTrustGrant | undefined,
): ToolInventoryGitFilters {
  if (trust.state !== "trusted" || grant?.gitFiltersReviewed !== true) return filters
  return { ...filters, entries: filters.entries.map((entry) => ({ ...entry, heldBack: false })) }
}

// How tool.inventory and the trust step read the project root: entries marked
// by the policy above, and the root read as its session worktrees read it, so
// a refusal every session would meet shows where trust is asked for (ruling
// Q145 A).
export const projectRootRead: RepositoryProviderConfigOptions = { heldBack: repositoryEntryHeldBack, asLinkedWorktree: true }

// The most threads one repository.revokeTrust result lists: the protocol's
// cap on its threads array. A revoke still stops every thread, however many
// (ruling Q179 A); the result counts the rest in omittedThreads.
export const maximumRevokedTrustThreads: number = maximumRepositoryTrustThreadRestarts
