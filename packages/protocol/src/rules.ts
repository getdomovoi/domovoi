import { z } from "zod"
import { clientKindSchema } from "./identifiers.js"
import { utf16MaxLength } from "./validation.js"

export const approvalRuleRevokeParamsSchema = z.object({
  ruleId: z.string().trim().min(1).check(utf16MaxLength(256)),
  client: clientKindSchema,
}).strict()

export const hardGateCategoryIdSchema = z.enum([
  "privileged-operations", "destructive-operations", "deployment", "infrastructure",
  "database-migrations", "credentials", "network", "outside-project", "skill-installation",
])
export const hardGateCategorySchema = z.object({
  id: hardGateCategoryIdSchema,
  label: z.string().trim().min(1).check(utf16MaxLength(256)),
}).strict()
export const permissionHardGatesParamsSchema = z.object({}).strict()
export const permissionHardGatesResultSchema = z.object({
  categories: z.array(hardGateCategorySchema).min(1).max(hardGateCategoryIdSchema.options.length)
    .refine((categories) => new Set(categories.map(({ id }) => id)).size === categories.length, "Hard-gate categories must be unique"),
}).strict()

export type HardGateCategory = z.infer<typeof hardGateCategorySchema>
