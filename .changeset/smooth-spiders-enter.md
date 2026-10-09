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

Resize notifications mark their position in the output stream before the PTY is resized.
Already-redacted output queued before a resize is sent before the notice; output drawn
for the new grid follows it. Text the redactor still retains at the resize, including
complete lines, can follow the notice. Resizing does not release that text.
While output is paused for slow readers, adjacent resize markers coalesce to the latest
dimensions and wait for low water. Resizes with no eligible follower do not observe
backpressure. Closing a terminal flushes queued output and markers before its closed notice.

Protocol version remains `0.8.0`; new fields are optional and older watch requests receive
no resize notifications.

The desktop and browser terminal pane and the phone's terminal view read `claimHeld` from an
ownership notice. After a release they say nobody holds the shell, and the former holder's pane
stops sending input until it takes the shell again. A notice without `claimHeld` still means held.
