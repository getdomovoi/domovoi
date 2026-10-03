---
"@getdomovoi/ui": patch
---

When the daemon refuses a decision on an approval gate, for example because it could not take the
checkpoint an allow needs, the refusal now appears inside the gate card in the daemon's words
instead of as "Agent request failed" above the composer. Deciding again clears it. A failure that
never reached the daemon, such as a closed connection, still shows above the composer, and so does
a refusal for a gate that is no longer on screen, for example one the agent stopped waiting on.
