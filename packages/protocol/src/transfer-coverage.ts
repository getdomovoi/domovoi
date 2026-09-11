import { z } from "zod"

export const sessionTransferIncludedKindSchema = z.enum([
  "repository", "thread", "checkpoints", "artifacts", "artifact-sources",
  "annotations", "annotation-crops", "working-plan", "usage", "runtime-settings",
])

export const sessionTransferExcludedKindSchema = z.enum([
  "provider-credentials", "provider-state", "terminals", "approval-rules",
  "skill-authority", "audit-log", "ignored-files", "external-databases", "auto",
])

export const sessionTransferWarningKindSchema = z.enum([
  "tracked-sensitive-files-may-travel", "promoted-ignored-artifacts",
  "provider-restart-required", "target-reapproval-required",
])

const coverageEntry = <Schema extends z.ZodType>(kind: Schema) => z.object({
  kind,
  count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict()

function uniqueCoverage(
  entries: ReadonlyArray<{ kind: string }>,
  context: z.RefinementCtx,
): void {
  const kinds = new Set<string>()
  entries.forEach((entry, index) => {
    if (kinds.has(entry.kind)) {
      context.addIssue({ code: "custom", path: [index, "kind"], message: "Transfer coverage keys must be unique" })
    }
    kinds.add(entry.kind)
  })
}

// Kept independent of thread state: both manifests and durable history carry
// this coverage, and portable thread state itself appears in a manifest.
export const sessionTransferCoverageSchema = z.object({
  included: z.array(coverageEntry(sessionTransferIncludedKindSchema)).max(sessionTransferIncludedKindSchema.options.length),
  excluded: z.array(coverageEntry(sessionTransferExcludedKindSchema)).max(sessionTransferExcludedKindSchema.options.length),
  warnings: z.array(coverageEntry(sessionTransferWarningKindSchema)).max(sessionTransferWarningKindSchema.options.length),
}).strict().superRefine((coverage, context) => {
  uniqueCoverage(coverage.included, context)
  uniqueCoverage(coverage.excluded, context)
  uniqueCoverage(coverage.warnings, context)
})
