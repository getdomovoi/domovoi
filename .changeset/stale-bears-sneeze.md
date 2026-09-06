---
"@getdomovoi/protocol": patch
"@getdomovoi/daemon": patch
"@getdomovoi/ui": patch
---

Add separate, kind-bound remote client grants and verified client admission primitives. A machine pairing remains daemon-to-daemon authority, not permission for a desktop or browser to control the target.

Operators can issue a separate client credential on the target with `domovoid pair --client desktop --label "My desktop"`. Update both daemons and the client before using the new route and credential-verification calls. Existing pairings remain valid and no re-pair is required. The Fleet controls and Desktop origin admission still need their interface integration; these primitives alone do not enable them.

