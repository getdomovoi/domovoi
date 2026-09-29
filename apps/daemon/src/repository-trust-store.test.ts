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
