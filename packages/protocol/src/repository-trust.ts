import { z } from "zod"

import { clientIdentityIdSchema } from "./identifiers.js"
import { inventoryText, toolInventoryPathSchema } from "./inventory-text.js"
import { skillContentDigestSchema } from "./skills.js"
import { offsetDateTimeSchema, utf16MaxLength } from "./validation.js"

// Trust lets the daemon load what a repository brings for its agents: hooks,
// tool servers, plugins, environment keys and git filters. It is recorded per
// machine and per repository, by the daemon on the machine that holds the
// repository, and pinned to the digest of the repository's provider
// configuration files the person reviewed (tool.inventory's configDigest). Any
// change to those files makes the digest differ, and the repository is
// untrusted again until it is reviewed and trusted anew. Trust never answers or
// skips a hard gate, so no field here or in the trust methods names one.

// Only desktop and web clients grant or take back trust. The daemon decides
// from the connection's credential, never from a declared client (ruling Q68,
// 2026-09-27): the daemon owner's bearer credential counts as desktop, so any
// process running as the owner can call the trust methods; a paired device
// credential needs a desktop or web binding with full access. Every other
// connection is refused (repositoryTrustRpcMethods in rpc.ts). A trust record
// names the client that granted it.
export const repositoryTrustGrantClients = ["desktop", "web"] as const
export const repositoryTrustClientSchema = z.enum(repositoryTrustGrantClients)

export const repositoryConfigDigestSchema = skillContentDigestSchema
// The same cap as tool.inventory's projectId, so an id read there can be sent here.
export const repositoryTrustProjectIdSchema = z.string().min(1).check(utf16MaxLength(256))

// ISO validation accepts any number of fractional digits, so the length is
// capped first and an oversized value is refused before it is read as a time.
export const repositoryTrustTimestampSchema = z.string().check(utf16MaxLength(40)).pipe(offsetDateTimeSchema)

const grantFields = {
  // The configuration digest the grant covers.
  trustedDigest: repositoryConfigDigestSchema,
  trustedAt: repositoryTrustTimestampSchema,
  trustedBy: z.object({
    client: repositoryTrustClientSchema,
    clientId: clientIdentityIdSchema.optional(),
  }).strict(),
}

// Why a repository cannot be trusted whatever the person approves: input its
// agent would load that the configuration digest does not cover (ruling Q121
// A). Codes, not prose: a client words them.
//   nested-config: a .codex folder or .agents/skills below the root, on the
//     way down to a session folder, or a link on that way.
//   main-checkout-hooks: in a linked worktree, the main checkout's .codex
//     folder holds hooks, or a file there that could hold them is unreadable.
//   main-checkout-unknown: the main checkout of a linked worktree cannot be
//     found safely.
//   instructions-outside: an instruction file outside the repository, or one
//     reached through a link.
// The path is relative to the root when inside it and absolute otherwise, and
// the daemon redacts it as it does an inventory path.
export const repositoryTrustRefusalCodes = ["nested-config", "main-checkout-hooks", "main-checkout-unknown", "instructions-outside"] as const
export const repositoryTrustRefusalSchema = z.object({
  provider: inventoryText(64),
  code: z.enum(repositoryTrustRefusalCodes),
  path: toolInventoryPathSchema,
}).strict()
export const maximumRepositoryTrustRefusals = 32

// config-changed keeps the earlier grant so a client can show what was trusted
// and when; the repository is not trusted. cannot-trust lists the refusals, at
// most maximumRepositoryTrustRefusals, and counts the rest in omittedRefusals
// so a client never presents a cut list as the whole of it. It pins to no
// digest, since what it names is outside what a digest covers.
const repositoryTrustStateUnion = z.discriminatedUnion("state", [
  z.discriminatedUnion("reason", [
    z.object({ state: z.literal("untrusted"), reason: z.literal("not-trusted") }).strict(),
    z.object({ state: z.literal("untrusted"), reason: z.literal("config-changed"), ...grantFields }).strict(),
    z.object({
      state: z.literal("untrusted"),
      reason: z.literal("cannot-trust"),
      refusals: z.array(repositoryTrustRefusalSchema).min(1).max(maximumRepositoryTrustRefusals),
      omittedRefusals: z.number().int().nonnegative().max(1_000_000),
    }).strict(),
  ]),
  z.object({ state: z.literal("trusted"), ...grantFields }).strict(),
])

// The schema is typed by this name so declaration output refers to it rather
// than spelling the union out in every trust result and in the tool
// inventory; spelled out, it takes rpcMethods past what the compiler will
// serialize (TS7056). A name only survives on a type written out, not on an
// inferred one. The annotation below checks that what the schema reads fits it.
type RepositoryTrustGrant = {
  trustedDigest: string
  trustedAt: string
  trustedBy: { client: RepositoryTrustGrantClient; clientId?: string | undefined }
}
export type RepositoryTrustState =
  | { state: "untrusted"; reason: "not-trusted" }
  | ({ state: "untrusted"; reason: "config-changed" } & RepositoryTrustGrant)
  | { state: "untrusted"; reason: "cannot-trust"; refusals: RepositoryTrustRefusal[]; omittedRefusals: number }
  | ({ state: "trusted" } & RepositoryTrustGrant)
export const repositoryTrustStateSchema: z.ZodType<RepositoryTrustState, RepositoryTrustState> = repositoryTrustStateUnion

// A grant counts only for the digest it covers: trusted means the current
// digest is the trusted one, and config-changed means it is not.
export function refineRepositoryTrustPin(
  configDigest: string,
  trust: RepositoryTrustState,
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  if (trust.state === "trusted" && trust.trustedDigest !== configDigest) {
    context.addIssue({ code: "custom", path, message: "Trust covers only the configuration digest it was granted for" })
  }
  if (trust.state === "untrusted" && trust.reason === "config-changed" && trust.trustedDigest === configDigest) {
    context.addIssue({ code: "custom", path, message: "A changed configuration has a digest other than the trusted one" })
  }
}

// One repository's trust on this machine, against its current configuration digest.
export const repositoryTrustSchema = z.object({
  projectId: repositoryTrustProjectIdSchema,
  configDigest: repositoryConfigDigestSchema,
  trust: repositoryTrustStateSchema,
}).strict().superRefine((repository, context) => {
  refineRepositoryTrustPin(repository.configDigest, repository.trust, context, ["trust"])
})

// configDigest is the digest the client showed the person. The daemon grants
// trust only when it is still the repository's current digest.
export const repositoryTrustParamsSchema = z.object({
  projectId: repositoryTrustProjectIdSchema,
  configDigest: repositoryConfigDigestSchema,
  client: repositoryTrustClientSchema,
}).strict()

// config-changed: the configuration no longer matches the reviewed digest, so
// nothing was granted. The repository's current digest and state come back for
// a new review. cannot-trust: the digest matched, but the repository holds
// input the digest does not cover, so nothing was granted.
export const repositoryTrustResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("trusted"), repository: repositoryTrustSchema }).strict()
    .refine((result) => result.repository.trust.state === "trusted", { path: ["repository", "trust"], message: "A trusted outcome carries a trusted repository" }),
  z.object({ outcome: z.literal("config-changed"), repository: repositoryTrustSchema }).strict(),
  z.object({ outcome: z.literal("cannot-trust"), repository: repositoryTrustSchema }).strict()
    .refine((result) => result.repository.trust.state === "untrusted" && result.repository.trust.reason === "cannot-trust", {
      path: ["repository", "trust"],
      message: "A cannot-trust outcome carries the refusals",
    }),
])

export const repositoryRevokeTrustParamsSchema = z.object({
  projectId: repositoryTrustProjectIdSchema,
  client: repositoryTrustClientSchema,
}).strict()

// Taking trust back restarts the repository's running agent threads at once,
// which stops a running turn and its tool servers. unconfirmed: the daemon
// asked the old thread to stop and could not confirm that it did.
export const repositoryTrustThreadRestartSchema = z.object({
  sessionId: z.string().min(1).check(utf16MaxLength(512)),
  outcome: z.enum(["restarted", "unconfirmed"]),
}).strict()

// A revoke stops every such thread however many there are (ruling Q179 A). It
// lists at most maximumRepositoryTrustThreadRestarts, and omittedThreads
// counts the rest; it is present only when something was left out, so a
// client never presents a cut list as the whole of it. A daemon may list
// fewer than the maximum, so the count is not tied to a full list.
export const maximumRepositoryTrustThreadRestarts = 1_024

export const repositoryRevokeTrustResultSchema = z.object({
  repository: repositoryTrustSchema,
  threads: z.array(repositoryTrustThreadRestartSchema).max(maximumRepositoryTrustThreadRestarts),
  omittedThreads: z.number().int().min(1).max(1_000_000).optional(),
}).strict().superRefine((result, context) => {
  const { trust } = result.repository
  // No grant is left, so the repository is not trusted, or cannot be.
  if (trust.state !== "untrusted" || trust.reason === "config-changed") {
    context.addIssue({ code: "custom", path: ["repository", "trust"], message: "A revoked repository is not trusted" })
  }
  const seen = new Set<string>()
  for (const [index, thread] of result.threads.entries()) {
    if (seen.has(thread.sessionId)) context.addIssue({ code: "custom", path: ["threads", index, "sessionId"], message: "A session is listed once" })
    seen.add(thread.sessionId)
  }
})

// A git filter driver runs a command whenever Git checks a file out or stages
// it. One the repository's own Git config sets (its .git/config, a file that
// config includes, or a worktree's config.worktree) is the repository's; one
// from the person's global or system config is their own tool and is not
// listed. "command" is Git's scope for -c and GIT_CONFIG_* settings, which the
// daemon drops, and is named so a reader never has to leave one out.
export const repositoryGitFilterScopes = ["local", "worktree", "command"] as const
export const repositoryGitFilterScopeSchema = z.enum(repositoryGitFilterScopes)
// A driver's name as the config section spells it: [filter "sops"].
export const maximumRepositoryGitFilterDriverNameLength = 256
export const repositoryGitFilterDriverNameSchema = inventoryText(maximumRepositoryGitFilterDriverNameLength)

// The data of a refusal because Git would run a filter the repository's own
// Git config sets and this machine's trust does not cover it: session.create,
// session.fork, a checkpoint, restore or file revert, or a transfer on either
// machine. It names the drivers, never their commands, and the repository's
// trust against the configuration digest of the refused worktree, read now,
// so a client can offer the trust review. A trusted state means trust was
// taken back or changed while the operation ran. At most
// maximumRepositoryGitFilterDrivers are named, and omittedDrivers counts the
// rest.
export const maximumRepositoryGitFilterDrivers = 32
export const repositoryGitFilterRefusalSchema = z.object({
  kind: z.literal("repository-git-filter"),
  projectId: repositoryTrustProjectIdSchema,
  configDigest: repositoryConfigDigestSchema,
  trust: repositoryTrustStateSchema,
  drivers: z.array(z.object({
    name: repositoryGitFilterDriverNameSchema,
    scope: repositoryGitFilterScopeSchema,
  }).strict()).min(1).max(maximumRepositoryGitFilterDrivers),
  omittedDrivers: z.number().int().nonnegative().max(1_000_000),
}).strict().superRefine((refusal, context) => {
  refineRepositoryTrustPin(refusal.configDigest, refusal.trust, context, ["trust"])
})

export type RepositoryTrustGrantClient = z.infer<typeof repositoryTrustClientSchema>
export type RepositoryTrustRefusal = z.infer<typeof repositoryTrustRefusalSchema>
export type RepositoryTrust = z.infer<typeof repositoryTrustSchema>
export type RepositoryTrustParams = z.infer<typeof repositoryTrustParamsSchema>
export type RepositoryTrustResult = z.infer<typeof repositoryTrustResultSchema>
export type RepositoryRevokeTrustParams = z.infer<typeof repositoryRevokeTrustParamsSchema>
export type RepositoryTrustThreadRestart = z.infer<typeof repositoryTrustThreadRestartSchema>
export type RepositoryRevokeTrustResult = z.infer<typeof repositoryRevokeTrustResultSchema>
export type RepositoryGitFilterScope = z.infer<typeof repositoryGitFilterScopeSchema>
export type RepositoryGitFilterRefusal = z.infer<typeof repositoryGitFilterRefusalSchema>
