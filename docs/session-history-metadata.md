# Session history metadata

Protocol 0.6.0 adds the `transfers` history category. Update clients and daemons together:
0.5 clients cannot parse that union variant and receive a protocol mismatch at hello.
Existing bound credentials remain valid. Old stored receipts and transfer snapshots remain
readable, but missing measurements are not backfilled with invented values.

## Approval decision time

Approval thread receipts and `session.history` approval entries optionally carry
`decisionDurationMs`, a nonnegative integer in milliseconds. It measures wall-clock time from
the approval's `requestedAt` to its resolution, including denial by archive or emergency stop.
A clock correction that puts resolution before the request is clamped to zero.

Render this as "decided in 38s", never "ran 38s". It is not execution duration. Legacy receipts
and direct actions without an approval request, such as file revert, omit the field.

## Machine transfers

Request `session.history` with `categories: ["transfers"]`. A successful transfer writes a system
thread item on departure and arrival; its structured `transfer` field projects into this history
category. Provider switches remain `handoffs`. Refusals, recovery claims and conflict releases
do not emit successful-transfer metadata. Existing untyped system notes retain their category.

The history entry retains `body`, optional `detail`, and the real thread `sourceId`. Its `transfer`
field carries `transferId`, `sourceMachineId`, `targetMachineId`, `checkpointCommit`,
`outcome: "succeeded"`, `preflight: "passed"`, and optional `coverage`. Coverage uses the existing
`sessionTransferCoverageSchema`, and survives package cleanup and daemon restart. An older
in-flight source snapshot may have no retained coverage.

The Git workspace service counts ignored files during preflight. Ignored artifact sources whose
bytes travel in the package are subtracted, once per path. Ordinary untracked files travel in
the checkpoint and are not holdbacks. Counts reflect the preflight inventory, not a later scan.

Use `transfer.coverage?.excluded.find(entry => entry.kind === "ignored-files")?.count` for
"3 ignored files held back". A failed or oversized inventory, an older snapshot, or a workspace
adapter without counting support leaves the count absent. Do not render an absent count as zero.
The inventory has a 32 MiB Git output bound and observes the transfer request's abort signal.
