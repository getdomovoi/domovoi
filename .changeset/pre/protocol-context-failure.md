---
"@getdomovoi/protocol": minor
"@getdomovoi/ui": minor
---

Add a `context-window-exceeded` provider failure with a `shorten-context` action.
A turn that outgrows the model context window is not retryable, so it no longer
falls through to the retryable unknown failure, and the client tells a person to
shorten the turn or start from a checkpoint instead of offering a retry.
