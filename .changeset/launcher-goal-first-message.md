---
"@getdomovoi/ui": patch
---

The desktop and web launcher now sends the session goal as the new session's first message, as the
design's launcher starts the agent on the task typed there. Before, the goal only named the
session, and the session sat idle until a message was sent, with nothing in the launcher saying
so. The field now says the goal is also the first message and names the mode that turn runs in.
The message goes through the session's queue, so a send that fails shows in the thread, and a
session the daemon did not create sends nothing.
