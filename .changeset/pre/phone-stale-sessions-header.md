---
"@getdomovoi/mobile": patch
---

The phone's Sessions screen no longer reads cached counts as live. While the phone is not
connected, the daemon refused its credential, or the daemon has not yet answered, the header says
the running count is from the last read and when the phone received it ("1 running when last read
at 16:52", or "on 12 Oct at 09:05" from another day) and drops the fleet part, since "1 reachable"
is a claim about now. Cached session cards keep no live light and the running group's count is no
longer green. With nothing listed, the idle card reads "Idle when last read" on a plain ground
instead of "Everything is idle". The tablet's sessions rail and idle pane do the same, and the
rail says "running when last read at 16:52". Cards and rows that wait on you keep their place and
wording; the connection banner already says nothing on screen is live.

Pairing again, typing a new address or token, or forgetting the daemon now drops the last state
the old daemon sent, so it no longer stands in for a new daemon that is silent or refuses.

Counts agree with their number: the header pill reads "1 needs you" and "2 need you", and the
tablet's work line reads "1 tool".
