---
"@getdomovoi/protocol": patch
"@getdomovoi/daemon": patch
---

The tool inventory no longer carries a credential in a remote tool server's host or in an
environment key name. The reader shows `[REDACTED]` for a host with a label shaped like a known
credential, read in the URL as written and as parsed, and for an environment key name that is
itself shaped like one; the entry is still listed. The protocol refuses those shapes in both fields
and takes the marker, so a reader that misses one drops the entry and counts it instead of sending
it.
