---
"@getdomovoi/daemon": patch
---

Bound `domovoid pair` and `domovoid open` with one 15-second deadline that starts before the
socket exists and covers connect, `system.hello`, and the call itself. A listener that accepts
the connection and then says nothing is refused instead of holding the terminal forever, and so
is a peer that completes the handshake and then stalls mid-call. Neither command can obtain a
fresh allowance for a later phase.

The refusal names the address that was waited on, which wait expired, and the remedy: check that
domovoid is running at that address, then run the command again. `domovoid pair` repeats that
refusal rather than its generic line, while every other daemon error stays generic so nothing
quotes the request back to the screen. A refused command drops the transport instead of asking a
stalled peer for a close handshake, but disposal remains Node's: a connection stalled inside a
TLS handshake can outlive the refusal.
