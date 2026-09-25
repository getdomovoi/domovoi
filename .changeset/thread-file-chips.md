---
"@getdomovoi/ui": patch
---

Name the files a turn touched in the thread. A finished run of tool calls now
carries a chip per file with the lines it added and removed, and a chip that
opens the full review. Counts appear only where the provider reported a diff,
and the review chip states the true total even when the row lists fewer files.
