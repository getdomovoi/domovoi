---
"@getdomovoi/daemon": patch
---

Stop reporting every cached Claude turn as failed.

Anthropic reports cache reads and cache writes beside `input_tokens` rather than
inside it, so a normal cached turn reports something like 4 input tokens next to
21,393 read from cache. The normalized counters treat cached input as part of
input, so `normalizeUsage` refused the turn with "Cached input tokens cannot
exceed input tokens" after the reply had already been delivered. The session went
to `failed`, the thread showed "Provider request failed", and the desktop raised
"Agent work failed" on every response.

`normalizeProviderUsage` now folds `cache_read_input_tokens` and
`cache_creation_input_tokens` into the input count, which is what the provider
billed. Only Anthropic reports those two names, so no other payload shape moves.

Second, a usage counter that does not add up no longer fails a delivered turn.
The Claude adapter drops the unusable readout and reports the turn as what it
was, because usage is a readout and not the work.
