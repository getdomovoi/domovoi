---
"@getdomovoi/mobile": patch
"@getdomovoi/protocol": patch
---

The phone's thread follows a reply only when the person is already at the bottom. Scrolled up
to read an earlier turn, the viewport holds still while new output lands, and a pill above the
composer offers the ride back: "3 new" with a primary dot, or "Waiting on you" on the warning
ramp with a pulsing dot when a decision arrived below. 44px tall for a thumb. Before, every
growth of the thread scrolled to the end regardless of where the person was.

`threadFollowState` and `threadFollowPillText` live in `@getdomovoi/protocol` so every surface
with a thread derives the same three states.
