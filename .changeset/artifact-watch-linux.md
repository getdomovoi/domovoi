---
"@getdomovoi/daemon": patch
---

The session artifact watcher no longer rescans the worktree for events inside directories its scan never enters (`node_modules`, `.git`, build output, coverage and the rest of its ignore list), so a build or test run there no longer costs a full walk. On platforms other than macOS and Windows, where Node emulates a recursive `fs.watch` by walking the whole tree synchronously and holding one inotify watch per file, the watcher now polls its bounded asynchronous scan every 2 seconds instead, so a worktree with installed dependencies no longer stalls the daemon or exhausts the user's inotify watches. Artifact changes there are reported within about 2 seconds. On every platform, at most one scan runs per session and at most one waits behind it, so a scan slower than the poll does not build a queue, and a scan failure that repeats on every poll (a worktree past the 20,000-entry scan limit, or a deleted root) is reported once until a scan succeeds again.
