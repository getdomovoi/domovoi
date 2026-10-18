---
"@getdomovoi/ui": patch
---

When tailnet reach is on but neither the desktop nor the daemon can read a certificate, as after the Domovoi profile directory was removed or replaced, the "not answering on the tailnet" alert offers "Get the certificate again" instead of "Renew now". It runs the same turn-on: Tailscale is asked for this machine's certificate again, the pair is stored in the profile, and the daemon restarts.
