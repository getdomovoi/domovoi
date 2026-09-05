---
"@getdomovoi/daemon": minor
---

Add explicit TLS tailnet advertisements and source-local configured SSH-forward routes. Services retain both settings. Machine authentication, route deadlines and forget masking still apply; removing SSH configuration removes that fallback after restart. Domovoi does not start SSH tunnels or add WSL or relay transports.
