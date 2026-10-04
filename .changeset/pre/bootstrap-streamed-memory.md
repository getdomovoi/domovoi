---
"@getdomovoi/daemon": patch
---

Stream bootstrap archives into private staging while hashing and bounding each download, instead
of retaining multiple archive-sized buffers. Bound SHA256SUMS separately to 256 KiB. Keep both
checksum checks, fsync, and atomic no-replace publication before reporting success.

Downloads, staging, and publication share a five-minute total deadline; publication also has a
30-second phase limit within the remainder. Expired operations cannot begin later steps. Timeout
errors name the archive to inspect, and private staging can remain if its cleanup budget expired.
The streamed archive phase does not itself install dependencies or manage a service.
