import { z } from "zod"

export const maximumExecutionEntries = 64
export const maximumExecutionParts = 32
export const maximumExecutionArguments = 128
export const maximumExecutionTextLength = 8_192

export const executionDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export const projectRelativePathSchema = z.string().min(1).max(4_096).refine((value) => {
  if (value === ".") return true
  if (value.startsWith("/") || /^[A-Za-z]:/u.test(value) || value.includes("\\")) return false
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
}, "Path must be a canonical project-relative POSIX path")

const executionArgumentSchema = z.string().max(maximumExecutionTextLength)
const executionArgvSchema = z.array(executionArgumentSchema)
  .min(1)
  .max(maximumExecutionArguments)
  .refine((argv) => argv[0] !== "", "Executable cannot be empty")
const executionOperatorSchema = z.enum(["&&", "||", "|", ";"])

const executionRequestSourceSchema = z.object({
  kind: z.literal("request"),
}).strict()

const executionPackageScriptSourceSchema = z.object({
  kind: z.literal("package-script"),
  manager: z.enum(["npm", "pnpm", "yarn", "bun"]),
  manifest: projectRelativePathSchema.refine(
    (path) => path === "package.json" || path.endsWith("/package.json"),
    "Package script manifest must name package.json",
  ),
  name: z.string().regex(/^[a-z0-9](?:[a-z0-9:._-]*[a-z0-9])?$/iu).max(256),
  phase: z.enum(["pre", "main", "post"]),
  arguments: z.array(executionArgumentSchema).max(maximumExecutionArguments),
  sourceDigest: executionDigestSchema,
}).strict()

export const executionEntrySourceSchema = z.discriminatedUnion("kind", [
  executionRequestSourceSchema,
  executionPackageScriptSourceSchema,
])

export const executionPartSchema = z.object({
  operator: executionOperatorSchema.nullable(),
  argv: executionArgvSchema,
  expandsTo: z.array(z.number().int().nonnegative()).max(3).refine(
    (ids) => new Set(ids).size === ids.length,
    "Expansion entry IDs must be unique",
  ),
}).strict()

export const executionEntrySchema = z.object({
  id: z.number().int().nonnegative(),
  source: executionEntrySourceSchema,
  parts: z.array(executionPartSchema).min(1).max(maximumExecutionParts),
}).strict()

const executionRecordFields = {
  version: z.literal(1),
  cwd: projectRelativePathSchema,
} as const

const shellExecutionRecordSchema = z.object({
  ...executionRecordFields,
  kind: z.literal("shell"),
  // This fingerprint deliberately does not claim that resolved configuration,
  // plugins, source files, or dependency binaries remain unchanged.
  coverage: z.literal("command-and-script-text"),
  entries: z.array(executionEntrySchema).min(1).max(maximumExecutionEntries),
}).strict().superRefine((record, context) => {
  const references = Array.from({ length: record.entries.length }, () => 0)
  record.entries.forEach((entry, entryIndex) => {
    if (entry.id !== entryIndex) {
      context.addIssue({
        code: "custom",
        path: ["entries", entryIndex, "id"],
        message: "Execution entry IDs must equal their array position",
      })
    }
    if ((entryIndex === 0) !== (entry.source.kind === "request")) {
      context.addIssue({
        code: "custom",
        path: ["entries", entryIndex, "source"],
        message: "Only execution entry zero may describe the request",
      })
    }
    entry.parts.forEach((part, partIndex) => {
      if ((partIndex === 0) !== (part.operator === null)) {
        context.addIssue({
          code: "custom",
          path: ["entries", entryIndex, "parts", partIndex, "operator"],
          message: "Only the first command part may omit its operator",
        })
      }
      part.expandsTo.forEach((target, targetIndex) => {
        if (target <= entryIndex || target >= record.entries.length) {
          context.addIssue({
            code: "custom",
            path: ["entries", entryIndex, "parts", partIndex, "expandsTo", targetIndex],
            message: "Script expansions must reference a later execution entry",
          })
          return
        }
        references[target] = references[target]! + 1
      })
    })
  })
  references.slice(1).forEach((count, index) => {
    if (count !== 1) {
      context.addIssue({
        code: "custom",
        path: ["entries", index + 1],
        message: "Every expanded script entry must be referenced exactly once",
      })
    }
  })
})

const workspaceFileToolExecutionRecordSchema = z.object({
  ...executionRecordFields,
  kind: z.literal("workspace-file-tool"),
  coverage: z.literal("tool-and-workspace-scope"),
  tool: z.enum(["Edit", "Write", "MultiEdit", "NotebookEdit"]),
  scope: z.literal("workspace"),
}).strict()

export const executionRecordSchema = z.union([
  shellExecutionRecordSchema,
  workspaceFileToolExecutionRecordSchema,
])

export const unresolvedExecutionReasonSchema = z.enum([
  "command-missing",
  "cwd-outside-project",
  "unsupported-syntax",
  "package-script-unresolved",
  "sensitive-content",
])

export const resolvedExecutionSchema = z.object({
  state: z.literal("resolved"),
  record: executionRecordSchema,
  digest: executionDigestSchema,
}).strict()

export const executionResolutionSchema = z.discriminatedUnion("state", [
  resolvedExecutionSchema,
  z.object({
    state: z.literal("unresolved"),
    reason: unresolvedExecutionReasonSchema,
  }).strict(),
])

export type ExecutionRecord = z.infer<typeof executionRecordSchema>
export type ExecutionEntry = z.infer<typeof executionEntrySchema>
export type ExecutionResolution = z.infer<typeof executionResolutionSchema>
export type ResolvedExecution = z.infer<typeof resolvedExecutionSchema>
export type UnresolvedExecutionReason = z.infer<typeof unresolvedExecutionReasonSchema>
