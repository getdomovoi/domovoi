---
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
---

The machine chip names the route the client dialed: loopback, tailnet (a ts.net
name or a Tailscale address only), direct over TLS or plaintext, never local. The browser limits page
reads the route by the same rule, so IPv6 loopback reads loopback and a LAN host
is not called the tailnet. The theme toggle stays live while watching. Drawer
rows draw the machine, the state and how long it has held (running 12m, failed
1h ago, idle 2d). The web opens the sessions column by default at wide widths.
