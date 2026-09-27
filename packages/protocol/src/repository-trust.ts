import { z } from "zod"

import { clientIdentityIdSchema } from "./identifiers.js"
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

// Only desktop and web clients grant or take back trust. A phone or tablet
// credential does not get the trust methods (they are outside
// phoneAndTabletRpcMethods), and a trust record names the client that granted it.
export const repositoryTrustGrantClients = ["desktop", "web"] as const
export const repositoryTrustClientSchema = z.enum(repositoryTrustGrantClients)

export const repositoryConfigDigestSchema = skillContentDigestSchema
// The same cap as tool.inventory's projectId, so an id read there can be sent here.
export const repositoryTrustProjectIdSchema = z.string().min(1).check(utf16MaxLength(256))

const grantFields = {
  // The configuration digest the grant covers.
  trustedDigest: repositoryConfigDigestSchema,
  trustedAt: offsetDateTimeSchema,
  trustedBy: z.object({
    client: repositoryTrustClientSchema,
    clientId: clientIdentityIdSchema.optional(),
  }).strict(),
}

// config-changed keeps the earlier grant so a client can show what was trusted
// and when; the repository is not trusted.
export const repositoryTrustStateSchema = z.discriminatedUnion("state", [
  z.discriminatedUnion("reason", [
    z.object({ state: z.literal("untrusted"), reason: z.literal("not-trusted") }).strict(),
    z.object({ state: z.literal("untrusted"), reason: z.literal("config-changed"), ...grantFields }).strict(),
  ]),
  z.object({ state: z.literal("trusted"), ...grantFields }).strict(),
])

type RepositoryTrustStateValue = z.infer<typeof repositoryTrustStateSchema>

// A grant counts only for the digest it covers: trusted means the current
// digest is the trusted one, and config-changed means it is not.
export function refineRepositoryTrustPin(
  configDigest: string,
  trust: RepositoryTrustStateValue,
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
// a new review.
export const repositoryTrustResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("trusted"), repository: repositoryTrustSchema }).strict()
    .refine((result) => result.repository.trust.state === "trusted", { path: ["repository", "trust"], message: "A trusted outcome carries a trusted repository" }),
  z.object({ outcome: z.literal("config-changed"), repository: repositoryTrustSchema }).strict(),
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

export const repositoryRevokeTrustResultSchema = z.object({
  repository: repositoryTrustSchema,
  threads: z.array(repositoryTrustThreadRestartSchema).max(1_024),
}).strict().superRefine((result, context) => {
  const { trust } = result.repository
  if (trust.state !== "untrusted" || trust.reason !== "not-trusted") {
    context.addIssue({ code: "custom", path: ["repository", "trust"], message: "A revoked repository is not trusted" })
  }
  const seen = new Set<string>()
  for (const [index, thread] of result.threads.entries()) {
    if (seen.has(thread.sessionId)) context.addIssue({ code: "custom", path: ["threads", index, "sessionId"], message: "A session is listed once" })
    seen.add(thread.sessionId)
  }
})

export type RepositoryTrustGrantClient = z.infer<typeof repositoryTrustClientSchema>
export type RepositoryTrustState = z.infer<typeof repositoryTrustStateSchema>
export type RepositoryTrust = z.infer<typeof repositoryTrustSchema>
export type RepositoryTrustParams = z.infer<typeof repositoryTrustParamsSchema>
export type RepositoryTrustResult = z.infer<typeof repositoryTrustResultSchema>
export type RepositoryRevokeTrustParams = z.infer<typeof repositoryRevokeTrustParamsSchema>
export type RepositoryTrustThreadRestart = z.infer<typeof repositoryTrustThreadRestartSchema>
export type RepositoryRevokeTrustResult = z.infer<typeof repositoryRevokeTrustResultSchema>
