# Durable turns and history links

CX2 gives each newly acknowledged provider dispatch a durable, session-local ordinal.
Steering adds a user message to the existing dispatch. It does not allocate another
ordinal. User messages, assistant messages and tool output carry a
`turnId` only when the daemon has an exact dispatch identity for them.

Some providers allocate a new prompt ID while steering an existing turn. That user
message also stores `providerMessageKey`, the digest of provider, thread and prompt
ID. Its explicit `turnId` routes later provider reports to the original dispatch,
including after restart or transfer. The key is absent when the adapter does not
return a separate message identity. It is never inferred from message text or time.

The turn ID is CX1's digest of provider, provider thread and provider turn identity.
It is not a provider turn ID by itself, a timestamp, a message count or a row position.
Accounting records store optional `turn: { ordinal, startedAt, completedAt? }`
metadata. Ordinal allocation and the dispatch record are persisted together.
`completedAt` exists for `completed`, `failed` and `interrupted` records; `pending`
records have no completion time. These are daemon wall-clock timestamps, not an
approved command's execution duration.

Records written before CX2 have no ordinal. They stay unnumbered. The first numbered
dispatch in such a session starts at 1; that is not a claim that the older session had
no turns. A request that fails or times out before returning its identity cannot
produce a new durable dispatch or steering association. Missing links remain absent.

## Client contract

Thread items and assistant/tool-output deltas have optional `turnId`. History entries
carry the same optional link and, when the durable record is available, `turn`:

```ts
{
  id: string
  sessionId: string
  ordinal: number
  provider: string
  requestedModel: string
  reportedModels: string[]
  startedAt: string
  completedAt?: string
  status: "pending" | "completed" | "failed" | "interrupted"
  coverage: "pending" | "complete" | "partial" | "unavailable"
  usage: AccountedUsage
  recordedToolCount: number
}
```

`requestedModel` is captured at dispatch. Provider observations supply
`reportedModels`; later session model changes do not rewrite either. `usage` follows
[CX1's accounting and coverage contract](usage-accounting.md). An unavailable token
count must not be displayed as a measured zero, and partial usage must be qualified.

`recordedToolCount` counts distinct stored tool rows for that turn across the whole
session, including rows outside the current page and filter. It does not claim to
count every provider-internal tool call: some adapters report only selected kinds.
Clients must name that limit instead of presenting an exhaustive tool count.

Each page carries the linked turn metadata directly, even when the initiating user
message is on another page. Fresh metadata is joined after pagination so late usage
reports are visible without rebuilding the history index. A row with no durable
link must not acquire one through timestamps, labels or neighboring rows.

## Restart, transfer and checkpoints

Ordinals, dispatch models, completion state and message links survive restart.
Transfer carries the ordinal metadata in the existing usage records alongside
the linked thread items. Duplicate ordinals and dangling transferred links are
invalid. A target continues after the highest imported ordinal; imported usage
does not become newly metered local usage.

Only schema-valid accounting can reserve an ordinal. Before a session's first write,
the ledger rebuilds its derived ordinal index from that session's evidence. The first
schema upgrade creates the SQLite index across the whole usage table once; subsequent
accounting revalidation is session-local. Corrupt accounting keeps its raw metadata and measured
totals without reserving a number. Later writes update the evidence and index together.
The in-memory validation cache holds at most 1,024 sessions; eviction or rollback
causes the next write to revalidate. If valid history reaches `Number.MAX_SAFE_INTEGER`, beginning
another turn refuses with an explicit exhaustion error and leaves the history intact.

CX2 does not turn a turn ID into a checkpoint ID. A client may offer a turn-specific
fork only when an actual checkpoint for that exact boundary exists. Substituting the
nearest checkpoint would name a different filesystem state. CX5 separately adds
typed checkpoint reasons and the session-start checkpoint row.
