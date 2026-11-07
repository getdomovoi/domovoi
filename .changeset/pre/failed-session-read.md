---
"@getdomovoi/ui": patch
---

Opening a session that the daemon does not answer for (no answer in time, the connection closed, or an answer the client cannot read) now draws Could not read this session in the thread column, for the session asked for, instead of leaving the previous session's thread on screen. It says how the read ended, how many reads this client sent, and what it tried, with Try again and Open the machine; both work in phone and tablet tabs. The workspace alert still reports every failed open, as before. A daemon that answers and refuses shows in the alert only.
