---
"@getdomovoi/protocol": patch
"@getdomovoi/ui": patch
---

The preview frame's anchor messages keep a comment's ID exactly as stored, with the same 256 code unit bound, so a padded or whitespace-only ID resolves its anchor instead of being rejected.
