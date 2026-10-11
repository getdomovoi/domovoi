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
Joining or rejoining a paused terminal preserves that pause. The reply excludes queued
output from its replay, so that text arrives once through the live stream after resume.
Live joins also stop draining when delivery first pauses, retaining queued resize markers
until low water. Same-client ownership moves through input deliver pending text to the
new connection even though the input reply carries no replay.
Reopening a same-client terminal with new dimensions captures its replay before resizing,
so synchronous redraw output arrives only live, after the resize marker. The create reply
reports the dimensions at the start of its queued live suffix when the connection follows
resizes; other create replies report the new dimensions. A following watch reply also
reports the starting grid of its queued suffix. Resize boundaries are retained even when
no follower exists yet, so a follower joining during a pause receives old-grid output
before the notice that advances it to the new dimensions. Without an eligible follower,
resize boundaries wait for normal batch delivery instead of flushing partial output early.
A retained boundary can split an output notification at that delivery, preserving the
old-grid and new-grid ordering needed by a follower that joins before the queue drains.
An empty replay has no start timestamp; if queued output exceeds retained history,
the watch reply reports that earlier output was dropped.

Protocol version remains `0.8.0`; new fields are optional and older watch requests receive
no resize notifications.

The desktop and browser terminal pane and the phone's terminal view read `claimHeld` from an
ownership notice. After a release they say nobody holds the shell, and the former holder's pane
stops sending input until it takes the shell again. A notice without `claimHeld` still means held.
