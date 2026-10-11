---
"@getdomovoi/ui": patch
---

The History tab on web and desktop draws a sent message's over-limit note on its row, in the
thread's words: "1 open annotation was over the per-turn limit" or "N open annotations were over the
per-turn limit". It reads the entry's `annotationsOverLimit`; a message recorded without it draws no
note, as before.
