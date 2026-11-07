---
"@getdomovoi/protocol": patch
"@getdomovoi/daemon": patch
---

The phone and tablet grant list says what a paired phone can do with a terminal: "Read terminal output. It cannot type, resize or take the claim." It replaces "Terminal output is not on a phone yet.", which stopped being true when a phone could watch terminal output. The desktop pairing card, `domovoid pair` and the phone read the one list, so all three change together. `phoneAndTabletPromise` is now typed as a read-only list of lines with a `PhoneAndTabletGrantTone`, and no line is unbuilt.
