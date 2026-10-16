---
"@getdomovoi/desktop": patch
---

The desktop package ships a daemon runtime beside the app: Node 24.21.0, pinned by its published sha256 per platform and trimmed to the program, and the daemon with its production dependencies. The app copies it under the profile when it installs the login service. Packaging proves the shipped daemon runs by asking it for its version under the shipped Node. A shipped runtime that is missing or does not load stops startup with Domovoi could not start, naming its path and what is missing.
