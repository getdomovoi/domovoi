---
"@getdomovoi/daemon": patch
"@getdomovoi/ui": patch
---

The daemon inside the desktop app can start Claude, and the OpenCode and Kilo servers: their process keeper now runs on the app's executable as Node (ELECTRON_RUN_AS_NODE) instead of starting a second copy of the app, which quit at once. A model list that still cannot be read is no longer reported as "Internal daemon error": the daemon answers with the classified reason, and the launcher and the composer's model chip say "Domovoi could not read the model list from <harness>." with that reason. The launcher offers Try again.
