import { z } from "zod"

import { utf16MaxLength, wireRule } from "./validation.js"

import {
  maximumTurnSkillSelections,
  skillContentDigestSchema,
  skillIdSchema,
  skillSummarySchema,
  skillTrustSchema,
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

// The most preview comments one message can send, and so the most one turn
// can deliver.
export const maximumReviewAnnotations = 20
// A bound on the count of open comments a full message left out, far above
// any session a person reviews; it keeps the field a bounded number.
export const maximumReviewOverLimitCount = 1_000_000

// Request identifiers are read as sent: an id is never trimmed into another.
const reviewIdSchema = z.string().min(1).check(utf16MaxLength(256))

const reviewBuildBasisSchema = z.object({
  // The preview artifact, one variant of a group or a lone render, that the
  // person chose for the agent to build on.
  artifactId: reviewIdSchema,
}).strict()

// What a person sends with one message from the preview (rulings Q348 A and
// Q342 A): the open comments they chose and the variant they chose as the
// build basis. Only these reach the agent. A message without a review sends
// no comment and no build basis, whatever comments are open (ruling Q402: the
// legacy default that attached every open comment went before 0.8.0).
// `{ annotationIds: [] }` says the same thing explicitly, and is what a client
// sends when its surface attaches nothing.
//
// `omittedOverLimit` is how many more open comments the client left out
// because the message was full: present only on a full review, absent when it
// left none out. The daemon records it as the turn's limit omission, so the
// person sees the comments that missed the turn. It is a count, never a
// selection: the daemon still sends only the comments the review names.
export const sessionSendReviewSchema = wireRule(z.object({
  annotationIds: z.array(reviewIdSchema).max(maximumReviewAnnotations).refine(
    (ids) => new Set(ids).size === ids.length,
    "Each comment is sent once",
  ),
  buildBasis: reviewBuildBasisSchema.optional(),
  omittedOverLimit: z.number().int().positive().max(maximumReviewOverLimitCount).optional(),
}).strict().refine(
  (review) => review.omittedOverLimit === undefined || review.annotationIds.length === maximumReviewAnnotations,
  { path: ["omittedOverLimit"], message: "Comments are left over the limit only when the message is full" },
), { rule: "review-over-limit-only-when-full", maximumReviewAnnotations })

// The error data on a review the daemon refused: a named comment is not open
// on the session, or the build basis is not one of its previews. The whole
// message is refused. Like an attachment or skill refusal, a queued send that
// meets it at release is refused rather than held.
export const sessionReviewRefusalSchema = z.object({
  kind: z.literal("session-review-refused"),
  reason: z.enum(["comment-unavailable", "build-basis-unavailable"]),
}).strict()

export const providerPromptAnnotationDeliverySchema = z.object({
  availableCount: nonnegativeCountSchema,
  deliveredIds: z.array(z.string().trim().min(1).check(utf16MaxLength(256))).max(maximumReviewAnnotations).refine(
    (ids) => new Set(ids).size === ids.length,
    "Delivered annotation IDs must be unique",
  ),
  omitted: z.object({
    budget: nonnegativeCountSchema,
    limit: nonnegativeCountSchema,
  }).strict(),
  // Present when the message sent a build basis; it is always delivered.
  buildBasis: reviewBuildBasisSchema.optional(),
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
  trust: skillTrustSchema.optional(),
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
export type SessionSendReview = z.infer<typeof sessionSendReviewSchema>
export type SessionReviewRefusal = z.infer<typeof sessionReviewRefusalSchema>
export type DeliveredPromptSkill = z.infer<typeof deliveredPromptSkillSchema>
export type OmittedPromptSkills = z.infer<typeof omittedPromptSkillsSchema>
export type ProviderPromptSkillDelivery = z.infer<typeof providerPromptSkillDeliverySchema>
export type ProviderPromptDelivery = z.infer<typeof providerPromptDeliverySchema>
