# Domovoi credential custody

Node-only custody policy shared by daemon channel keys and CLI paired records.
An explicit credential file selects file storage. Otherwise the OS keychain must
answer its probe. Absence, lock and other keychain failures never select a file.
Callers supply their existing refusal and warning text and retain their own
record schemas. A channel key and a paired bearer grant different authority.

`openCredentialBackend` returns a keyring or a file with `read` and `write`.
`nativeKeyring` takes a service and probe account, so credential kinds do not
share a namespace. `readPrivateFile` checks the opened descriptor before reading:
regular file, no leaf symlink, unchanged file identity, and no group/other mode
bits on Unix. Windows does not have a Unix mode guarantee; its inherited ACL is
outside this check, matching the existing CLI policy. Parent-directory trust and
concurrent writers remain the caller's responsibility.

Files publish through an exclusive random staging file, mode 0600, fsync and
rename. On POSIX, newly created directory entries are flushed before writing and
the containing directory is flushed after rename. Unsupported directory flushes
and other flush errors refuse. Windows file contents are flushed, but directory
flushing is not implemented here; power-loss name durability is not promised.
Before rename, failure removes staging or reports both failures and its path.
After rename, failure names the already published file and uncertain durability;
it does not remove that credential. These are filesystem flush requests, not a
physical power-loss test.

`maximumBytes` must be a positive safe integer when supplied, checked before
filesystem access. It bounds reads before allocation and is recommended for each
record kind. Returned JavaScript strings cannot be wiped by this package.

The package is publishable. The daemon bundles it into dist, leaving its native
keyring dependency external. No second archive is added to the daemon runtime
lock. The CLI port keeps the paired-record format and warning text unchanged.
