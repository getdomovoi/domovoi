---
"@getdomovoi/daemon": patch
---

Terminal redaction reads a line as it reads on screen. Formatting and other
control sequences between a sensitive name and its separator no longer let the
value through, and the span that is hidden is written back in place, so
formatting around it is kept. A carriage return after a name and separator
that are still waiting for their value no longer ends the wait, so a value a
redraw writes after the prompt is hidden. A bare token longer than the 256
characters the terminal carries no longer shows its tail, and a bare token cut
by an idle beat no longer shows the part typed after the beat. A backslash
inside single quotes escapes the next character in the terminal's own value
readers too, so an escaped quote does not end the value. Everything is read as
before first; these rules only hide more.
