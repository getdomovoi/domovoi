---
"@getdomovoi/ui": patch
---

Read the viewport at most twice per frame while scrolling. A scroll gesture fires many events per frame, and both the thread follow hook and the floating surface measured layout on every one of them: three forced reads per event in `useThreadFollow`, and an anchor measurement plus a state update in `FloatingSurface`, the latter on a capture phase window listener that fires for every scrolling pane on the page.

Each now reads inline on the first event of a frame, drops the rest, and takes one trailing read on the next frame so the resting position is never missed. The follow pill and the surface position still answer the first event without delay, so there is no added latency at the start of a gesture. Tests pin the read count for a burst and pin the trailing read that lands the final position.
