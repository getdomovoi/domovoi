---
"@getdomovoi/protocol": patch
"@getdomovoi/ui": patch
---

`modelDisplayName(modelId, harnessId)` derives a model's short name from its id: drop every
token the harness name already says, then replace hyphens with spaces. `claude-sonnet-4.6` under
`claude-code` reads `sonnet 4.6`; `gpt-5.3-codex` under `codex` reads `gpt 5.3`. A model that
arrives from `runtime.discover` needs no second name written for it.

The desktop and web model chip now reads `<harness> · <short name>`, and each row in the model
list shows the short name with the full id in mono beside it, because the id is what the audit
log and the provider's error say. A harness that did not report is absent from the filter row and
the list rather than greyed; one the snapshot called missing appears once discovery hears models
from it. The count line reads how many harnesses reported.
