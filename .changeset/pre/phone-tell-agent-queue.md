---
"@getdomovoi/mobile": patch
---

Tell the agent on a policy refusal now says what it does during a running turn. When a message is
already queued for the next turn, the refusal says the remedy replaces it and shows the queued
message with its cancel. After the tap it says Sent. It will reach the agent when this turn ends.
when the message went as the next turn's, or Sent to the agent. when it went straight to the
session, read from how it was sent rather than from the turn's state at redraw, because the thread
that would show the message is not drawn under a refusal. When the turn ended before the message
arrived and the daemon held it, the refusal says Held. It will not reach the agent on its own., and
the queued message beside it gives the daemon's reason.
