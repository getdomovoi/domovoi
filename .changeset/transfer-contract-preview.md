---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
"@getdomovoi/ui": minor
---

Agree what a move carries before it happens. A transfer is previewed first, and
the move is refused unless it carries the contract version and intent digest the
preview returned, so a session that changed after the preview cannot be moved on
a stale description of itself. When that happens the dialog previews again rather
than leaving a digest that can never be accepted.

The dialog lists what the daemon reports the move will carry, instead of a list
maintained beside it that had drifted into promising things the contract never
moved.
