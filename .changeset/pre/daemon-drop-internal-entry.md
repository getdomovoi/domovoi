---
"@getdomovoi/daemon": minor
---

Remove the `@getdomovoi/daemon/internal` entry point. It exported only two types that the main
entry already exports, and no npm release carried it, so `@getdomovoi/daemon` is now the
package's only entry point.
