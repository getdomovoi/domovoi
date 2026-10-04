---
"@getdomovoi/daemon": minor
---

Surface provider rate limits, expired authentication, exhausted quota, and missing
model access as their own classified failures. The Claude adapter kept a bounded,
redacted tail of provider stderr and preserves the reported error text, so these
conditions no longer reach a client as unknown or retry.
