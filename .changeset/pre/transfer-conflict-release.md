---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
"@getdomovoi/ui": minor
---

Settle a session two machines claim. When a target turns out to already hold the
session, the source freezes instead of thawing, so the two copies cannot both be
written. Conflicts record how they were found, either a target that was observed
to hold the session or a recovery that was later contradicted, rather than
recording one as the other.

The way out is deliberately one way. A machine can give up its claim and let the
other keep the session; it cannot take the session back, because that needs the
other machine's agreement and not a local click. Releasing leaves the worktree in
place and readable, and nothing removes it automatically.

A released session is recorded as released rather than as a completed move, so it
never reports that a transfer succeeded when what happened is that this machine
gave up.
