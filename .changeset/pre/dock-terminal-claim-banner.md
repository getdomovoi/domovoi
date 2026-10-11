---
"@getdomovoi/ui": patch
---

The dock's Terminal tab draws who holds the shell: You hold this shell, Claimed by the holding device's label, or Nobody holds this shell, with Take the shell for a device that can take it. A pane that does not hold the shell draws it at the holder's grid. The tab's tip and footer no longer say the agent owns a read-only shell (Q340 A): the tab is an interactive shell a person opens, one device types at a time, and the others can read.

The pane can also read a shell through terminal.watch, with Take the shell disabled and the reason beside it, and hand what it shows to that session's composer as terminal-output.txt (Attach this output to the composer). A watched record that does not start at the shell's start says so, beside the stream and at the top of the attachment. Given terminal.list, a pane that does not hold the shell rereads the holder and its grid every 5 seconds, because the daemon sends no notice when the holder disconnects or resizes. None of this reaches a person yet: until the workspace passes the watch controls and the thread opens its composer to the terminal, a watching desktop keeps its Watching only state and the attach button stays hidden.
