import { DatabaseSync } from "node:sqlite"

import { describe, expect, it } from "vitest"

import { SqliteRepositoryTrust, maximumRepositoryTrustRecords } from "./repository-trust-store.js"

const digest = (character: string) => `sha256:${character.repeat(64)}`

describe("SqliteRepositoryTrust", () => {
  it("records one grant per repository, pinned to the digest reviewed", () => {
    const trust = new SqliteRepositoryTrust(new DatabaseSync(":memory:"))
    const recorded = trust.record({ projectId: "project-acme", trustedDigest: digest("a"), trustedBy: { client: "desktop", clientId: "device-1" } })

    expect(recorded).toMatchObject({ projectId: "project-acme", trustedDigest: digest("a"), trustedBy: { client: "desktop", clientId: "device-1" } })
    expect(recorded.trustedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(trust.find("project-acme")).toEqual(recorded)
    expect(trust.find("project-other")).toBeUndefined()
  })

  it("replaces a repository's earlier grant rather than keeping both", () => {
    const trust = new SqliteRepositoryTrust(new DatabaseSync(":memory:"))
    trust.record({ projectId: "project-acme", trustedDigest: digest("a"), trustedBy: { client: "desktop", clientId: "device-1" } })
    const later = trust.record({ projectId: "project-acme", trustedDigest: digest("b"), trustedBy: { client: "web" } })

    expect(trust.find("project-acme")).toEqual(later)
    expect(trust.find("project-acme")?.trustedBy).toEqual({ client: "web" })
  })

  it("revokes a repository's grant and leaves others", () => {
    const trust = new SqliteRepositoryTrust(new DatabaseSync(":memory:"))
    trust.record({ projectId: "project-acme", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })
    trust.record({ projectId: "project-beta", trustedDigest: digest("a"), trustedBy: { client: "web" } })

    trust.revoke("project-acme")
    trust.revoke("project-missing")

    expect(trust.find("project-acme")).toBeUndefined()
    expect(trust.find("project-beta")).toBeDefined()
  })

  it("survives reopening the same database", () => {
    const database = new DatabaseSync(":memory:")
    const recorded = new SqliteRepositoryTrust(database).record({ projectId: "project-acme", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })
    expect(new SqliteRepositoryTrust(database).find("project-acme")).toEqual(recorded)
  })

  it("reads a row the protocol refuses as no grant", () => {
    const database = new DatabaseSync(":memory:")
    const trust = new SqliteRepositoryTrust(database)
    const insert = database.prepare(`
      INSERT INTO repository_trust (project_id, trusted_digest, trusted_at, trusted_client, trusted_client_id)
      VALUES (?, ?, ?, ?, ?)
    `)
    insert.run("project-digest", "sha256:short", "2026-09-28T10:00:00.000Z", "desktop", null)
    insert.run("project-client", digest("a"), "2026-09-28T10:00:00.000Z", "phone", null)
    insert.run("project-time", digest("a"), "yesterday", "web", null)

    for (const projectId of ["project-digest", "project-client", "project-time"]) {
      expect(trust.find(projectId), projectId).toBeUndefined()
    }
  })

  it("refuses to record a grant the protocol refuses", () => {
    const trust = new SqliteRepositoryTrust(new DatabaseSync(":memory:"))
    expect(() => trust.record({ projectId: "project-acme", trustedDigest: "sha256:short", trustedBy: { client: "desktop" } })).toThrow()
    expect(() => trust.record({ projectId: "", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })).toThrow()
    expect(trust.find("project-acme")).toBeUndefined()
  })

  it("records a grant and trims to the cap together, or not at all", () => {
    const database = new DatabaseSync(":memory:")
    const trust = new SqliteRepositoryTrust(database)
    for (let index = 0; index < maximumRepositoryTrustRecords; index += 1) {
      trust.record({ projectId: `project-${index}`, trustedDigest: digest("a"), trustedBy: { client: "desktop" } })
    }
    // Added after the store checked its table, so only the trim fails.
    database.exec("CREATE TRIGGER refuse_trim BEFORE DELETE ON repository_trust BEGIN SELECT RAISE(ABORT, 'trim refused'); END")

    expect(() => trust.record({ projectId: "project-new", trustedDigest: digest("b"), trustedBy: { client: "web" } })).toThrow()
    expect(trust.find("project-new")).toBeUndefined()
    expect(trust.find("project-0")).toMatchObject({ trustedDigest: digest("a") })
    expect(database.prepare("SELECT COUNT(*) AS count FROM repository_trust").get()).toEqual({ count: maximumRepositoryTrustRecords })
  })

  it("rolls back only its own work inside a caller's transaction", () => {
    const database = new DatabaseSync(":memory:")
    const trust = new SqliteRepositoryTrust(database)
    database.exec("CREATE TABLE outer_work (value TEXT)")
    database.exec("BEGIN")
    database.exec("INSERT INTO outer_work VALUES ('kept')")
    database.exec("CREATE TRIGGER refuse_insert BEFORE INSERT ON repository_trust BEGIN SELECT RAISE(ABORT, 'insert refused'); END")
    expect(() => trust.record({ projectId: "project-acme", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })).toThrow()
    // COMMIT throws if the store ended the caller's transaction.
    database.exec("COMMIT")
    expect(database.prepare("SELECT value FROM outer_work").all()).toEqual([{ value: "kept" }])
  })

  it("refuses a grant a statement reported written but did not store", () => {
    const database = new DatabaseSync(":memory:")
    const trust = new SqliteRepositoryTrust(database)
    database.exec("CREATE TRIGGER drop_grant BEFORE INSERT ON repository_trust BEGIN SELECT RAISE(IGNORE); END")

    expect(() => trust.record({ projectId: "project-acme", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })).toThrow()
    expect(trust.find("project-acme")).toBeUndefined()
  })

  it("fails the revocation when the grant is still there after the delete", () => {
    const database = new DatabaseSync(":memory:")
    const trust = new SqliteRepositoryTrust(database)
    trust.record({ projectId: "project-acme", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })
    database.exec("CREATE TRIGGER keep_grant BEFORE DELETE ON repository_trust BEGIN SELECT RAISE(IGNORE); END")

    expect(() => trust.revoke("project-acme")).toThrow()
    // Revoking what is not there still succeeds.
    expect(() => trust.revoke("project-missing")).not.toThrow()
  })

  it.each([
    ["a table without rowids", "CREATE TABLE repository_trust (project_id TEXT PRIMARY KEY, trusted_digest TEXT NOT NULL, trusted_at TEXT NOT NULL, trusted_client TEXT NOT NULL, trusted_client_id TEXT) WITHOUT ROWID"],
    ["a table keyed otherwise", "CREATE TABLE repository_trust (project_id TEXT, trusted_digest TEXT NOT NULL, trusted_at TEXT NOT NULL, trusted_client TEXT NOT NULL, trusted_client_id TEXT)"],
    ["a table with other columns", "CREATE TABLE repository_trust (project_id TEXT PRIMARY KEY, trusted_digest TEXT NOT NULL, trusted_at TEXT NOT NULL, trusted_client TEXT NOT NULL)"],
  ])("yields no grant from %s", (_, table) => {
    const database = new DatabaseSync(":memory:")
    database.exec(table)
    const columns = table.includes("trusted_client_id") ? "project_id, trusted_digest, trusted_at, trusted_client, trusted_client_id" : "project_id, trusted_digest, trusted_at, trusted_client"
    const values = table.includes("trusted_client_id") ? "'project-acme', ?, '2026-09-28T10:00:00.000Z', 'desktop', NULL" : "'project-acme', ?, '2026-09-28T10:00:00.000Z', 'desktop'"
    database.prepare(`INSERT INTO repository_trust (${columns}) VALUES (${values})`).run(digest("a"))
    const trust = new SqliteRepositoryTrust(database)

    expect(trust.find("project-acme")).toBeUndefined()
    expect(() => trust.record({ projectId: "project-beta", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })).toThrow()
  })

  it("yields no grant when a trigger it did not create is on its table", () => {
    const database = new DatabaseSync(":memory:")
    new SqliteRepositoryTrust(database).record({ projectId: "project-acme", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })
    database.exec("CREATE TRIGGER rewrite_grant AFTER INSERT ON repository_trust BEGIN SELECT 1; END")
    const trust = new SqliteRepositoryTrust(database)

    expect(trust.find("project-acme")).toBeUndefined()
    expect(() => trust.record({ projectId: "project-beta", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })).toThrow()
  })

  it("keeps at most the most recent grants", () => {
    const trust = new SqliteRepositoryTrust(new DatabaseSync(":memory:"))
    for (let index = 0; index <= maximumRepositoryTrustRecords; index += 1) {
      trust.record({ projectId: `project-${index}`, trustedDigest: digest("a"), trustedBy: { client: "desktop" } })
    }

    expect(trust.find("project-0")).toBeUndefined()
    expect(trust.find(`project-${maximumRepositoryTrustRecords}`)).toBeDefined()
    expect(trust.find("project-1")).toBeDefined()
  })
})
