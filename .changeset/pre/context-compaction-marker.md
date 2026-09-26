---
"@getdomovoi/protocol": patch
"@getdomovoi/ui": patch
"@getdomovoi/mobile": patch
---

Mark the point where a provider compacted its context. A system thread row can now carry a context-compaction notice, and clients draw that row as a boundary in the transcript rather than as a general system banner. The copy states both halves of what happened: the provider stopped reading the turns above it, and Domovoi still holds them. A snapshot written before the notice existed keeps parsing, and every other system row keeps its existing styling and detail line.
