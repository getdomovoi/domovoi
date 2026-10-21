---
"@getdomovoi/ui": patch
---

Below 640 px the open sessions column covers the thread instead of squeezing it to about 120 px.
While it covers the thread, everything it covers is inert: a covered approval card's Allow once
takes no focus, Tab, key press or tap, including when the tab narrows with focus already on it, in
which case focus moves to the Sessions button in the same commit that draws the cover. Escape, a tap
on the uncovered strip or choosing a session closes the column and returns focus to the Sessions
button. The lost-daemon banner stays above it, and a waiting approval shows in its NEEDS YOU group.
At 640 px and wider nothing changes.
