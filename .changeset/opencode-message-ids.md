---
"@getdomovoi/daemon": patch
---

OpenCode and Kilo sessions can send prompts again. OpenCode 1.18 and Kilo 7.7 refuse a message id
that does not start with `msg` ("Expected a string starting with \"msg\""), and the adapter sent a
random UUID with every prompt and steer, so every send failed with HTTP 400. The adapter now makes
ids in the servers' own ascending scheme: `msg_`, the milliseconds times 4096 plus a counter as
twelve hex digits, then fourteen random base62 characters, so they also sort with the ids the
server makes.

Each id also sorts after the last one the daemon made, when the clock steps back or a millisecond
runs out of counter values, and after the newest message the session already holds: on resume the
adapter reads the greatest id in the session's whole history, a page at a time, and it follows
every message id the server reports.

When a session already holds a message at the last order the servers' 48-bit field can hold, no
id can sort after it, so the next prompt is refused with "OpenCode session has used the last
message id the server can order, so it cannot take another message" (or the Kilo name) instead
of sending an id that wraps to zero and sorts first. One such session does not stop ids for the
others.
