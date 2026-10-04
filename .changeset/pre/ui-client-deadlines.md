---
"@getdomovoi/ui": minor
---

Bound every wait on a daemon or another machine with one shared deadline. The
browser client now requires connect and request budgets, so a socket that never
opens or a hello that never answers fails as a typed timeout at the connect
budget instead of waiting forever, and a request can carry a caller's deadline
which the client's own budget can only tighten. Reconnect attempts each get the
full connect budget and a timed-out attempt is torn down before the next one.
Claiming a pairing code, greeting the new machine, and storing its credential
share one pairing deadline, as do the transport candidates dialed to reach
another machine. `DomovoiRequestOptions.timeoutMs` is replaced by `deadline`.
