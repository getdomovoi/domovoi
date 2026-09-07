# Transfer member receive exclusion

Each `FileTransferTransactions.acceptMember` call reserves its chunk path before any
asynchronous work. It also holds an exclusive SQLite file lease from before journal reads
through member publication and chunk directory removal. Updated daemon processes sharing a
journal therefore cannot receive the same member while another receiver still has a chunk
handle open. Contention returns the existing `chunk-out-of-order` refusal immediately;
retry after the current receiver settles uses the ordinary idempotent receive path.

The lease uses `claimExclusiveFileLease`, the same zero-wait OS-backed mechanism as profile
ownership. Ordinary completion and failure explicitly release it. Process death releases the
OS lock, allowing another process to adopt retained chunks without deleting a stale claim.
There is no time-based lease stealing.

Lease files live in `<journal-root>/.receive-leases`, outside disposable transaction
directories. Their inodes must never be replaced or removed while any daemon can use the
journal. A stable hash of transfer and member IDs selects one of 256 permanent filenames,
bounding metadata growth after transaction retention cleanup. Two unrelated members can hash
to the same slot; overlapping receives then get the same temporary refusal. Distinct slots
remain independent. No lease files contain transferred bytes or credentials.

This lease protects member receive against member receive across processes. Whole-transaction
abort, removal and retention remain the responsibility of the owning daemon's transfer queue
and lifecycle. It does not make every journal API safe for arbitrary concurrent mutation by
independent owners. Production profile ownership separately excludes two writable daemons
over the same profile.

`transfer-transactions.test.ts` starts two daemon child processes with separate stores and one
shared journal. The first holds an actual chunk descriptor open while the second sends an
authenticated retry over its own socket. The test checks immediate refusal, another member's
progress, and successful adoption after either normal completion or forced process death.
Filesystem reads, publication and cleanup use the host OS; the test synthesizes no filesystem
errors. The ordinary CI matrix runs this proof on Linux, macOS and Windows.
