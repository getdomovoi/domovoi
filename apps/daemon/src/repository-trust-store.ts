import type { DatabaseSync } from "node:sqlite"

import {
  repositoryTrustProjectIdSchema,
  repositoryTrustStateSchema,
  type RepositoryTrustGrantClient,
} from "@getdomovoi/protocol"

// This machine's repository trust grants (slice P5), one per repository, keyed
// by the project id and pinned to the configuration digest the person
// reviewed. The daemon records and reports them; nothing loads under them yet
// (applying trust is P6 to P8). A grant counts only while the repository's
// current digest is the one it names; the caller compares.

export const maximumRepositoryTrustRecords = 512

export type RepositoryTrustGrant = {
  projectId: string
  trustedDigest: string
  trustedAt: string
  trustedBy: { client: RepositoryTrustGrantClient; clientId?: string }
}

export type RepositoryTrustGrantInput = Omit<RepositoryTrustGrant, "trustedAt">

export interface RepositoryTrustStore {
  find(projectId: string): RepositoryTrustGrant | undefined
  record(input: RepositoryTrustGrantInput): RepositoryTrustGrant
  revoke(projectId: string): void
}

type StoredRepositoryTrust = {
  project_id: string
  trusted_digest: string
  trusted_at: string
  trusted_client: string
  trusted_client_id: string | null
}

// Checked against the protocol both ways, so a grant the protocol would refuse
// is neither written nor read back.
function checkedGrant(grant: RepositoryTrustGrant): RepositoryTrustGrant {
  const projectId = repositoryTrustProjectIdSchema.parse(grant.projectId)
  const state = repositoryTrustStateSchema.parse({
    state: "trusted",
    trustedDigest: grant.trustedDigest,
    trustedAt: grant.trustedAt,
    trustedBy: grant.trustedBy,
  })
  if (state.state !== "trusted") throw new Error("A repository trust grant is trusted")
  const { clientId } = state.trustedBy
  return {
    projectId,
    trustedDigest: state.trustedDigest,
    trustedAt: state.trustedAt,
    trustedBy: { client: state.trustedBy.client, ...(clientId === undefined ? {} : { clientId }) },
  }
}

// The table this store creates, column by column, with project_id its only
// key. Anything else under the name was not made here, so it yields no grant.
// hidden 0 is an ordinary column; generated and hidden columns, which
// table_info leaves out, are refused.
const expectedColumns = [
  { name: "project_id", pk: 1, hidden: 0 },
  { name: "trusted_digest", pk: 0, hidden: 0 },
  { name: "trusted_at", pk: 0, hidden: 0 },
  { name: "trusted_client", pk: 0, hidden: 0 },
  { name: "trusted_client_id", pk: 0, hidden: 0 },
]

// The table's only indexes, sorted by name as the check compares them. Each
// key query is a fixed literal: no name from the catalog is written into SQL.
// Every key column compares as bytes.
const expectedIndexes = [
  {
    name: "repository_trust_trusted_at",
    unique: 0,
    origin: "c",
    partial: 0,
    keysQuery: "PRAGMA main.index_xinfo(repository_trust_trusted_at)",
    keys: [{ name: "trusted_at", coll: "BINARY" }],
  },
  {
    name: "sqlite_autoindex_repository_trust_1",
    unique: 1,
    origin: "pk",
    partial: 0,
    keysQuery: "PRAGMA main.index_xinfo(sqlite_autoindex_repository_trust_1)",
    keys: [{ name: "project_id", coll: "BINARY" }],
  },
]

export class SqliteRepositoryTrust implements RepositoryTrustStore {
  #database: DatabaseSync
  // False when the table under this name is not the one this store creates,
  // or when a failed record could not be rolled back: no grant is read from
  // the table or written to it for the rest of this instance's life. Revoke
  // still deletes and checks, since removing a grant only fails closed.
  #usable: boolean

  constructor(database: DatabaseSync) {
    this.#database = database
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS repository_trust (
        project_id TEXT PRIMARY KEY,
        trusted_digest TEXT NOT NULL,
        trusted_at TEXT NOT NULL,
        trusted_client TEXT NOT NULL,
        trusted_client_id TEXT
      );
      CREATE INDEX IF NOT EXISTS repository_trust_trusted_at
        ON repository_trust (trusted_at);
    `)
    this.#usable = this.#tableIsOurs()
  }

  // One rowid table in the main schema, stored under exactly this name, with
  // exactly the expected ordinary columns and key, and no trigger on it: a
  // trigger could rewrite, keep or drop a grant behind a statement that
  // reports success. SQLite matches names without regard to case, so a table
  // named Repository_Trust answers to every statement here; it is refused, and
  // triggers are looked up the same way. table_xinfo and ncol include the
  // generated and hidden columns table_info leaves out, such as one named
  // rowid that would shadow the rowid the trim reads.
  //
  // table_list is read across every schema, so a temporary table of the same
  // name, which would answer to this store's statements, is refused. The
  // other lookups name main: an index is found by name, and an unqualified
  // name finds a temporary index first. The trigger lookup reads both
  // catalogs, since a temporary trigger can fire on the main table; neither
  // catalog's name can be taken by another object.
  #tableIsOurs(): boolean {
    const tables = this.#database.prepare("PRAGMA table_list(repository_trust)").all() as Array<{ schema: string; name: string; type: string; ncol: number; wr: number }>
    const [table] = tables
    if (tables.length !== 1 || table?.schema !== "main" || table.name !== "repository_trust" || table.type !== "table" || table.ncol !== expectedColumns.length || table.wr !== 0) return false
    const columns = (this.#database.prepare("PRAGMA main.table_xinfo(repository_trust)").all() as Array<{ name: string; pk: number; hidden: number }>)
      .map(({ name, pk, hidden }) => ({ name, pk, hidden }))
    if (JSON.stringify(columns) !== JSON.stringify(expectedColumns)) return false
    // Every index on the table, the primary key's included, compares its key
    // columns as bytes: a key declared COLLATE NOCASE would let one project's
    // grant answer for another project id that differs only in case.
    //
    // The table's indexes must be exactly the two this store has: the primary
    // key's and repository_trust_trusted_at. Any other index, whatever it
    // compares, refuses the table. A name the catalog lists is never looked
    // up: one stored as invalid UTF-8 reads back as U+FFFD, and looking that
    // text up finds a different index. Only the two fixed names below are
    // read, and each must belong to this table.
    //
    // The PRAGMA statement, not the pragma_index_xinfo table-valued function:
    // SQLite resolves that function's name like a table, so a table or virtual
    // table named pragma_index_xinfo, in main, temp or an attached schema,
    // answers in its place, even when the name is qualified. A PRAGMA
    // statement cannot be shadowed. An index with no key column is not one
    // this store creates, and an empty answer never reads as all BINARY.
    const indexes = (this.#database.prepare("PRAGMA main.index_list(repository_trust)").all() as Array<{ name: string; unique: number; origin: string; partial: number }>)
      .map(({ name, unique, origin, partial }) => ({ name, unique, origin, partial }))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    if (JSON.stringify(indexes) !== JSON.stringify(expectedIndexes.map(({ name, unique, origin, partial }) => ({ name, unique, origin, partial })))) return false
    for (const index of expectedIndexes) {
      const owners = this.#database.prepare("SELECT tbl_name FROM main.sqlite_master WHERE type = 'index' AND name = ?").all(index.name) as Array<{ tbl_name: string }>
      if (owners.length !== 1 || owners[0]?.tbl_name !== "repository_trust") return false
      const keys = (this.#database.prepare(index.keysQuery).all() as Array<{ name: string | null; coll: string | null; key: number }>)
        .filter(({ key }) => key === 1)
        .map(({ name, coll }) => ({ name, coll }))
      if (keys.length === 0 || JSON.stringify(keys) !== JSON.stringify(index.keys)) return false
    }
    const triggers = this.#database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'repository_trust' COLLATE NOCASE
      UNION ALL
      SELECT name FROM sqlite_temp_master WHERE type = 'trigger' AND tbl_name = 'repository_trust' COLLATE NOCASE
    `).all()
    return triggers.length === 0
  }

  // A row the protocol refuses reads as no grant, so the repository is
  // reported not trusted.
  find(projectId: string): RepositoryTrustGrant | undefined {
    if (!this.#usable) return undefined
    return this.#read(projectId)
  }

  // Project ids match exactly, whatever collation the table declares: the
  // lookup compares bytes, and a row for another id is not this project's.
  #read(projectId: string): RepositoryTrustGrant | undefined {
    const row = this.#database
      .prepare("SELECT * FROM repository_trust WHERE project_id = ? COLLATE BINARY")
      .get(projectId) as StoredRepositoryTrust | undefined
    if (!row || row.project_id !== projectId) return undefined
    try {
      return checkedGrant({
        projectId: row.project_id,
        trustedDigest: row.trusted_digest,
        trustedAt: row.trusted_at,
        trustedBy: {
          client: row.trusted_client as RepositoryTrustGrantClient,
          ...(row.trusted_client_id === null ? {} : { clientId: row.trusted_client_id }),
        },
      })
    } catch {
      return undefined
    }
  }

  // A repository's new grant replaces its earlier one. The write, the trim to
  // the cap and a read back commit together or not at all. A savepoint nests
  // under the caller's transaction when one is open; otherwise RELEASE
  // commits. The read back refuses a grant that is not stored as written.
  record(input: RepositoryTrustGrantInput): RepositoryTrustGrant {
    if (!this.#usable) throw new Error("The repository trust table is not usable by this daemon")
    const grant = checkedGrant({ ...input, trustedAt: new Date().toISOString() })
    // false: no transaction is open, so the savepoint below opens one and this
    // store owns it. isTransaction is absent before Node 22.16; unknown is
    // treated as the caller's, so the caller's work is never rolled back here.
    const callerTransaction = (this.#database as { isTransaction?: boolean }).isTransaction !== false
    this.#database.exec("SAVEPOINT repository_trust_record")
    try {
      this.#database
        .prepare(`
          INSERT INTO repository_trust (
            project_id, trusted_digest, trusted_at, trusted_client, trusted_client_id
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(project_id) DO UPDATE SET
            trusted_digest = excluded.trusted_digest,
            trusted_at = excluded.trusted_at,
            trusted_client = excluded.trusted_client,
            trusted_client_id = excluded.trusted_client_id
        `)
        .run(grant.projectId, grant.trustedDigest, grant.trustedAt, grant.trustedBy.client, grant.trustedBy.clientId ?? null)
      this.#trim()
      if (JSON.stringify(this.#read(grant.projectId)) !== JSON.stringify(grant)) throw new Error("The repository trust grant was not stored as written")
      this.#database.exec("RELEASE repository_trust_record")
    } catch (error) {
      let rollbackFailure: { error: unknown } | undefined
      try {
        this.#database.exec("ROLLBACK TO repository_trust_record; RELEASE repository_trust_record")
      } catch (rollbackError) {
        rollbackFailure = { error: rollbackError }
      }
      if (rollbackFailure) {
        // The failed grant may still be written, so this store stops reading
        // and recording grants before the error leaves. When it opened the
        // transaction it rolls all of it back, so nothing is left to commit.
        // A caller's transaction is the caller's: it must roll it back, since
        // committing it could make the failed grant durable for a store opened
        // later. This instance reads no grant either way.
        this.#usable = false
        const failures = [error, rollbackFailure.error]
        if (!callerTransaction) {
          try {
            this.#database.exec("ROLLBACK")
          } catch (rollbackError) {
            failures.push(rollbackError)
          }
        }
        throw new AggregateError(failures, "Could not record repository trust or restore its transaction", { cause: error })
      }
      throw error
    }
    return grant
  }

  // Revoked only when no row is left for the repository: a delete that
  // reports success but leaves the grant fails, so the caller never reports a
  // repository untrusted while its grant remains. Nothing to revoke succeeds.
  revoke(projectId: string): void {
    this.#database.prepare("DELETE FROM repository_trust WHERE project_id = ? COLLATE BINARY").run(projectId)
    const left = this.#database.prepare("SELECT 1 AS present FROM repository_trust WHERE project_id = ? COLLATE BINARY").get(projectId)
    if (left !== undefined) throw new Error("The repository trust grant is still stored after revocation")
  }

  // The oldest grants beyond the cap are dropped, which leaves those
  // repositories not trusted: the store fails closed.
  #trim(): void {
    this.#database
      .prepare(`
        DELETE FROM repository_trust
        WHERE rowid NOT IN (
          SELECT rowid FROM repository_trust
          ORDER BY trusted_at DESC, rowid DESC
          LIMIT ?
        )
      `)
      .run(maximumRepositoryTrustRecords)
  }
}
