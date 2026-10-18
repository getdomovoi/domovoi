---
"@getdomovoi/ui": patch
---

When tailnet reach is on but the stored certificate cannot be read, as after the Domovoi profile changed, the "not answering on the tailnet" alert offers "Get the certificate again" instead of "Renew now". It runs the same turn-on: Tailscale is asked for this machine's certificate again, the pair is stored in the profile, and the daemon restarts once.
