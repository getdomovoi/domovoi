---
"@getdomovoi/web": patch
---

A protocol refusal while pairing a browser tab now names the side that is older, from the daemon's own compatibility answer. When the daemon is ahead, the card says the page is older and offers Reload this page. When the daemon is behind, it says to update Domovoi on that machine, then show a new code and type it, and offers Type a new code: the daemon checks the version before spending a code, so this code was not used, but the update restarts the daemon and drops it. When the daemon does not say, the card says the versions differ and offers nothing. Before, every protocol refusal said the page was older. Every other refusal still offers Type a new code.
