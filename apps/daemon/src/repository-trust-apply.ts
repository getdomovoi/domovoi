import { maximumRepositoryTrustRefusals, type RepositoryTrustState, type ToolInventoryEntry } from "@getdomovoi/protocol"

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
// the ones the digest it compared was computed from. Nothing loads under a
// trusted verdict yet: P6b (Claude Code) and P6c (Codex) load it.

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

// The files whose every entry an adapter keeps from its agent today, whatever
// the grant. Each claim is pinned by a test of the adapter's real behaviour:
// Claude Code starts with settingSources ["user"], so the repository's
// settings and .mcp.json are never read (claude.test.ts); Codex refuses a
// worktree holding a .codex config.toml or hooks.json, and marks every path it
// consults for trust untrusted (codex-repository-config.test.ts). Nothing else
// is claimed (ruling Q128 A): Domovoi's own skill catalog reads the skill
// folders into prompts, and OpenCode, Kilo and the ACP agents are stated in
// P7. P6b and P6c narrow these as trusted entries start to load.
const heldBackFiles: Readonly<Record<string, ReadonlySet<string>>> = {
  "claude-code": new Set([".claude/settings.json", ".mcp.json"]),
  codex: new Set([".codex/config.toml", ".codex/hooks.json"]),
}

export const repositoryEntryHeldBack: RepositoryEntryHeldBack = (provider: string, entry: ToolInventoryEntry) => (
  Object.hasOwn(heldBackFiles, provider) && heldBackFiles[provider]!.has(entry.file)
)

// How tool.inventory and the trust step read the project root: entries marked
// by the policy above, and the root read as its session worktrees read it, so
// a refusal every session would meet shows where trust is asked for (ruling
// Q145 A).
export const projectRootRead: RepositoryProviderConfigOptions = { heldBack: repositoryEntryHeldBack, asLinkedWorktree: true }

// The most threads one repository.revokeTrust result lists: the protocol's
// cap on its threads array, which has no count of the rest. A revoke that
// would stop more is refused before it changes anything, so no thread is
// stopped without being reported.
export const maximumRevokedTrustThreads = 1_024
