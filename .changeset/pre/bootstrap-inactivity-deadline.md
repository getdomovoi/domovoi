---
"@getdomovoi/daemon": patch
---

Bound bootstrap HTTPS inactivity to 30 seconds of network waiting between non-empty body chunks,
inside the existing five-minute installation deadline. Headers, redirects, and empty chunks do
not renew the allowance; local disk backpressure remains bounded by the original total. Embedded
callers can set a positive integer `inactivityTimeoutMs`.

Abort fetch and reject late results with `BOOTSTRAP_DOWNLOAD_INACTIVE`, an origin-only diagnostic,
and a connection-check remedy. Cancellation does not promise immediate runtime socket disposal:
a stalled TLS connection can delay process exit until Node's own connect timeout. No expired
download may proceed to publication or installation.
