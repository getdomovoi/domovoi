---
"@getdomovoi/daemon": patch
---

On macOS, removing the login service now waits for the stopped daemon to let the profile go before it removes the agent and its configuration.
