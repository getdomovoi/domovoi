---
"@getdomovoi/mobile": patch
---

Tell the agent on a policy refusal now says what it does during a running turn. When a message is
already queued for the next turn, the refusal says the remedy replaces it and shows the queued
message with its cancel. After the tap it says Sent. It will reach the agent when this turn ends.,
or Sent to the agent. when no turn is running, because the thread that would show the message is not
drawn under a refusal.
