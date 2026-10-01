import { constants, DatabaseSync } from "node:sqlite"

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

  // A grant lets the daemon run the repository's git filters only when the
  // client acknowledged showing them (repository.trust gitFilters), and only
  // for the block it showed: the grant keeps that block's review digest
  // (ruling Q265).
  it("records the review digest of the git filter block the grant reviewed", () => {
    const trust = new SqliteRepositoryTrust(new DatabaseSync(":memory:"))
    const reviewed = trust.record({ projectId: "project-acme", trustedDigest: digest("a"), trustedBy: { client: "desktop" }, gitFilterReviewDigest: digest("c") })
    const unreviewed = trust.record({ projectId: "project-beta", trustedDigest: digest("a"), trustedBy: { client: "web" } })

    expect(reviewed.gitFilterReviewDigest).toBe(digest("c"))
    expect(trust.find("project-acme")).toEqual(reviewed)
    expect(trust.find("project-beta")).toEqual(unreviewed)
    expect(trust.find("project-beta")).not.toHaveProperty("gitFilterReviewDigest")
    expect(() => trust.record({ projectId: "project-gamma", trustedDigest: digest("a"), trustedBy: { client: "desktop" }, gitFilterReviewDigest: "sha256:short" })).toThrow()
  })

  // A table an earlier build of this store made, with the acknowledgement but
  // no review digest: it gains the column, NULL for its grants, and none of
  // them runs a git filter until the repository is trusted again.
  it("keeps the grants of a table without review digests, none of them running git filters", () => {
    const database = new DatabaseSync(":memory:")
    database.exec(`
      CREATE TABLE repository_trust (
        project_id TEXT PRIMARY KEY,
        trusted_digest TEXT NOT NULL,
        trusted_at TEXT NOT NULL,
        trusted_client TEXT NOT NULL,
        trusted_client_id TEXT,
        git_filters_reviewed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX repository_trust_trusted_at ON repository_trust (trusted_at);
    `)
    database.prepare("INSERT INTO repository_trust VALUES (?, ?, ?, ?, ?, ?)").run("project-acme", digest("a"), "2026-09-30T12:00:00.000Z", "desktop", null, 1)

    const trust = new SqliteRepositoryTrust(database)

    expect(trust.find("project-acme")).toEqual({ projectId: "project-acme", trustedDigest: digest("a"), trustedAt: "2026-09-30T12:00:00.000Z", trustedBy: { client: "desktop" } })
    expect(trust.record({ projectId: "project-acme", trustedDigest: digest("b"), trustedBy: { client: "desktop" }, gitFilterReviewDigest: digest("c") }).gitFilterReviewDigest).toBe(digest("c"))
    expect(trust.find("project-acme")?.gitFilterReviewDigest).toBe(digest("c"))
  })

  // Every column is compared in full before grants are read, the new one too:
  // a default would hand every row written without it a review digest.
  it.each([
    ["TEXT DEFAULT 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'"],
    ["BLOB"],
    ["TEXT NOT NULL DEFAULT ''"],
  ])("yields no grant from a table whose review digest column is %s", (declaration) => {
    const database = new DatabaseSync(":memory:")
    database.exec(`
      CREATE TABLE repository_trust (
        project_id TEXT PRIMARY KEY,
        trusted_digest TEXT NOT NULL,
        trusted_at TEXT NOT NULL,
        trusted_client TEXT NOT NULL,
        trusted_client_id TEXT,
        git_filters_reviewed INTEGER NOT NULL DEFAULT 0,
        git_filter_review_digest ${declaration}
      );
      CREATE INDEX repository_trust_trusted_at ON repository_trust (trusted_at);
    `)
    database.prepare("INSERT INTO repository_trust (project_id, trusted_digest, trusted_at, trusted_client, trusted_client_id, git_filters_reviewed) VALUES (?, ?, ?, ?, ?, 1)")
      .run("project-acme", digest("a"), "2026-09-30T12:00:00.000Z", "desktop", null)
    const trust = new SqliteRepositoryTrust(database)

    expect(trust.find("project-acme")).toBeUndefined()
    expect(() => trust.record({ projectId: "project-beta", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })).toThrow()
  })

  // A table an earlier daemon made, with no column for the acknowledgement:
  // its grants carry on for everything they covered, and none of them runs a
  // git filter.
  it("keeps the grants of an earlier table, none of them reviewing git filters", () => {
    const database = new DatabaseSync(":memory:")
    database.exec(`
      CREATE TABLE repository_trust (
        project_id TEXT PRIMARY KEY,
        trusted_digest TEXT NOT NULL,
        trusted_at TEXT NOT NULL,
        trusted_client TEXT NOT NULL,
        trusted_client_id TEXT
      );
      CREATE INDEX repository_trust_trusted_at ON repository_trust (trusted_at);
    `)
    database.prepare("INSERT INTO repository_trust VALUES (?, ?, ?, ?, ?)").run("project-acme", digest("a"), "2026-09-30T12:00:00.000Z", "desktop", null)

    const trust = new SqliteRepositoryTrust(database)

    expect(trust.find("project-acme")).toEqual({ projectId: "project-acme", trustedDigest: digest("a"), trustedAt: "2026-09-30T12:00:00.000Z", trustedBy: { client: "desktop" } })
    expect(trust.record({ projectId: "project-acme", trustedDigest: digest("b"), trustedBy: { client: "desktop" }, gitFilterReviewDigest: digest("c") }).gitFilterReviewDigest).toBe(digest("c"))
    expect(trust.find("project-acme")?.gitFilterReviewDigest).toBe(digest("c"))
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
    // table_info does not list a generated column; this one shadows the rowid the trim reads.
    ["a table with a generated rowid column", "CREATE TABLE repository_trust (project_id TEXT PRIMARY KEY, trusted_digest TEXT NOT NULL, trusted_at TEXT NOT NULL, trusted_client TEXT NOT NULL, trusted_client_id TEXT, rowid TEXT GENERATED ALWAYS AS ('same') VIRTUAL)"],
    ["a table whose key ignores case", "CREATE TABLE repository_trust (project_id TEXT PRIMARY KEY COLLATE NOCASE, trusted_digest TEXT NOT NULL, trusted_at TEXT NOT NULL, trusted_client TEXT NOT NULL, trusted_client_id TEXT)"],
    ["a table with a key index that ignores case", "CREATE TABLE repository_trust (project_id TEXT PRIMARY KEY, trusted_digest TEXT NOT NULL, trusted_at TEXT NOT NULL, trusted_client TEXT NOT NULL, trusted_client_id TEXT); CREATE UNIQUE INDEX repository_trust_folded ON repository_trust (project_id COLLATE NOCASE)"],
    ["a table named in another case","CREATE TABLE Repository_Trust (project_id TEXT PRIMARY KEY, trusted_digest TEXT NOT NULL, trusted_at TEXT NOT NULL, trusted_client TEXT NOT NULL, trusted_client_id TEXT)"],
    // An earlier table is migrated only when every column is declared as an
    // earlier daemon declared it: type, NOT NULL and default.
    ["an earlier table with a column of another type", "CREATE TABLE repository_trust (project_id TEXT PRIMARY KEY, trusted_digest BLOB NOT NULL, trusted_at TEXT NOT NULL, trusted_client TEXT NOT NULL, trusted_client_id TEXT)"],
    ["an earlier table with a column that allows null", "CREATE TABLE repository_trust (project_id TEXT PRIMARY KEY, trusted_digest TEXT NOT NULL, trusted_at TEXT, trusted_client TEXT NOT NULL, trusted_client_id TEXT)"],
    ["an earlier table with a column default", "CREATE TABLE repository_trust (project_id TEXT PRIMARY KEY, trusted_digest TEXT NOT NULL, trusted_at TEXT NOT NULL, trusted_client TEXT NOT NULL DEFAULT 'desktop', trusted_client_id TEXT)"],
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

  // A table with every expected name and index, whose acknowledgement column
  // defaults to 1, would make an earlier daemon's row read as a grant that
  // reviewed the git filters (ruling Q255). The declared column contract is
  // compared in full, so such a table yields no grant.
  it.each([
    ["INTEGER NOT NULL DEFAULT 1"],
    ["BLOB NOT NULL DEFAULT 1"],
    ["INTEGER DEFAULT 1"],
  ])("yields no grant from a table whose acknowledgement column is %s", (declaration) => {
    const database = new DatabaseSync(":memory:")
    database.exec(`
      CREATE TABLE repository_trust (
        project_id TEXT PRIMARY KEY,
        trusted_digest TEXT NOT NULL,
        trusted_at TEXT NOT NULL,
        trusted_client TEXT NOT NULL,
        trusted_client_id TEXT,
        git_filters_reviewed ${declaration}
      );
      CREATE INDEX repository_trust_trusted_at ON repository_trust (trusted_at);
    `)
    database.prepare("INSERT INTO repository_trust (project_id, trusted_digest, trusted_at, trusted_client, trusted_client_id) VALUES (?, ?, ?, ?, ?)")
      .run("project-acme", digest("a"), "2026-09-30T12:00:00.000Z", "desktop", null)
    const trust = new SqliteRepositoryTrust(database)

    expect(trust.find("project-acme")).toBeUndefined()
    expect(() => trust.record({ projectId: "project-beta", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })).toThrow()
  })

  // A foreign key with ON UPDATE CASCADE lets a change to another table's
  // row rewrite a stored grant: here the parent key moves from 0 to 1 and an
  // unreviewed grant would read as one that reviewed the git filters (ruling
  // Q265). Any foreign key refuses the table, earlier or current.
  it("yields no grant from a table with a foreign key, even after its parent changes", () => {
    const database = new DatabaseSync(":memory:")
    database.exec(`
      CREATE TABLE flags (value INTEGER PRIMARY KEY);
      INSERT INTO flags VALUES (0);
      CREATE TABLE repository_trust (
        project_id TEXT PRIMARY KEY,
        trusted_digest TEXT NOT NULL,
        trusted_at TEXT NOT NULL,
        trusted_client TEXT NOT NULL,
        trusted_client_id TEXT,
        git_filters_reviewed INTEGER NOT NULL DEFAULT 0 REFERENCES flags(value) ON UPDATE CASCADE
      );
      CREATE INDEX repository_trust_trusted_at ON repository_trust (trusted_at);
    `)
    database.prepare("INSERT INTO repository_trust (project_id, trusted_digest, trusted_at, trusted_client, trusted_client_id) VALUES (?, ?, ?, ?, ?)")
      .run("project-acme", digest("a"), "2026-09-30T12:00:00.000Z", "desktop", null)
    const trust = new SqliteRepositoryTrust(database)
    database.exec("UPDATE flags SET value = 1 WHERE value = 0")

    expect(trust.find("project-acme")).toBeUndefined()
    expect(() => trust.record({ projectId: "project-beta", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })).toThrow()
  })

  it("does not migrate an earlier table with a foreign key", () => {
    const database = new DatabaseSync(":memory:")
    database.exec(`
      CREATE TABLE digests (value TEXT PRIMARY KEY);
      CREATE TABLE repository_trust (
        project_id TEXT PRIMARY KEY,
        trusted_digest TEXT NOT NULL REFERENCES digests(value) ON UPDATE CASCADE,
        trusted_at TEXT NOT NULL,
        trusted_client TEXT NOT NULL,
        trusted_client_id TEXT
      );
      CREATE INDEX repository_trust_trusted_at ON repository_trust (trusted_at);
    `)
    const trust = new SqliteRepositoryTrust(database)

    expect(database.prepare("PRAGMA main.table_xinfo(repository_trust)").all()).toHaveLength(5)
    expect(() => trust.record({ projectId: "project-beta", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })).toThrow()
  })

  // A trigger on any other table that writes this one could change a grant
  // behind the store, so a trigger anywhere whose text names the table refuses
  // it. With no foreign key on the table, no cascade reaches it.
  it.each([
    ["a trigger", "CREATE TRIGGER mint AFTER INSERT ON other BEGIN UPDATE repository_trust SET git_filters_reviewed = 1; END"],
    ["a temporary trigger", "CREATE TEMP TRIGGER mint AFTER INSERT ON other BEGIN UPDATE \"Repository_Trust\" SET git_filters_reviewed = 1; END"],
  ])("yields no grant when %s on another table writes its table", (_, trigger) => {
    const database = new DatabaseSync(":memory:")
    new SqliteRepositoryTrust(database).record({ projectId: "project-acme", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })
    database.exec("CREATE TABLE other (value INTEGER)")
    database.exec(trigger)
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

  it.each([
    ["a trigger", "CREATE TRIGGER mint_grant AFTER INSERT ON Repository_Trust BEGIN SELECT 1; END"],
    ["a temporary trigger", "CREATE TEMP TRIGGER mint_grant AFTER INSERT ON Repository_Trust BEGIN SELECT 1; END"],
  ])("yields no grant when %s is on its table named in another case", (_, trigger) => {
    const database = new DatabaseSync(":memory:")
    database.exec("CREATE TABLE Repository_Trust (project_id TEXT PRIMARY KEY, trusted_digest TEXT NOT NULL, trusted_at TEXT NOT NULL, trusted_client TEXT NOT NULL, trusted_client_id TEXT)")
    database.prepare("INSERT INTO repository_trust VALUES ('project-acme', ?, '2026-09-28T10:00:00.000Z', 'desktop', NULL)").run(digest("a"))
    database.exec(trigger)
    const trust = new SqliteRepositoryTrust(database)

    expect(trust.find("project-acme")).toBeUndefined()
    expect(() => trust.record({ projectId: "project-beta", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })).toThrow()
  })

  it.each([
    ["a trigger", "CREATE TRIGGER mint_grant AFTER INSERT ON REPOSITORY_TRUST BEGIN SELECT 1; END"],
    ["a temporary trigger", "CREATE TEMP TRIGGER mint_grant AFTER INSERT ON REPOSITORY_TRUST BEGIN SELECT 1; END"],
  ])("yields no grant when %s names its table in another case", (_, trigger) => {
    const database = new DatabaseSync(":memory:")
    new SqliteRepositoryTrust(database).record({ projectId: "project-acme", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })
    database.exec(trigger)
    const trust = new SqliteRepositoryTrust(database)

    expect(trust.find("project-acme")).toBeUndefined()
    expect(() => trust.record({ projectId: "project-beta", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })).toThrow()
  })

  it("reads its table's index keys from main, not from a temporary index of the same name", () => {
    const database = new DatabaseSync(":memory:")
    new SqliteRepositoryTrust(database).record({ projectId: "project-acme", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })
    // The main index ignores case; an unrelated temporary index shares its name
    // and compares as bytes.
    database.exec(`
      CREATE INDEX folded ON repository_trust (project_id COLLATE NOCASE);
      CREATE TEMP TABLE unrelated (value TEXT);
      CREATE INDEX temp.folded ON unrelated (value);
    `)
    const trust = new SqliteRepositoryTrust(database)

    expect(trust.find("project-acme")).toBeUndefined()
    expect(() => trust.record({ projectId: "project-beta", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })).toThrow()
  })

  describe.each(["fts3", "fts4"])("with a %s table named pragma_index_xinfo", (module) => {
    it.each([
      ["a temporary", "CREATE VIRTUAL TABLE temp.pragma_index_xinfo USING MODULE(coll, key)"],
      ["an attached", "ATTACH DATABASE ':memory:' AS other; CREATE VIRTUAL TABLE other.pragma_index_xinfo USING MODULE(coll, key)"],
      // Even the qualified name finds this one, so its empty answer must not
      // read as an index whose keys all compare as bytes.
      ["a main", "CREATE VIRTUAL TABLE main.pragma_index_xinfo USING MODULE(coll, key)"],
    ])("in %s schema, refuses a key that ignores case", (_, shadow) => {
      const database = new DatabaseSync(":memory:")
      database.exec("CREATE TABLE repository_trust (project_id TEXT PRIMARY KEY COLLATE NOCASE, trusted_digest TEXT NOT NULL, trusted_at TEXT NOT NULL, trusted_client TEXT NOT NULL, trusted_client_id TEXT)")
      database.prepare("INSERT INTO repository_trust VALUES ('project-acme', ?, '2026-09-28T10:00:00.000Z', 'desktop', NULL)").run(digest("a"))
      database.exec(shadow.replace("MODULE", module))
      const trust = new SqliteRepositoryTrust(database)

      expect(trust.find("project-acme")).toBeUndefined()
      expect(() => trust.record({ projectId: "project-beta", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })).toThrow()
    })
  })

  it.each([
    ["an extra index that compares bytes", "CREATE INDEX \"by client's time\" ON repository_trust (trusted_client, trusted_at)"],
    ["an extra index that ignores case", "CREATE INDEX \"folded's key\" ON repository_trust (project_id COLLATE NOCASE)"],
    ["its trusted_at index on another column", "DROP INDEX repository_trust_trusted_at; CREATE INDEX repository_trust_trusted_at ON repository_trust (trusted_client)"],
    ["its trusted_at index ignoring case", "DROP INDEX repository_trust_trusted_at; CREATE INDEX repository_trust_trusted_at ON repository_trust (trusted_at COLLATE NOCASE)"],
    ["its trusted_at index unique", "DROP INDEX repository_trust_trusted_at; CREATE UNIQUE INDEX repository_trust_trusted_at ON repository_trust (trusted_at)"],
    ["its trusted_at index partial", "DROP INDEX repository_trust_trusted_at; CREATE INDEX repository_trust_trusted_at ON repository_trust (trusted_at) WHERE trusted_client = 'web'"],
  ])("refuses its table with %s: its indexes are exactly the store's own", (_, change) => {
    const database = new DatabaseSync(":memory:")
    new SqliteRepositoryTrust(database).record({ projectId: "project-acme", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })
    database.exec(change)
    const trust = new SqliteRepositoryTrust(database)

    expect(trust.find("project-acme")).toBeUndefined()
    expect(() => trust.record({ projectId: "project-beta", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })).toThrow()
  })

  it.each(["80", "C080", "EDA080"])("refuses an index whose stored name is invalid UTF-8 (%s)", (bytes) => {
    const database = new DatabaseSync(":memory:")
    new SqliteRepositoryTrust(database).record({ projectId: "project-acme", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })
    // A NOCASE index renamed to bytes that read back as U+FFFD, beside an
    // index that compares bytes, on an unrelated table, named with the
    // replacement characters themselves. Looking the listed name up would
    // read the unrelated index's keys.
    database.exec("CREATE INDEX folded ON repository_trust (project_id COLLATE NOCASE); CREATE TABLE unrelated (value TEXT)");
    (database as { enableDefensive?: (active: boolean) => void }).enableDefensive?.(false)
    database.exec(`
      PRAGMA writable_schema = ON;
      UPDATE sqlite_master SET name = CAST(X'${bytes}' AS TEXT), sql = 'CREATE INDEX "' || CAST(X'${bytes}' AS TEXT) || '" ON repository_trust (project_id COLLATE NOCASE)' WHERE name = 'folded';
      PRAGMA writable_schema = RESET;
    `)
    const decoded = (database.prepare("PRAGMA main.index_list(repository_trust)").all() as Array<{ name: string }>).find(({ name }) => name.includes("�"))!.name
    database.exec(`CREATE INDEX "${decoded}" ON unrelated (value)`)
    const trust = new SqliteRepositoryTrust(database)

    expect(trust.find("project-acme")).toBeUndefined()
    expect(() => trust.record({ projectId: "project-beta", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })).toThrow()
  })

  it("accepts its table when only an unrelated temporary index of the same name ignores case", () => {
    const database = new DatabaseSync(":memory:")
    const recorded = new SqliteRepositoryTrust(database).record({ projectId: "project-acme", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })
    database.exec(`
      CREATE TEMP TABLE unrelated (value TEXT);
      CREATE INDEX temp.repository_trust_trusted_at ON unrelated (value COLLATE NOCASE);
    `)
    const trust = new SqliteRepositoryTrust(database)

    expect(trust.find("project-acme")).toEqual(recorded)
  })

  it("reads and revokes only the exact project id, even from a table swapped in after its check", () => {
    const database = new DatabaseSync(":memory:")
    const trust = new SqliteRepositoryTrust(database)
    // The table passed the check at construction; this one, made afterwards,
    // compares project ids without regard to case.
    database.exec(`
      DROP TABLE repository_trust;
      CREATE TABLE repository_trust (project_id TEXT PRIMARY KEY COLLATE NOCASE, trusted_digest TEXT NOT NULL, trusted_at TEXT NOT NULL, trusted_client TEXT NOT NULL, trusted_client_id TEXT);
    `)
    database.prepare("INSERT INTO repository_trust VALUES ('project-alpha', ?, '2026-09-28T10:00:00.000Z', 'desktop', NULL)").run(digest("a"))

    expect(trust.find("project-ALPHA")).toBeUndefined()
    expect(trust.find("project-alpha")).toMatchObject({ projectId: "project-alpha" })
    trust.revoke("project-ALPHA")
    expect(trust.find("project-alpha")).toMatchObject({ projectId: "project-alpha" })
  })

  it("stops reading and recording grants when a failed record cannot be rolled back", () => {
    const database = new DatabaseSync(":memory:")
    const trust = new SqliteRepositoryTrust(database)
    for (let index = 0; index < maximumRepositoryTrustRecords; index += 1) {
      trust.record({ projectId: `project-${index}`, trustedDigest: digest("a"), trustedBy: { client: "desktop" } })
    }
    // RAISE(ROLLBACK) ends the whole transaction, so the savepoint the store
    // would roll back to is gone and the rollback cannot be confirmed.
    database.exec("CREATE TRIGGER end_transaction BEFORE DELETE ON repository_trust BEGIN SELECT RAISE(ROLLBACK, 'ended'); END")

    expect(() => trust.record({ projectId: "project-new", trustedDigest: digest("b"), trustedBy: { client: "web" } })).toThrow()
    expect(trust.find("project-new")).toBeUndefined()
    expect(trust.find("project-0")).toBeUndefined()
    expect(() => trust.record({ projectId: "project-other", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })).toThrow()
  })

  // DatabaseSync.setAuthorizer arrived in Node 24.10; Node 22.13 lacks it, so
  // these skip there (as does the authorizer test in
  // server-repository-trust.test.ts), and the RAISE(ROLLBACK) test above is
  // the disabled store's coverage on every Node.
  describe.skipIf(typeof (DatabaseSync.prototype as { setAuthorizer?: unknown }).setAuthorizer !== "function")("when ROLLBACK TO itself is refused", () => {
    // The trim's DELETE and the savepoint rollback are refused, so the new
    // grant is written and cannot be undone by the savepoint.
    function refusingRollback() {
      const database = new DatabaseSync(":memory:")
      const trust = new SqliteRepositoryTrust(database)
      for (let index = 0; index < maximumRepositoryTrustRecords; index += 1) {
        trust.record({ projectId: `project-${index}`, trustedDigest: digest("a"), trustedBy: { client: "desktop" } })
      }
      let refusing = false
      database.setAuthorizer((action, operation) => refusing && (action === constants.SQLITE_DELETE || (action === constants.SQLITE_SAVEPOINT && operation === "ROLLBACK"))
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK)
      const failRecord = () => {
        refusing = true
        try {
          expect(() => trust.record({ projectId: "project-new", trustedDigest: digest("b"), trustedBy: { client: "web" } })).toThrow()
        } finally {
          refusing = false
        }
      }
      return { database, trust, failRecord }
    }
    const rows = (database: DatabaseSync) => database.prepare("SELECT COUNT(*) AS count FROM repository_trust").get()

    it("leaves no readable grant and undoes the transaction it opened", () => {
      const { database, trust, failRecord } = refusingRollback()
      failRecord()

      expect(trust.find("project-new")).toBeUndefined()
      expect(trust.find("project-1")).toBeUndefined()
      expect(() => trust.record({ projectId: "project-other", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })).toThrow()
      // The store opened the transaction, so it rolled all of it back.
      expect(database.prepare("SELECT 1 AS present FROM repository_trust WHERE project_id = 'project-new'").get()).toBeUndefined()
      expect(rows(database)).toEqual({ count: maximumRepositoryTrustRecords })
    })

    it("yields no trusted grant through the store after the caller commits its transaction", () => {
      const { database, trust, failRecord } = refusingRollback()
      database.exec("BEGIN")
      failRecord()
      expect(trust.find("project-new")).toBeUndefined()
      database.exec("COMMIT")

      expect(trust.find("project-new")).toBeUndefined()
      expect(trust.find("project-1")).toBeUndefined()
      expect(() => trust.record({ projectId: "project-other", trustedDigest: digest("a"), trustedBy: { client: "desktop" } })).toThrow()
    })
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
