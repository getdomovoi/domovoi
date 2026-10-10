---
"@getdomovoi/ui": minor
---

The terminal pane offers Release the shell to the device that holds it. The shell keeps running with
nobody holding it, the banner says so, and any device can take it. A shell held elsewhere reads
Claimed by <holder> since <time>, from the daemon's claim time, with the day for a claim taken
before today; a daemon that sends no claim time leaves the line at the holder.

A watching desktop asks `terminal.watch` for `followResize` and redraws at the holder's grid when
`terminal.resized` arrives, after the output printed before it. A daemon that refuses the field
is watched without it, and the pane keeps reading the grid from `terminal.list` every 5 seconds.
The pane still reads `terminal.list` on that interval for the holder, because the daemon sends no
notice when the holder's connection drops. A desktop that opened the shell and no longer holds it
also still takes the grid from that read.
