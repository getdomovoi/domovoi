---
"@getdomovoi/ui": patch
---

The approval card no longer looks answerable while this client is disconnected from the daemon.
Allow once, Always, Deny and both denial buttons are disabled until the connection is back, and the
card says "Cannot answer this gate while this client is disconnected from the daemon." A denial
explanation already being written is kept.
