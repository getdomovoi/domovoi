---
"@getdomovoi/daemon": patch
---

OpenCode and Kilo approval cards name the tool server a call belongs to. When a session's directory
opens, the daemon reads the names of the tool servers that directory knows; a card for a tool whose
name only one of those servers could have made carries that server as its tool server fact, which
also takes Always off the card. A tool of the server's own, or one two servers could have made,
names none.
