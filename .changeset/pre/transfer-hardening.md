---
"@getdomovoi/daemon": patch
---

Harden session transfers against interference and interrupted work.

Promoted artifact sources are opened without following symlinks and read through
the handle that was validated, so a file swapped after its check cannot be read
in its place. Non-final transfer chunks must be exactly one chunk long, which
bounds what a sender can make the journal hold.

Transfers no longer block unrelated sessions, concurrent transfers no longer
overwrite each other's state, and a move interrupted by a failed terminal
shutdown, a crash between commit and save, or a failed journal write leaves the
source recoverable rather than frozen or silently thawed.
