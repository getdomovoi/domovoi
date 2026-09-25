---
"@getdomovoi/daemon": patch
---

The restore lease record is no longer flushed to disk on every write, and the writes no longer
block the daemon's event loop. A restore wrote the record three times per Git command, each with a
synchronous flush; on Windows runners a flush measured up to 0.85 s, so one restore could stall the
daemon for seconds. The record is still written to a new file and renamed over the old one, so a
reader sees a whole record, and a crash of the daemon process keeps the last completed rename.
After an OS crash or power loss an unflushed record can be lost or torn; no Git child survives a
reboot, and recovery already refuses to reclaim a claim whose record lists children or cannot be
read, so the claim is kept for inspection as before.
