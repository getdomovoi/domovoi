---
"@getdomovoi/mobile": patch
---

A message that fails to send shows its reason only on the session it was sent to, and keeps it there.
A failure that arrived after the person had moved to another session used to show on that session's
composer, and moving between sessions cleared it, so coming back to the session showed nothing while
the message was gone. The reason now stays with its session until the person types, sends again or
changes the skills there.
