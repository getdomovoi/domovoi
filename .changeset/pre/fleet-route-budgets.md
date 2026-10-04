---
"@getdomovoi/daemon": patch
"@getdomovoi/ui": patch
---

Reserve time for fallback routes inside one overall fleet dial deadline. Each eligible route gets
a share of the remaining time for connection and authenticated hello, so a silent first endpoint
cannot consume every later route's allowance. Cancel abandoned attempts, reject late results, and
retain typed timeout refusals naming a sanitized address instead of arbitrary transport error text.
