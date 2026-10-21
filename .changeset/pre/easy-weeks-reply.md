---
"@getdomovoi/daemon": patch
---

Sum distinct Codex response receipts across each turn, including observed compaction requests and child-agent responses explicitly attributed by rootTurnId. Count attributed child responses even after the root finishes. Keep usage partial because Codex can retry without reporting every billed attempt. Preserve live fallback counts for resumed threads and keep context estimates separate from token expenditure.
