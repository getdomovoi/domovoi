---
"@getdomovoi/ui": minor
---

Move session usage out of the thread header into v2's usage chip beside the
composer. The chip names token counts only: the context the next turn runs in,
or the session's total when the provider reports no context. It opens rows for
the last turn, the session, the context share and today's count. It shows no
cost until the wire says whether a session runs on a subscription or an API key.
