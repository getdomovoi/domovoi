# Daemon log retention

Production daemons, including the desktop-owned daemon, copy diagnostic errors
to `<home>/.domovoi/logs/daemon.jsonl`. Each JSON line contains `occurredAt`,
`context`, and `detail`. Errors still reach the existing stderr or caller sink.
The file is created on the first diagnostic error, so absence alone does not
mean logging failed. This is separate from the audit RPC used by `domovoi logs`.

## Diagnostic files

- One active file and four archives: `daemon.1.jsonl` is newest,
  `daemon.4.jsonl` oldest. Five files total, each at most 1 MiB.
- Before an append would exceed 1 MiB, discard the oldest archive and rotate.
  Both the newline and UTF-8 encoded JSON count toward the byte cap.
- Each record is at most 16 KiB. Apply the existing error redactor first, then
  fit the encoded record. A record shortened to fit has `truncated: true`.
  The redactor has its own input/output bounds and known-pattern rules; this
  is not a guarantee that arbitrary text contains no secrets.
- The directory is mode 0700 and files mode 0600 on Unix. Windows inherits the
  profile directory's access controls; this writer does not install a new ACL.
  Refuse symlinks, non-regular files, hard-linked files, and, on Unix, files
  readable by other users or owned by another user.
- Check the existing file sizes on every append. Restart preserves the budget.
  Drop only an incomplete final line left by an interrupted write.

The production profile lease provides one writer. Each append is synchronous
and closes its descriptor. Stop closes the sink before releasing the lease;
late callbacks cannot write into the next owner's files. An embedded daemon
constructed directly without the production factory retains its caller's sink.

If opening, repairing, rotating, or appending fails, refuse that file append and
report the logging failure to stderr once per factory lifetime. Later appends
retry; existing diagnostic reporting continues. An oversized existing file is
refused rather than silently truncated or moved into an oversized archive.
Stop the owner and preserve or remove the obstructing log file before retrying.

Rotation uses individual filesystem renames, not a transaction over all five
files. A crash between renames can lose an old archive, but cannot enlarge a
file beyond the byte cap. Failed appends attempt to remove their partial tail;
if cleanup also fails, preserve both causes and repair the tail on a later
write. These are diagnostic files, not a lossless evidence store. Writes are not
fsynced, so a power loss may discard recently written data.

This budget covers Domovoi's diagnostic files only. It does not rotate
systemd's journal, launchd/Task Scheduler output, inherited stderr, provider
transcripts, supervisor records, or the audit database. It does not change
host logging configuration or expose a new remote file-reading RPC.

## Audit records

The existing SQLite audit ledger retains the newest **10,000 activity** records
and **1,000 pre-auth** records independently. The daemon assigns the retention
class; a remote caller cannot choose it. Inserting and pruning occur in the
same savepoint, including when the caller owns a larger transaction.

Activity volume cannot consume the pre-auth budget, and unauthenticated
refusals cannot evict activity. A database restart does not reset either count
or the insertion order. Legacy rows without a retention class remain activity.
These are row-count limits, not a byte limit or a fixed time window. SQLite
may keep freed pages for reuse; pruning does not promise to shrink the
database file.

## Proof

`audit-log.test.ts` fills both shipped limits, reopens the database, and proves
each class prunes without changing the other. Lowering either default by one
fails that test.

`daemon-logs.test.ts` exercises the shipped file budgets, restart, UTF-8 and
JSON expansion, incomplete tails, unsafe paths, a rename failure mid-rotation,
partial disk writes, and failed cleanup. `production-daemon.test.ts` proves
file output, existing sink delivery, visible file failure, and the ownership
boundary between stopped and newly created daemons.
