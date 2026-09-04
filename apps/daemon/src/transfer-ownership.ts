import type { DatabaseSync } from "node:sqlite"

import {
  machineIdSchema,
  projectSchema,
  sessionTransferContractVersionSchema,
  sessionTransferOriginSchema,
  sessionTransferSessionSchema,
} from "@getdomovoi/protocol"

export const committedTransferOwnershipSchema = sessionTransferOriginSchema.extend({
  version: sessionTransferContractVersionSchema,
  sessionId: sessionTransferSessionSchema.shape.id,
  targetMachineId: machineIdSchema,
  targetProjectId: projectSchema.shape.id,
  workspacePath: projectSchema.shape.path,
}).strict()

export type CommittedTransferOwnership = ReturnType<
  typeof committedTransferOwnershipSchema.parse
>

export type CommittedTransferOwnershipLookup = Pick<
  CommittedTransferOwnership,
  "transferId" | "manifestDigest" | "sourceMachineId"
>

export interface TransferOwnership {
  find(lookup: CommittedTransferOwnershipLookup): CommittedTransferOwnership | undefined
}

type StoredOwnership = { ownership: string }

// A target's imported session is not enough by itself to answer ownership
// after the active project changes or the transaction journal is pruned. This
// machine-wide record is the durable, digest-bound acknowledgement to the
// source. The workspace store writes it in the same SQLite transaction as the
// imported snapshot.
export class SqliteTransferOwnership implements TransferOwnership {
  readonly #database: DatabaseSync

  constructor(database: DatabaseSync) {
    this.#database = database
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS transfer_ownership (
        transfer_id TEXT PRIMARY KEY,
        manifest_digest TEXT NOT NULL,
        source_machine_id TEXT NOT NULL,
        ownership TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transfer_ownership_source
        ON transfer_ownership (source_machine_id, transfer_id);
    `)
  }

  record(raw: CommittedTransferOwnership): void {
    const ownership = committedTransferOwnershipSchema.parse(raw)
    this.#database
      .prepare(`
        INSERT INTO transfer_ownership (
          transfer_id, manifest_digest, source_machine_id, ownership
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(transfer_id) DO NOTHING
      `)
      .run(
        ownership.transferId,
        ownership.manifestDigest,
        ownership.sourceMachineId,
        JSON.stringify(ownership),
      )
    const stored = this.#findByTransferId(ownership.transferId)
    if (!stored || JSON.stringify(stored) !== JSON.stringify(ownership)) {
      throw new Error("Transfer ownership record conflicts with an existing transfer")
    }
  }

  find(lookup: CommittedTransferOwnershipLookup): CommittedTransferOwnership | undefined {
    const transferId = committedTransferOwnershipSchema.shape.transferId.parse(lookup.transferId)
    const manifestDigest = committedTransferOwnershipSchema.shape.manifestDigest.parse(
      lookup.manifestDigest,
    )
    const sourceMachineId = machineIdSchema.parse(lookup.sourceMachineId)
    const row = this.#database
      .prepare(`
        SELECT ownership FROM transfer_ownership
        WHERE transfer_id = ? AND manifest_digest = ? AND source_machine_id = ?
      `)
      .get(transferId, manifestDigest, sourceMachineId) as StoredOwnership | undefined
    if (!row) return undefined
    return committedTransferOwnershipSchema.parse(JSON.parse(row.ownership))
  }

  #findByTransferId(transferId: string): CommittedTransferOwnership | undefined {
    const row = this.#database
      .prepare("SELECT ownership FROM transfer_ownership WHERE transfer_id = ?")
      .get(transferId) as StoredOwnership | undefined
    if (!row) return undefined
    return committedTransferOwnershipSchema.parse(JSON.parse(row.ownership))
  }
}
