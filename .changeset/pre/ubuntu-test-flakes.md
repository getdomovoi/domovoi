---
"@getdomovoi/daemon": patch
"@getdomovoi/desktop": patch
---

Stop two tests failing on a loaded CI worker.

`annotation-visual-context.test.ts` waited for a crop file through 100 event-loop
turns. Turns cost microseconds and the write costs a disk, so a busy Ubuntu
worker exhausted them and the test reported a timeout on a crop that was on its
way. It now waits through `waitForDaemon`, the measured budget the rest of the
daemon observations use.

The desktop signing tests ran under `node --test`, which forks a child and reads
its results back over a serialized protocol. Twice that stream was reported
corrupt, as "Unable to deserialize cloned data due to invalid or unsupported
version", after every assertion in the file had already passed. The file now runs
in process, where `node:test` needs no child and no protocol between them, and a
failing assertion still exits non-zero.

The corruption itself is unreproduced here: it needs the Node 22 that CI uses,
and this machine runs Node 26. This removes the channel rather than claiming a
diagnosis of it.
