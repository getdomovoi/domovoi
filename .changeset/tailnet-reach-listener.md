---
"@getdomovoi/daemon": minor
---

Add an optional second listener on this machine's Tailscale address, beside the
loopback one. Set `DOMOVOI_TAILNET_ADDRESS`, `DOMOVOI_TAILNET_TLS_CERT_PATH` and
`DOMOVOI_TAILNET_TLS_KEY_PATH` together, with `DOMOVOI_ALLOW_REMOTE_TRANSPORT=1`
and a loopback `DOMOVOI_HOST`. The address must be in 100.64.0.0/10 or
fd7a:115c:a1e0::/48. The listener serves TLS only, on the loopback listener's
port, with the same authentication as any non-loopback listener. The saved
service configuration keeps it as `tailnetListener`.
