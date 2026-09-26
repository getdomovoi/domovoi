---
"@getdomovoi/daemon": minor
---

Add explicit TLS tailnet advertisements and source-local configured SSH-forward routes. Services retain both settings. Machine authentication, route deadlines and forget masking still apply; removing SSH configuration removes that fallback after restart. Domovoi does not start SSH tunnels or add WSL or relay transports.

Loopback advertisements now reflect whether the listener uses TLS. Peers cannot enable a source-local route through their own SSH or loopback advertisements, including TLS loopback URLs.
