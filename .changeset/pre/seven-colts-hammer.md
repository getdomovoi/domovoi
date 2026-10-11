---
"@getdomovoi/daemon": patch
---

Prevent concurrent transfer chunk retries from removing a directory while another receive
still holds a chunk open, which can fail with EPERM on Windows. Reserve the complete member
receive through cleanup within the daemon process, refuse overlapping receives without a
queue wait, and release the reservation after errors so later retries can proceed.
