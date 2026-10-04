---
"@getdomovoi/protocol": minor
---

The tool inventory's repository can now carry a `gitFilters` block: each git filter driver the
repository's own Git config sets (`local`, `worktree` or `command` scope), by operation (`clean`,
`smudge` or `process`, or a Git LFS setting that starts a program: `lfs-transfer-path`,
`lfs-transfer-args`, `lfs-standalone-agent`, `lfs-extension-clean`, `lfs-extension-smudge`), with
its redacted command, the config file that sets it and the scope Git read that file in, and
whether the daemon holds it back. A file is listed once per scope, an entry names a listed file
in its scope, at most 64
entries and 32 files are listed, and `omittedEntries` counts the rest. The block is optional.
When the daemon could not read the repository's Git config, the block lists nothing and carries
`unreadable` with a reason code, `too-large` or `git-failed`.

Adds `repositoryGitFilterErrorCode` (`-32020`) for a `session.create`, `session.fork` or transfer
refused because checking the repository out would run a filter its own Git config sets. Its data,
`repositoryGitFilterRefusalSchema`, names the project, the current configuration digest, the
repository's trust against that digest, and up to 32 drivers by name and scope, never by command,
with `omittedDrivers` counting the rest.
