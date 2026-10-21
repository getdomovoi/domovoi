---
"@getdomovoi/desktop": minor
---

Desktop now builds its daemon through the shared production factory instead
of a hand-assembled server with a random per-launch token. The daemon keeps a
persisted credential and machine identity across launches, so paired devices
keep working after Desktop restarts, and the renderer connects to the URL and
token of the daemon that was actually started rather than a fixed address. The
launch smoke no longer requests daemon credentials and fails if a daemon state
directory appears during the packaging test.
