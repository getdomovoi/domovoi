---
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
"@getdomovoi/desktop": patch
---

The "Could not read this session" state shown when a provider stops no longer says "nothing was written, nothing was lost". A provider can write files before it stops. The line now shows only where a caller states the failure only read.
