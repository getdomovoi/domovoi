---
"@getdomovoi/ui": patch
---

The thread sticks to the bottom only when it is already there. New output while the person
is at the bottom scrolls to the end; scrolled up, the viewport holds still and a pill above
the composer offers the ride back, reading "3 new" for output or "Waiting on you" when a gate
arrived below. A gate no longer moves the viewport: the approval card's `scrollIntoView` is
gone, and the pinned plan strip already announces a gate without hijacking scroll. Before,
the desktop never followed at all and the only scroll it did was the one that moved the
viewport under a person reading an earlier turn.
