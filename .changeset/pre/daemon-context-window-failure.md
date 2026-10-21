---
"@getdomovoi/daemon": minor
---

Classify a turn that outgrows the model context window as
`context-window-exceeded` rather than a retryable rate limit or unknown failure,
and keep a usage limit written with the words spelled out classified as a rate
limit.
