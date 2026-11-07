---
"@getdomovoi/ui": patch
---

A browser tab 390 or 360 px wide, such as a phone, no longer draws the workspace wider than the
screen. The thread column took its content's width (562 px at 390) and the shell cut it off, so a
hard gate's approval card lost its right side: the agent and mode, part of the working directory and
"This tab holds the gate". The thread and Machines now shrink to the tab, and the paired devices
table scrolls sideways in its own box. Below 640 px the app bar collapses: tighter spacing, no
shortcut hint, the machine name truncates, the route word folds away while connected (unreachable
stays), the theme toggle leaves the bar for Settings, and a watching tab folds New session and Stop,
which it cannot use. The lost-daemon banner keeps its words on most of the line instead of one word
per line. The open sessions column still sits beside the thread, as before. At 640 px and wider
nothing changes.
