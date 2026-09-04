import { z } from "zod"

import {
  maximumTurnSkillSelections,
  skillContentDigestSchema,
  skillIdSchema,
  skillSummarySchema,
} from "./skills.js"

/**
 * Deterministic Domovoi payload bound, measured with JavaScript String.length.
 * This is not a provider token-window guarantee; tokenization differs by model.
 */
export const maximumProviderPromptCodeUnits = 262_144
export const maximumDeliveredPromptSkills = maximumTurnSkillSelections
export const maximumPromptSkillSelections = 2_048

const nonnegativeCountSchema = z.number().int().nonnegative()
const deliveryStatusSchema = z.object({
  status: z.literal("not-required"),
}).strict()

export const providerPromptBudgetSchema = z.object({
  unit: z.literal("utf16-code-units"),
  limit: z.number().int().positive(),
  used: nonnegativeCountSchema,
}).strict().superRefine((budget, context) => {
  if (budget.used > budget.limit) {
    context.addIssue({
      code: "custom",
      path: ["used"],
      message: "Measured prompt size cannot exceed the recorded budget",
    })
  }
})

export const providerPromptHandoffDeliverySchema = z.discriminatedUnion("status", [
  deliveryStatusSchema,
  z.object({
    status: z.literal("delivered"),
    omitted: z.object({
      threadItems: nonnegativeCountSchema,
      artifacts: nonnegativeCountSchema,
      annotations: nonnegativeCountSchema,
    }).strict(),
  }).strict(),
])

export const providerPromptWorkingPlanDeliverySchema = z.discriminatedUnion("status", [
  deliveryStatusSchema,
  z.object({
    status: z.literal("delivered"),
    revision: nonnegativeCountSchema,
    structureRevision: nonnegativeCountSchema,
  }).strict(),
])

export const providerPromptAnnotationDeliverySchema = z.object({
  availableCount: nonnegativeCountSchema,
  deliveredIds: z.array(z.string().trim().min(1).max(256)).max(20).refine(
    (ids) => new Set(ids).size === ids.length,
    "Delivered annotation IDs must be unique",
  ),
  omitted: z.object({
    budget: nonnegativeCountSchema,
    limit: nonnegativeCountSchema,
  }).strict(),
}).strict().superRefine((delivery, context) => {
  const accounted = delivery.deliveredIds.length
    + delivery.omitted.budget
    + delivery.omitted.limit
  if (accounted !== delivery.availableCount) {
    context.addIssue({
      code: "custom",
      path: ["availableCount"],
      message: "Every available annotation must be delivered or omitted",
    })
  }
})

export const deliveredPromptSkillSchema = z.object({
  id: skillIdSchema,
  name: skillSummarySchema.shape.name,
  contentDigest: skillContentDigestSchema,
  contentTruncated: z.boolean(),
}).strict()

const omittedPromptSkillIdsSchema = z.array(skillIdSchema)
  .max(maximumPromptSkillSelections)

export const omittedPromptSkillsSchema = z.object({
  budget: omittedPromptSkillIdsSchema,
  limit: omittedPromptSkillIdsSchema,
  unavailable: omittedPromptSkillIdsSchema,
  reviewChanged: omittedPromptSkillIdsSchema,
  policy: omittedPromptSkillIdsSchema,
}).strict()

export const providerPromptSkillDeliverySchema = z.object({
  selection: z.enum(["project-default", "turn-explicit"]),
  delivered: z.array(deliveredPromptSkillSchema).max(maximumDeliveredPromptSkills),
  omitted: omittedPromptSkillsSchema,
}).strict().superRefine((delivery, context) => {
  const omittedIds = Object.values(delivery.omitted).flat()
  const selectedIds = [
    ...delivery.delivered.map((skill) => skill.id),
    ...omittedIds,
  ]
  if (selectedIds.length > maximumPromptSkillSelections) {
    context.addIssue({
      code: "custom",
      path: ["omitted"],
      message: "Prompt skill selection exceeds the delivery metadata limit",
    })
  }
  if (new Set(selectedIds).size !== selectedIds.length) {
    context.addIssue({
      code: "custom",
      path: ["omitted"],
      message: "Each selected skill must be delivered or have exactly one omission reason",
    })
  }
  if (delivery.selection === "turn-explicit" && omittedIds.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["omitted"],
      message: "Explicitly selected skills must all be delivered",
    })
  }
})

export const providerPromptDeliverySchema = z.object({
  version: z.literal(1),
  budget: providerPromptBudgetSchema,
  handoff: providerPromptHandoffDeliverySchema,
  workingPlan: providerPromptWorkingPlanDeliverySchema,
  annotations: providerPromptAnnotationDeliverySchema,
  skills: providerPromptSkillDeliverySchema,
}).strict()

export type ProviderPromptBudget = z.infer<typeof providerPromptBudgetSchema>
export type ProviderPromptHandoffDelivery = z.infer<typeof providerPromptHandoffDeliverySchema>
export type ProviderPromptWorkingPlanDelivery = z.infer<typeof providerPromptWorkingPlanDeliverySchema>
export type ProviderPromptAnnotationDelivery = z.infer<typeof providerPromptAnnotationDeliverySchema>
export type DeliveredPromptSkill = z.infer<typeof deliveredPromptSkillSchema>
export type OmittedPromptSkills = z.infer<typeof omittedPromptSkillsSchema>
export type ProviderPromptSkillDelivery = z.infer<typeof providerPromptSkillDeliverySchema>
export type ProviderPromptDelivery = z.infer<typeof providerPromptDeliverySchema>
