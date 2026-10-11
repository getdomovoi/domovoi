---
"@getdomovoi/daemon": patch
---

`DOMOVOI_TAILNET_HOST` is checked as the URL parser reads it: a name the parser
rewrites into another host, such as `1.0x0` (1.0.0.0) or `127.0x1`
(127.0.0.1), is refused, as is any name that parses to a loopback or wildcard
address. The tailnet certificate and key are not read when either is larger
than 64 KiB; the tailnet listener alone is refused.
