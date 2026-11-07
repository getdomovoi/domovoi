---
"@getdomovoi/protocol": patch
"@getdomovoi/daemon": patch
---

Accept compatible patch versions in daemon snapshots without rewriting the reported
version. Validate bounded canonical wire versions consistently and compare major
and minor components exactly, including values above the safe integer limit.
