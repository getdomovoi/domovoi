---
"@getdomovoi/daemon": patch
---

An IPv4-mapped IPv6 address counts as loopback only inside 127.0.0.0/8. The check matched any
mapped address whose hex began with `7f`, so `::ffff:7.240.0.1` was treated as this machine when
classifying routes, choosing which routes to dial and checking a tailnet host.
