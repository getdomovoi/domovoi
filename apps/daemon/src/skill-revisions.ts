import type { DatabaseSync } from "node:sqlite"
import { maximumSkillRevisionBytes, skillContentDigestSchema, type SkillReviewRevisionResult } from "@getdomovoi/protocol"
import { skillContentDigest } from "./skill-signing.js"

export const maximumRetainedSkillRevisionBytes = 64 * 1_024 * 1_024
export const maximumRetainedSkillRevisions = 4_096

export interface SkillRevisions {
  retain(contentDigest: string, content: string): void
  read(id: string, contentDigest: string): SkillReviewRevisionResult
}

export type SkillRevisionLimits = { maximumBytes?: number; maximumRevisions?: number }

export class SqliteSkillRevisions implements SkillRevisions {
  readonly #database: DatabaseSync
  readonly #maximumBytes: number
  readonly #maximumRevisions: number

  constructor(database: DatabaseSync, limits: SkillRevisionLimits = {}) {
    this.#database = database
    this.#maximumBytes = limits.maximumBytes ?? maximumRetainedSkillRevisionBytes
    this.#maximumRevisions = limits.maximumRevisions ?? maximumRetainedSkillRevisions
    if (!Number.isSafeInteger(this.#maximumBytes) || this.#maximumBytes < 1 || this.#maximumBytes > maximumRetainedSkillRevisionBytes
      || !Number.isSafeInteger(this.#maximumRevisions) || this.#maximumRevisions < 1 || this.#maximumRevisions > maximumRetainedSkillRevisions) {
      throw new Error("Invalid skill revision retention limit")
    }
    database.exec(`CREATE TABLE IF NOT EXISTS skill_review_revisions (
      content_digest TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      bytes INTEGER NOT NULL CHECK (bytes >= 0),
      retained_order INTEGER NOT NULL
    )`)
  }

  retain(contentDigest: string, content: string): void {
    skillContentDigestSchema.parse(contentDigest)
    const bytes = Buffer.byteLength(content, "utf8")
    if (bytes > maximumSkillRevisionBytes || bytes > this.#maximumBytes) throw new Error("Reviewed skill text exceeds retention limit")
    if (skillContentDigest(content) !== contentDigest) throw new Error("Reviewed skill text does not match its digest")
    this.#database.exec("SAVEPOINT skill_revision_retention")
    try {
      this.#database.prepare(`
        INSERT INTO skill_review_revisions (content_digest, content, bytes, retained_order)
        VALUES (?, ?, ?, (SELECT COALESCE(MAX(retained_order), 0) + 1 FROM skill_review_revisions))
        ON CONFLICT(content_digest) DO UPDATE SET
          content = excluded.content, bytes = excluded.bytes, retained_order = excluded.retained_order
      `).run(contentDigest, content, bytes)
      this.#database.prepare(`
        DELETE FROM skill_review_revisions WHERE content_digest IN (
          SELECT content_digest FROM (
            SELECT content_digest,
              ROW_NUMBER() OVER (ORDER BY retained_order DESC, rowid DESC) AS position,
              SUM(length(CAST(content AS BLOB))) OVER (ORDER BY retained_order DESC, rowid DESC) AS retained_bytes
            FROM skill_review_revisions
          ) WHERE position > ? OR retained_bytes > ?
        )
      `).run(this.#maximumRevisions, this.#maximumBytes)
      this.#database.exec("RELEASE skill_revision_retention")
    } catch (error) {
      let rollbackFailure: { error: unknown } | undefined
      try {
        this.#database.exec("ROLLBACK TO skill_revision_retention; RELEASE skill_revision_retention")
      } catch (rollbackError) {
        rollbackFailure = { error: rollbackError }
      }
      if (rollbackFailure) {
        throw new AggregateError([error, rollbackFailure.error], "Could not retain a skill revision or restore its transaction", { cause: error })
      }
      throw error
    }
  }

  read(id: string, contentDigest: string): SkillReviewRevisionResult {
    skillContentDigestSchema.parse(contentDigest)
    const row = this.#database.prepare("SELECT content, bytes FROM skill_review_revisions WHERE content_digest = ?")
      .get(contentDigest)
    if (!row) return { id, contentDigest, state: "unavailable", reason: "not-retained" }
    if (typeof row.content !== "string" || typeof row.bytes !== "number"
      || row.bytes > maximumSkillRevisionBytes || row.bytes !== Buffer.byteLength(row.content, "utf8")
      || skillContentDigest(row.content) !== contentDigest) {
      return { id, contentDigest, state: "unavailable", reason: "integrity-mismatch" }
    }
    return { id, contentDigest, state: "available", content: row.content, bytes: row.bytes }
  }
}
