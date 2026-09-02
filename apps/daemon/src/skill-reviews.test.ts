import { DatabaseSync } from "node:sqlite"

import { describe, expect, it } from "vitest"

import { SqliteSkillReviews, maximumSkillManualReviews } from "./skill-reviews.js"

const digest = (character: string) => `sha256:${character.repeat(64)}`

describe("SqliteSkillReviews", () => {
  it("records a manual review against the exact reviewed digest", () => {
    const reviews = new SqliteSkillReviews(new DatabaseSync(":memory:"))
    const recorded = reviews.record({
      skillId: "skill-111111111111",
      contentDigest: digest("a"),
      reviewedBy: { client: "desktop", clientId: "desktop-owner" },
    })

    expect(recorded).toMatchObject({
      skillId: "skill-111111111111",
      contentDigest: digest("a"),
      reviewedBy: { client: "desktop", clientId: "desktop-owner" },
    })
    expect(recorded.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(reviews.find("skill-111111111111", digest("a"))).toEqual(recorded)
  })

  it("does not carry a review across a content change", () => {
    const reviews = new SqliteSkillReviews(new DatabaseSync(":memory:"))
    reviews.record({
      skillId: "skill-111111111111",
      contentDigest: digest("a"),
      reviewedBy: { client: "web" },
    })

    expect(reviews.find("skill-111111111111", digest("b"))).toBeUndefined()
    expect(reviews.find("skill-222222222222", digest("a"))).toBeUndefined()
  })

  it("revokes every recorded digest for the skill", () => {
    const reviews = new SqliteSkillReviews(new DatabaseSync(":memory:"))
    reviews.record({
      skillId: "skill-111111111111",
      contentDigest: digest("a"),
      reviewedBy: { client: "web" },
    })
    reviews.record({
      skillId: "skill-111111111111",
      contentDigest: digest("b"),
      reviewedBy: { client: "web" },
    })

    reviews.revoke("skill-111111111111")

    expect(reviews.find("skill-111111111111", digest("a"))).toBeUndefined()
    expect(reviews.find("skill-111111111111", digest("b"))).toBeUndefined()
  })

  it("re-recording the same digest replaces the earlier attribution", () => {
    const reviews = new SqliteSkillReviews(new DatabaseSync(":memory:"))
    reviews.record({
      skillId: "skill-111111111111",
      contentDigest: digest("a"),
      reviewedBy: { client: "web" },
    })
    reviews.record({
      skillId: "skill-111111111111",
      contentDigest: digest("a"),
      reviewedBy: { client: "cli", clientId: "cli-1" },
    })

    expect(reviews.list()).toHaveLength(1)
    expect(reviews.find("skill-111111111111", digest("a"))).toMatchObject({
      reviewedBy: { client: "cli", clientId: "cli-1" },
    })
  })

  it("bounds retained reviews to the most recent entries", () => {
    const reviews = new SqliteSkillReviews(new DatabaseSync(":memory:"))
    for (let index = 0; index <= maximumSkillManualReviews; index += 1) {
      reviews.record({
        skillId: `skill-${index.toString(16).padStart(12, "0")}`,
        contentDigest: digest("a"),
        reviewedBy: { client: "web" },
      })
    }

    expect(reviews.list()).toHaveLength(maximumSkillManualReviews)
    expect(reviews.find("skill-000000000000", digest("a"))).toBeUndefined()
  })
})
