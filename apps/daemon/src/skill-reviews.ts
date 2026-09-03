import type { DatabaseSync } from "node:sqlite"

import { skillManualReviewSchema, type SkillManualReview } from "@getdomovoi/protocol"

export const maximumSkillManualReviews = 512

export type SkillManualReviewInput = {
  skillId: string
  contentDigest: string
  reviewedBy: SkillManualReview["reviewedBy"]
}

export interface SkillReviews {
  find(skillId: string, contentDigest: string): SkillManualReview | undefined
  record(input: SkillManualReviewInput): SkillManualReview
  revoke(skillId: string): void
  list(): SkillManualReview[]
}

type StoredSkillReview = {
  skill_id: string
  content_digest: string
  reviewed_at: string
  reviewed_client: string
  reviewed_client_id: string | null
}

function toManualReview(row: StoredSkillReview): SkillManualReview {
  return skillManualReviewSchema.parse({
    skillId: row.skill_id,
    contentDigest: row.content_digest,
    reviewedAt: row.reviewed_at,
    reviewedBy: {
      client: row.reviewed_client,
      ...(row.reviewed_client_id === null ? {} : { clientId: row.reviewed_client_id }),
    },
  })
}

export class SqliteSkillReviews implements SkillReviews {
  #database: DatabaseSync

  constructor(database: DatabaseSync) {
    this.#database = database
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS skill_manual_reviews (
        skill_id TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        reviewed_at TEXT NOT NULL,
        reviewed_client TEXT NOT NULL,
        reviewed_client_id TEXT,
        PRIMARY KEY (skill_id, content_digest)
      );
      CREATE INDEX IF NOT EXISTS skill_manual_reviews_reviewed_at
        ON skill_manual_reviews (reviewed_at);
    `)
  }

  find(skillId: string, contentDigest: string): SkillManualReview | undefined {
    const row = this.#database
      .prepare("SELECT * FROM skill_manual_reviews WHERE skill_id = ? AND content_digest = ?")
      .get(skillId, contentDigest) as StoredSkillReview | undefined
    if (!row) return undefined
    try {
      return toManualReview(row)
    } catch {
      return undefined
    }
  }

  record(input: SkillManualReviewInput): SkillManualReview {
    const review = skillManualReviewSchema.parse({
      skillId: input.skillId,
      contentDigest: input.contentDigest,
      reviewedAt: new Date().toISOString(),
      reviewedBy: input.reviewedBy,
    })
    this.#database
      .prepare(`
        INSERT INTO skill_manual_reviews (
          skill_id, content_digest, reviewed_at, reviewed_client, reviewed_client_id
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(skill_id, content_digest) DO UPDATE SET
          reviewed_at = excluded.reviewed_at,
          reviewed_client = excluded.reviewed_client,
          reviewed_client_id = excluded.reviewed_client_id
      `)
      .run(
        review.skillId,
        review.contentDigest,
        review.reviewedAt,
        review.reviewedBy.client,
        review.reviewedBy.clientId ?? null,
      )
    this.#trim()
    return review
  }

  revoke(skillId: string): void {
    this.#database.prepare("DELETE FROM skill_manual_reviews WHERE skill_id = ?").run(skillId)
  }

  list(): SkillManualReview[] {
    const rows = this.#database
      .prepare("SELECT * FROM skill_manual_reviews ORDER BY reviewed_at DESC, skill_id ASC")
      .all() as StoredSkillReview[]
    const reviews: SkillManualReview[] = []
    for (const row of rows) {
      try {
        reviews.push(toManualReview(row))
      } catch {
        continue
      }
    }
    return reviews
  }

  #trim(): void {
    this.#database
      .prepare(`
        DELETE FROM skill_manual_reviews
        WHERE rowid NOT IN (
          SELECT rowid FROM skill_manual_reviews
          ORDER BY reviewed_at DESC, rowid DESC
          LIMIT ?
        )
      `)
      .run(maximumSkillManualReviews)
  }
}
