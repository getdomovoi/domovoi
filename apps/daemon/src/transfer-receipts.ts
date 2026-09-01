import type { DatabaseSync } from "node:sqlite"

import { transferReceiptSchema, type TransferReceipt } from "@getdomovoi/protocol"

export const maximumListedTransferReceipts = 200

// A transfer moves a session between machines, so what happened is recorded
// where it can be read back: which session, which machines, and the checkpoint
// it travelled at. The source keeps its recovery checkpoint, and a receipt that
// claims otherwise is not a receipt this daemon will store.
export class SqliteTransferReceipts {
  #database: DatabaseSync

  constructor(database: DatabaseSync) {
    this.#database = database
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS transfer_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        receipt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transfer_receipts_completed_at
        ON transfer_receipts (completed_at DESC, id DESC);
    `)
  }

  record(receipt: TransferReceipt): void {
    const described = transferReceiptSchema.safeParse(receipt)
    if (!described.success) throw new Error("Transfer receipt is invalid")
    this.#database
      .prepare(
        "INSERT INTO transfer_receipts (session_id, completed_at, receipt) VALUES (?, ?, ?)",
      )
      .run(described.data.sessionId, described.data.completedAt, JSON.stringify(described.data))
  }

  list(options: { limit?: number } = {}): TransferReceipt[] {
    const limit = Math.min(options.limit ?? maximumListedTransferReceipts, maximumListedTransferReceipts)
    const rows = this.#database
      .prepare(
        "SELECT receipt FROM transfer_receipts ORDER BY completed_at DESC, id DESC LIMIT ?",
      )
      .all(Math.max(limit, 0)) as { receipt: string }[]
    return rows.flatMap((row) => {
      const described = transferReceiptSchema.safeParse(JSON.parse(row.receipt))
      // A row this build cannot describe is not reported as a transfer.
      return described.success ? [described.data] : []
    })
  }
}
