import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { workspaceSnapshotSchema, type WorkspaceSnapshot } from "@getdomovoi/protocol"

type StoredWorkspace = {
  snapshot: string
}

export interface WorkspaceStore {
  load(): WorkspaceSnapshot
  save(snapshot: WorkspaceSnapshot): void
  close(): void
}

export type WorkspaceStoreOptions = {
  legacySnapshots?: WorkspaceSnapshot[]
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  readonly path: string
  #database: DatabaseSync

  constructor(path: string, initial: WorkspaceSnapshot, options: WorkspaceStoreOptions = {}) {
    this.path = path
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.#database = new DatabaseSync(path)
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS workspace_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        snapshot TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)

    const existing = this.#database
      .prepare("SELECT snapshot FROM workspace_state WHERE id = 1")
      .get() as StoredWorkspace | undefined
    const isLegacySeed = existing && options.legacySnapshots?.some(
      (snapshot) => existing.snapshot === JSON.stringify(workspaceSnapshotSchema.parse(snapshot)),
    )
    if (!existing || isLegacySeed) this.save(initial)
  }

  load(): WorkspaceSnapshot {
    const row = this.#database
      .prepare("SELECT snapshot FROM workspace_state WHERE id = 1")
      .get() as StoredWorkspace | undefined
    if (!row) throw new Error("Workspace state is not initialized")
    return workspaceSnapshotSchema.parse(JSON.parse(row.snapshot))
  }

  save(snapshot: WorkspaceSnapshot): void {
    const validated = workspaceSnapshotSchema.parse(snapshot)
    this.#database
      .prepare(`
        INSERT INTO workspace_state (id, snapshot, updated_at)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          snapshot = excluded.snapshot,
          updated_at = excluded.updated_at
      `)
      .run(JSON.stringify(validated), new Date().toISOString())
  }

  close(): void {
    this.#database.close()
  }
}
