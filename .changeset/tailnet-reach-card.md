---
"@getdomovoi/ui": minor
---

Desktop Settings draws "Reach this machine from my tailnet" as a row of the
daemon card: no tailnet, off with what turning it on changes and what Domovoi
never touches, turning on and off with the steps in order, on with the tailnet
name, the certificate's expiry and where the daemon answers, a failed renewal,
a daemon not answering on the tailnet in its own words, and a hand-set
`DOMOVOI_HOST` that keeps the settings out. It claims reach only while the
daemon's `tailnet.status` says it listens, and says when that is not known. The
pairing card's "Go to the tailnet setting" leads to it, and "Get it from
Tailscale" turns it on. A login service installed while the switch is on keeps
the tailnet listener.
