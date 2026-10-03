---
"@getdomovoi/ui": patch
---

When the daemon refuses a decision on an approval gate, for example because it could not take the
checkpoint an allow needs, the refusal now appears inside the gate card in the daemon's words
instead of as "Agent request failed" above the composer. Deciding again clears it, and it leaves
with the card when the gate is answered elsewhere and its receipt appears. When the gate leaves with
no receipt, because it was withdrawn or the agent stopped waiting, the refusal moves above the
composer. A failure that never reached the daemon, such as a closed connection, still shows above
the composer, and so does a refusal that arrives after its gate has gone.
