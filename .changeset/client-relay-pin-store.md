---
"@getdomovoi/ui": minor
"@getdomovoi/web": patch
---

Browser and desktop clients can keep each daemon's relay identity pin. The shared store runs the protocol's recovery and adoption over any key-value storage with a per-storage write queue and read-back confirmation, one key per machine; the web keeps it in localStorage. Once a daemon has answered the hello, the client enrols the identity it publishes as trusted or recovers a distrusted pin from its signed successor, verified against the saved pin only. A refused relay.recovery leaves the saved pin unchanged.
