---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
"@getdomovoi/ui": patch
---

A checkpoint the daemon takes before an allowed command now says why. `checkpointReasonSchema`
adds `before-approved-command`, and the daemon sets it on the checkpoint it records when a person
allows a gated command. The thread item and its session history entry carry it, so a client can
name the reason beside the time instead of showing only the time. Checkpoints recorded before
this change carry no reason, as before. The desktop checkpoints list reads it as "before an
approved command".
