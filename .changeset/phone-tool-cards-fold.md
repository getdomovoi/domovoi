---
"@getdomovoi/mobile": patch
---

Tool and command cards in the phone thread fold to one line.

A folded card is drawn as the design's tool row: a status dot, the command on one line, its
status and a chevron. A tap on the row opens the full command, and a tap again folds it. Settings
has a Tool cards row, Collapsed or Expanded, kept on the device with the appearance choice; a
fresh install starts collapsed. A card toggled by hand keeps that choice while the thread is open.
Approval facts never fold: receipts and the waiting-approval card are not tool rows, and while an
approval waits every running command stays open with no way to fold it. The tablet thread is
unchanged.

The composer no longer clips its placeholder while a turn runs. The send hint sits on its own line
under the input instead of beside it.

On iOS the composer rides above the keyboard. It is a floating bar, and the padding a
keyboard-avoiding view adds never moved it, so the thread shrank while the composer stayed under
the keyboard. The session screen now lifts it by the keyboard's reach, and the thread pads by the
bar's new footprint so a reader at the bottom keeps the latest content in view. Android is
unchanged.
