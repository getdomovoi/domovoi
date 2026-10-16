---
"@getdomovoi/protocol": minor
---

Add the `approval-answered-elsewhere` provider failure (action `review-changes`, not
retryable). A daemon sets it when a provider server reports an approval reply the daemon
did not send and the daemon stopped the session for it. The approved call may already
have run, so a client tells the person to review the session's changes rather than retry.
`ProviderFailure` is now a named type so declaration output stays within what the
compiler will serialize.
