---
"@getdomovoi/mobile": patch
---

The phone's thread follows a reply only when the person is already at the bottom. Scrolled up
to read an earlier turn, the viewport holds still while new output lands; back at the bottom,
following resumes. Before, every growth of the thread scrolled to the end regardless of where
the person was. `PageScroller` reports the flip through `onAtEndChange` for a screen that wants
to offer the ride back.
