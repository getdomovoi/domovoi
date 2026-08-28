import { z } from "zod"

export const skillScopeSchema = z.enum(["user", "project", "system"])
export const skillSourceSchema = z.enum(["domovoi", "agents", "kilo", "claude", "codex"])
export const skillIdSchema = z.string().regex(/^skill-[a-f0-9]{12}$/)

export const skillSummarySchema = z.object({
  id: skillIdSchema,
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
  description: z.string().trim().min(1).max(2_048),
  path: z.string().regex(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/),
  scope: skillScopeSchema,
  source: skillSourceSchema,
})

export const skillSummariesSchema = z.array(skillSummarySchema).max(512)
export const skillDocumentSchema = z.object({
  skill: skillSummarySchema,
  content: z.string().max(128 * 1_024),
})

export type SkillScope = z.infer<typeof skillScopeSchema>
export type SkillSource = z.infer<typeof skillSourceSchema>
export type SkillSummary = z.infer<typeof skillSummarySchema>
export type SkillDocument = z.infer<typeof skillDocumentSchema>
