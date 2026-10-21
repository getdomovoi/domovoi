---
"@getdomovoi/daemon": patch
---

The instruction files Domovoi reads for a session are now parsed as CommonMark
(`mdast-util-from-markdown`), and `@path` imports are taken from text only, never from code blocks,
code spans or raw HTML. Fences inside list items, code spans after an escaped backtick, and indented
code right after a heading no longer load an import, and an import after such a fence is no longer
lost.
