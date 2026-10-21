---
"@getdomovoi/desktop": minor
---

The desktop keeps each daemon's relay identity pin in a private main-process file under userData, replaced whole and synced to disk on every swap; the renderer reads one machine's pin by key and asks the main process to compare and swap it over the bridge, and never sees the path. A damaged file or one written by a newer desktop is refused, not emptied.
