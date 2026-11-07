---
"@getdomovoi/mobile": patch
---

A session holding more than one approval counts its wait from the earliest of them, and its card in
the Sessions list opens that approval. The clock used to start at whichever approval the snapshot
listed last while the card opened the first listed.
