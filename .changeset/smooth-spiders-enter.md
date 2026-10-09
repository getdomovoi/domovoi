---
"@getdomovoi/daemon": minor
"@getdomovoi/protocol": minor
---

Add explicit terminal claim release, claim timestamps, and opt-in resize notifications.
Released shells keep running unheld and require a new claim before input, resize, or close.
Preserve claim times across reconnects, report `claimHeld` on ownership changes, and send
`terminal.resized` only to watchers that request `followResize`.

Resize notifications coalesce to the latest dimensions once per terminal output batch,
wait for slow readers to drain, and follow output already printed. Closing a terminal
drops its pending resize.

Protocol version remains `0.8.0`; new fields are optional and older watch requests receive
no resize notifications.
