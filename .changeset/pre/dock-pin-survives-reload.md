---
"@getdomovoi/ui": patch
---

Keep a pinned artifact dock open across a reload. The shell collapses the dock
when a window is too narrow to hold it beside the thread, and it read that
width from the first resize observation, which arrives before the shell has
been laid out and reports zero. An unmeasured shell now decides nothing, so a
pin survives a refresh on any window wide enough to honour it.
