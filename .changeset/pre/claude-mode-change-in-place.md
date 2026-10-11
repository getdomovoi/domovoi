---
"@getdomovoi/daemon": patch
---

Keep the Claude conversation across a mode change; a reopen happens only for an ended session, resumes only a started one, and a failed reopen leaves the thread usable.
