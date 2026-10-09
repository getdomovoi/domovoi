---
"@getdomovoi/daemon": minor
"@getdomovoi/protocol": minor
"@getdomovoi/ui": patch
"@getdomovoi/mobile": patch
---

Add explicit terminal claim release, claim timestamps, and opt-in resize notifications.
Released shells keep running unheld and require a new claim before input, resize, or close.
Preserve claim times across reconnects, report `claimHeld` on ownership changes, and send
`terminal.resized` only to watchers that request `followResize`.

Resize notifications coalesce to the latest dimensions once per terminal output batch
and wait for slow readers to drain. They wait for the quiet redactor beat before flushing
output and sending the size. Under continuous output with no quiet beat, an unpaused resize
goes out after at most 4 extra beats, and text the redactor still retains can follow it.
Closing a terminal drops its pending resize.

Protocol version remains `0.8.0`; new fields are optional and older watch requests receive
no resize notifications.

The desktop and browser terminal pane and the phone's terminal view read `claimHeld` from an
ownership notice. After a release they say nobody holds the shell, and the former holder's pane
stops sending input until it takes the shell again. A notice without `claimHeld` still means held.
