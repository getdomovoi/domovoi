---
"@getdomovoi/daemon": patch
---

Terminal redaction adds a second stage after the existing one, which runs
unchanged first. The second stage reads the terminal output as it reads on
screen: control sequences and control characters, OSC strings among them, are
not part of the line, a carriage return after a name and separator that are
still waiting for their value does not end the wait, and idle beats do not
matter. It hides the values those names take and the rest of a bare token
after its prefix, however long, and it only ever removes characters from what
the first stage shows. Formatting between a sensitive name and its separator,
a value written after a redraw, a bare token longer than the 256 characters
the terminal carries, and a bare token cut by an idle beat no longer show.
