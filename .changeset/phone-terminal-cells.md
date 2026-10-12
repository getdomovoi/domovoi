---
"@getdomovoi/mobile": patch
---

Read a watched terminal's output as lines of cells on the phone.

A wide character, CJK or a wide emoji, now takes two cells and a combining mark none, so a
carriage return, backspace, tab or erase over them draws what a terminal draws: `界b\rXY` reads
`XYb`, not `XY`. Moves along the line (CSI C, D, G, `, a) and erase, delete and insert characters
(CSI X, P, @) act on cells instead of being dropped. The payloads of device control strings, such
as sixel graphics, and of SOS, PM and APC strings draw nothing, and a character set choice such as
`ESC ( B` no longer draws as text. Widths come from a table generated from Unicode 17.0.0 by
`apps/mobile/scripts/terminal-cell-widths.mjs`, with no new dependency. The phone still draws
lines rather than a screen: a move to another row is dropped, so a full-screen program reads as
its text in order.
