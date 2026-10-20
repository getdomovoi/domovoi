---
"@getdomovoi/daemon": patch
---

Sum distinct Codex response receipts across each turn, including observed compaction requests. Keep usage partial because Codex can retry without reporting every billed attempt. Preserve live fallback counts for resumed threads and keep context estimates separate from token expenditure.
