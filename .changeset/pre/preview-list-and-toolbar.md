---
"@getdomovoi/ui": patch
---

The Preview tab lists every render of the session under RENDERED THIS SESSION, one row per
variant group, so a preview rendered earlier than the newest variant group can be opened again.
Before, the dock anchored on the newest preview and an older one could not be reached at all.

The toolbar follows the design: an authorized chip with the grant's time left, sm, md and lg
widths (lg, full width, is the default), and Add a comment, which reads Click an element while the
picker is on. Print view, Download safe copy, Compare, the variant thumbnails, the Live note and
the safe-copies line sit behind one More preview actions control. Variants switch from chips at
the foot of the page.

Preview grants last 60 seconds. While the preview is on screen the client now asks for a new grant
five seconds before the current one ends, without reloading the page shown, and a frame that
mounts later loads a fresh grant. Before, opening fullscreen or coming back to the Preview tab more
than a minute after the page loaded showed an expired-grant refusal instead of the page. A hidden
preview asks for no grants, including a dock that opens on another tab. A failed request is retried
after 1 second, doubling to one try every 30 seconds, and showing the preview again asks at once. A
frame with nothing loaded and only a lapsed grant shows the renewal error.

The grant's expiry is the daemon's clock. The dock reads it with the signing daemon's clock offset
from the fleet's daemon time (the attached machine's when the window is attached), and never treats
a grant as shorter than 10 seconds from receipt, so a client clock ahead of the daemon's does not
renew in a loop.

The list draws the newest 50 renders and earlier ones 50 at a time on request, always including the
render on screen. The footer under the page shows whenever the session has more than one render, so
a lone render can be chosen as the build basis, and it names a basis that sits in another render
("Variant A in replay") instead of showing a variant of the render on screen as the basis.

Fullscreen is a full surface with the widths, Exit fullscreen with esc, the variant chips and a
comments column. Adding a comment works in fullscreen: the element is picked in the fullscreen
frame and the comment is drafted and posted in the column. Before, the picker only reached the
dock's frame.

Every preview frame is rendered by one component that fixes the sandbox to scripts only.
