import { describe, expect, it } from "vitest"

import {
  maximumProviderPromptCodeUnits,
  providerPromptDeliverySchema,
  threadItemSchema,
} from "./index.js"

const skillDigest = `sha256:${"a".repeat(64)}`

function delivery() {
  return {
    version: 1 as const,
    budget: {
      unit: "utf16-code-units" as const,
      limit: maximumProviderPromptCodeUnits,
      used: 42_000,
    },
    handoff: {
      status: "delivered" as const,
      omitted: { threadItems: 2, artifacts: 1, annotations: 0 },
    },
    workingPlan: {
      status: "delivered" as const,
      revision: 7,
      structureRevision: 3,
    },
    annotations: {
      availableCount: 3,
      deliveredIds: ["annotation-new", "annotation-middle"],
      omitted: { budget: 1, limit: 0 },
    },
    skills: {
      selection: "project-default" as const,
      delivered: [{
        id: "skill-111111111111",
        name: "plan-preview",
        contentDigest: skillDigest,
        contentTruncated: false,
      }],
      omitted: {
        budget: ["skill-222222222222"],
        limit: ["skill-333333333333"],
        unavailable: ["skill-444444444444"],
        reviewChanged: ["skill-555555555555"],
        policy: ["skill-666666666666"],
      },
    },
  }
}

describe("provider prompt delivery", () => {
  it("persists bounded delivery facts on a successful user item", () => {
    const promptDelivery = providerPromptDeliverySchema.parse(delivery())

    expect(threadItemSchema.parse({
      id: "user-1",
      sessionId: "session-1",
      kind: "user",
      body: "Continue",
      providerPromptDelivery: promptDelivery,
      createdAt: "2026-09-03T16:00:00.000Z",
    })).toMatchObject({ providerPromptDelivery: promptDelivery })
  })

  it("bounds measured output and accounts for every annotation", () => {
    expect(providerPromptDeliverySchema.safeParse({
      ...delivery(),
      budget: {
        unit: "utf16-code-units",
        limit: maximumProviderPromptCodeUnits,
        used: maximumProviderPromptCodeUnits + 1,
      },
    }).success).toBe(false)
    expect(providerPromptDeliverySchema.safeParse({
      ...delivery(),
      annotations: {
        availableCount: 4,
        deliveredIds: ["annotation-new", "annotation-middle"],
        omitted: { budget: 1, limit: 0 },
      },
    }).success).toBe(false)
  })

  it("partitions each selected skill into delivered or one omission reason", () => {
    const duplicate = delivery()
    duplicate.skills.omitted.budget.push("skill-111111111111")
    expect(providerPromptDeliverySchema.safeParse(duplicate).success).toBe(false)

    expect(providerPromptDeliverySchema.safeParse({
      ...delivery(),
      skills: { ...delivery().skills, selection: "turn-explicit" },
    }).success).toBe(false)
  })

  it("stores facts only, never provider-bound context text", () => {
    expect(providerPromptDeliverySchema.safeParse({
      ...delivery(),
      prompt: "secret provider-bound text",
    }).success).toBe(false)
  })
})
