# Usage accounting (CX1)

The daemon records the requested model when it dispatches a new provider turn. Steering
an active turn does not create another accounting entry. A provider-reported model, when
available, belongs to the individual usage observation. `byRuntime.model` continues to
group by the requested model. Missing reported models remain unknown.

Accounting identifies a dispatch by provider, provider thread ID and provider turn ID.
The portable key is a SHA-256 digest of that tuple. Message snapshots additionally use
the provider's message ID. The ledger replaces repeated snapshots of that message and
adds distinct messages. Older, smaller snapshots cannot erase larger observations, and
provisional reports cannot replace final reports. Unknown dispatches are not attributed
to whichever turn happens to be active. OpenCode message usage requires `parentID`.

Stopped or quarantined threads can still report usage for a known dispatch. Those
reports account for work already consumed; they cannot resume execution or append
thread content. The dispatch keeps its interrupted or failed status.

Portable evidence names its provider, and transfer validation requires that identity
to match the usage row. Versioned transfers use contract v2 because strict v1 readers
cannot accept the additional accounting field.

Malformed or schema-incompatible accounting in a durable row is treated as missing
evidence. Its measured totals remain available with legacy coverage, while healthy
pending rows still recover normally. Invalid evidence cannot accept further reports.

Provider normalization:

- Claude's existing Anthropic cache fold is preserved. Cache reads and cache creation
  are included in input tokens. Cached input remains a subset of total input.
- OpenCode and Kilo report separate input, cache read and cache write buckets. The
  normalizer adds both cache buckets to input and total tokens. Invalid accounting
  records an unavailable observation without terminating the event stream.
- ACP `used` and `size` report context occupancy, not consumed tokens. Token consumption
  remains unavailable. ACP cost is cumulative for a provider session, so `sessionCosts`
  reports its greatest observed value per provider thread and currency. It is separate
  from per-turn cost totals and time windows. See the
  [ACP usage contract](https://agentclientprotocol.com/rfds/session-usage).
- Context occupancy remains a provider-reported measurement associated with the active
  runtime and provider thread. It is never derived from lifetime token totals.

Each accounting entry persists its observations, requested model, provider turn ID,
completion status and token coverage in the same SQLite write as its totals. Coverage is:

| Value | Meaning |
| --- | --- |
| `pending` | The dispatched provider turn has not ended. |
| `complete` | All observed accounting scopes have valid final token reports. |
| `partial` | Some consumption is known, but another observation is missing, invalid or provisional. |
| `unavailable` | No valid consumed-token report is available for the ended dispatch. |
| `legacy` | Aggregate coverage count for old rows with no accounting metadata. |

Coverage describes provider telemetry, not independent proof that the provider reported
every internal request. Failure and token coverage are separate: a failed turn can have
complete accounting, and a completed turn can have unavailable accounting. Missing
values do not establish that the provider consumed zero tokens. A rejected or timed-out
dispatch without a returned provider turn ID cannot be associated with subsequent usage.

Late usage can update an explicitly identified dispatch after completion, model changes
or provider changes. It cannot update a session frozen for transfer or owned elsewhere.
Restart marks pending accounting interrupted while retaining known consumption and
deduplication state. Replays retain the original local accounting time.

Transfers carry validated totals and the accounting metadata, including the provider
thread digest, but omit the raw provider thread ID. Import is atomic. Counters, requested
model and identity must agree with the observations. Imported accounting is not charged
again in the target's local time windows, including when an observation is replayed.
Imported context is not applied to a newly started provider thread.

Old ledgers and version 1 transfer records remain readable. Legacy amounts are preserved;
unknown historical coverage is not reconstructed from timestamps or history row order.

CX1 does not create Domovoi turn records, ordinals or message-to-turn associations. CC1's
four-field history row still depends on CX2.
