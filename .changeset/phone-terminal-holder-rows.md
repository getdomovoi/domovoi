---
"@getdomovoi/mobile": patch
---

Keep a shell command and its output on their own lines in the phone's terminal view.

When what is typed, or a zsh-autosuggestions suggestion after it, runs past the holder's grid,
zsh moves up and down between the rows it wraps into, and on Enter reaches the next row with a
move down and a carriage return instead of a line break. The phone dropped every move to another
row, so the command's output printed over the command line ("fetzy    whoami" in the walk). The
phone now reads a long line as the rows the holder's grid wraps it into: a carriage return goes to
the start of the cursor's row, an erase in line erases that row, moves up and down follow the
rows, and a move down past the line starts the next line. Lines still wrap at the phone's own
width. Full-screen programs that move anywhere on the screen are still not drawn.
