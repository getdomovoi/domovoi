---
"@getdomovoi/ui": patch
---

Desktop and web correctness. Attaching to another machine no longer drops the changes that arrived while the client was being admitted: the hello snapshot is applied once, before the buffered changes, and not again after them, on connect and on reconnect. Pause everything now says so when the daemon refuses the pause or cannot be reached, and keeps the local hold. Settings, Skills, Machines and the Audit log load when first opened instead of at launch, which takes about 76 KB off the web startup JavaScript.
