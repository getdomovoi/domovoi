---
"@getdomovoi/desktop": patch
---

Refuse Fleet routes whose normalized hostname cannot name one exact CSP source.
URL-valid semicolons and commas, including percent-encoded forms, could previously
authorize a different hostname when Chromium parsed the worker policy. These routes
now fail before a ticket is issued, rather than escaping or broadening the policy.

Use a normal DNS hostname or IPv4 route when admission reports that no client route
is available. No protocol change or re-pairing is required. Existing exact origins,
ports and URL-normalized internationalized names retain their behavior.
