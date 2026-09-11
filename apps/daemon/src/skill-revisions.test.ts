import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { maximumSkillRevisionBytes } from "@getdomovoi/protocol"
import { SqliteSkillReviews } from "./skill-reviews.js"
import { skillContentDigest } from "./skill-signing.js"

const id = "skill-111111111111"
const databases = new Set<DatabaseSync>()
const directories: string[] = []
afterEach(async () => {
  for (const database of databases) database.close()
  databases.clear()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
const databaseAt = (path = ":memory:") => {
  const database = new DatabaseSync(path)
  databases.add(database)
  return database
}

describe("retained skill revisions", () => {
  it("preserves exact reviewed UTF-8 text through database reopen without granting trust", async () => {
    const directory = await mkdtemp(join(tmpdir(), "domovoi-skill-revision-"))
    directories.push(directory)
    const path = join(directory, "state.sqlite")
    const database = databaseAt(path)
    const reviews = new SqliteSkillReviews(database)
    const content = "---\r\nname: reviewed\r\n---\r\n\tKeep whitespace 🙂\n"
    const digest = skillContentDigest(content)
    reviews.revisions.retain(digest, content)
    expect(reviews.find(id, digest)).toBeUndefined()
    database.close()
    databases.delete(database)
    const reopened = new SqliteSkillReviews(databaseAt(path))
    expect(reopened.revisions.read(id, digest)).toEqual({ id, contentDigest: digest, state: "available", content, bytes: Buffer.byteLength(content) })
  })

  it("deduplicates identical text by digest", () => {
    const database = databaseAt()
    const revisions = new SqliteSkillReviews(database).revisions
    const content = "same reviewed bytes"
    const digest = skillContentDigest(content)
    revisions.retain(digest, content)
    revisions.retain(digest, content)
    expect(database.prepare("SELECT count(*) AS count FROM skill_review_revisions").get()).toEqual({ count: 1 })
    expect(revisions.read(id, digest)).toMatchObject({ state: "available", content })
  })

  it("keeps missing evidence unavailable instead of substituting empty text", () => {
    const revisions = new SqliteSkillReviews(databaseAt()).revisions
    const digest = skillContentDigest("never recorded")
    expect(revisions.read(id, digest)).toEqual({ id, contentDigest: digest, state: "unavailable", reason: "not-retained" })
  })

  it("rejects mismatched digests and oversized documents without changing retention", () => {
    const revisions = new SqliteSkillReviews(databaseAt()).revisions
    const content = "original"
    const digest = skillContentDigest(content)
    revisions.retain(digest, content)
    expect(() => revisions.retain(digest, "different")).toThrow("digest")
    const oversized = "x".repeat(maximumSkillRevisionBytes + 1)
    expect(() => revisions.retain(skillContentDigest(oversized), oversized)).toThrow("limit")
    expect(revisions.read(id, digest)).toMatchObject({ state: "available", content })
  })

  it.each(["content", "bytes"] as const)("reports damaged %s as unavailable", (column) => {
    const database = databaseAt()
    const revisions = new SqliteSkillReviews(database).revisions
    const digest = skillContentDigest("reviewed")
    revisions.retain(digest, "reviewed")
    // Equal UTF-8 lengths isolate digest validation from the byte-count check.
    if (column === "content") database.prepare("UPDATE skill_review_revisions SET content = ?").run("tampered")
    else database.prepare("UPDATE skill_review_revisions SET bytes = ?").run(1)
    expect(revisions.read(id, digest)).toEqual({ id, contentDigest: digest, state: "unavailable", reason: "integrity-mismatch" })
  })

  it("evicts oldest retained text by byte budget, and a renewed review refreshes retention", () => {
    const revisions = new SqliteSkillReviews(databaseAt(), { maximumBytes: 12 }).revisions
    for (const content of ["aaaa", "bbbb", "aaaa", "cccccccc"]) revisions.retain(skillContentDigest(content), content)
    expect(revisions.read(id, skillContentDigest("aaaa"))).toMatchObject({ state: "available" })
    expect(revisions.read(id, skillContentDigest("bbbb"))).toMatchObject({ state: "unavailable", reason: "not-retained" })
    expect(revisions.read(id, skillContentDigest("cccccccc"))).toMatchObject({ state: "available" })
  })

  it("bounds revision count separately and reads do not extend retention", () => {
    const revisions = new SqliteSkillReviews(databaseAt(), { maximumRevisions: 2 }).revisions
    for (const content of ["a", "b"]) revisions.retain(skillContentDigest(content), content)
    revisions.read(id, skillContentDigest("a"))
    revisions.retain(skillContentDigest("c"), "c")
    expect(revisions.read(id, skillContentDigest("a"))).toMatchObject({ state: "unavailable" })
    expect(revisions.read(id, skillContentDigest("b"))).toMatchObject({ state: "available" })
  })

  it("rolls back insertion when eviction fails, preserving previously retained evidence", () => {
    const database = databaseAt()
    const revisions = new SqliteSkillReviews(database, { maximumRevisions: 1 }).revisions
    revisions.retain(skillContentDigest("a"), "a")
    database.exec("CREATE TRIGGER refuse_revision_delete BEFORE DELETE ON skill_review_revisions BEGIN SELECT RAISE(ABORT, 'disk failure'); END")
    expect(() => revisions.retain(skillContentDigest("b"), "b")).toThrow("disk failure")
    expect(revisions.read(id, skillContentDigest("a"))).toMatchObject({ state: "available", content: "a" })
    expect(revisions.read(id, skillContentDigest("b"))).toMatchObject({ state: "unavailable" })
    database.exec("DROP TRIGGER refuse_revision_delete")
    revisions.retain(skillContentDigest("b"), "b")
    expect(revisions.read(id, skillContentDigest("b"))).toMatchObject({ state: "available", content: "b" })
  })
})
