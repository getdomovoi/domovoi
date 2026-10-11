---
"@getdomovoi/daemon": patch
---

Report OpenCode and Kilo reasoning effort as unset to reflect the model's own setting. Stored medium and none values read as unset, and runtime changes normalize these legacy labels without sending an effort override.
