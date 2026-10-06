---
"@getdomovoi/ui": patch
"@getdomovoi/desktop": patch
"@getdomovoi/web": patch
---

The desktop approval card is drawn as the Desktop v2 design draws it. It heads Waiting on your
decision with a pulsing dot, names the agent and mode on the meta line, and adds hard gate there
for a hard gate in place of the badge. The command is larger, the decisions are taller, and the
facts sit under the decisions in three columns behind What does this touch?. The facts start
open, so every fact is on screen until a person folds them, and they open again when the daemon
revises the gate. A watching client can still open and fold them, and so can someone writing a
denial note. The web card keeps its own header with every fact open. A refused decision, such
as a checkpoint the daemon could not take, shows in the card with a danger dot.

Decision receipts are toned as designed: an allow reads green and a denial red, each with a dot,
and the body reads the checkpoint first and the rule second. A rule receipt now says later runs
under the rule do not take a checkpoint, since only a person's allow takes one.

The policy refusal card says there is nothing to approve, puts the rule it broke in its own block
with who set it and where it applies, and lists the daemon's remedy under What you can do
instead.
