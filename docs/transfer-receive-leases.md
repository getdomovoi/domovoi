# Transfer member receive exclusion

Each `FileTransferTransactions.acceptMember` call reserves its chunk path before any
asynchronous work. Its process also holds an exclusive SQLite file lease from before journal
reads through member publication and chunk directory removal. Independent members and transfers
within that process share the journal lease. Another process sharing the journal cannot receive
until every active receive in the current process settles. Contention returns the existing
`chunk-out-of-order` refusal immediately; the sender ends that attempt. A subsequent attempt
after release uses the ordinary idempotent receive path.

The lease uses `claimExclusiveFileLease`, the same zero-wait OS-backed mechanism as profile
ownership. Ordinary completion and failure explicitly release it. Process death releases the
OS lock, allowing another process to adopt retained chunks without deleting a stale claim.
There is no time-based lease stealing.

One permanent lease file lives at `<journal-root>/.receive-lease.sqlite`, outside disposable
transaction directories. Its inode must never be replaced or removed while any daemon can use
the journal. Lock metadata does not grow with transfer count, and unrelated transfers in the
owning process cannot collide through a truncated hash. Separate journals stay independent.
The lease file contains no transferred bytes or credentials.

This lease protects member receive against member receive across processes. Whole-transaction
abort, removal and retention remain the responsibility of the owning daemon's transfer queue
and lifecycle. It does not make every journal API safe for arbitrary concurrent mutation by
independent owners. Production profile ownership separately excludes two writable daemons
over the same profile.

`transfer-transactions.test.ts` starts two daemon child processes with separate stores and one
shared journal. The first holds an actual chunk descriptor open while the second sends an
authenticated retry over its own socket. The test checks immediate refusal and successful
adoption after either normal completion or forced process death. Other tests keep independent
members and transfers available within the receiving process while a chunk read is held open.
Filesystem reads, publication and cleanup use the host OS; the test synthesizes no filesystem
errors. The ordinary CI matrix runs this proof on Linux, macOS and Windows.
