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

export class SqliteRepositoryTrust implements RepositoryTrustStore {
  #database: DatabaseSync

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
  }

  // A row the protocol refuses reads as no grant, so the repository is
  // reported not trusted.
  find(projectId: string): RepositoryTrustGrant | undefined {
    const row = this.#database
      .prepare("SELECT * FROM repository_trust WHERE project_id = ?")
      .get(projectId) as StoredRepositoryTrust | undefined
    if (!row) return undefined
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

  // A repository's new grant replaces its earlier one.
  record(input: RepositoryTrustGrantInput): RepositoryTrustGrant {
    const grant = checkedGrant({ ...input, trustedAt: new Date().toISOString() })
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
    return grant
  }

  revoke(projectId: string): void {
    this.#database.prepare("DELETE FROM repository_trust WHERE project_id = ?").run(projectId)
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
