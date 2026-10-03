---
"@getdomovoi/mobile": patch
---

A receipt that carries the daemon's turn id stays drawn in full while it is the latest of the
running turn. The phone compared that id, a digest, with the session's raw provider turn id, which
never matched, so such a receipt would always have been folded to its compact form.
