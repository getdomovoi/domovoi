---
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
---

The workspace dock's Terminal tab no longer sends a terminal request from a phone or tablet tab
that the daemon refuses for that credential. A phone or tablet credential may use terminal.list,
terminal.watch and terminal.unwatch only. The daemon answered terminal.create with an
authentication error, and the client then closed its connection, so the tab dropped. In a phone
or tablet tab the Terminal tab now reads the session's shell through terminal.watch, and one line
says why opening, typing, resizing and taking the shell are off and names the desktop app as the
place to do it. Desktop and web tabs are unchanged.
