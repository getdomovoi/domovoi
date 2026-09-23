---
"@getdomovoi/daemon": patch
---

Terminal redaction now reads a line the way it reads on screen. ANSI formatting between a
sensitive name and its value no longer hides the assignment. A carriage return or cursor move
that redraws a line in place no longer starts a new line for redaction, so a value written after
a name by a redraw is still redacted; a line ends at a newline. A bare token longer than the
8,192 characters a line keeps is dropped up to its end instead of showing its tail. Formatting
and redraws around a redacted value are kept.
