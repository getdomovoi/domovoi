---
"@getdomovoi/desktop": minor
---

The desktop keeps each daemon's relay identity pin in a private main-process file under userData, replaced whole on every write; the renderer reads and writes one machine's pin by key over the bridge and never sees the path.
