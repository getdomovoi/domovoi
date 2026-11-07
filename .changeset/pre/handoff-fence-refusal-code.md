---
"@getdomovoi/daemon": patch
---

Refuse `system.serviceHandoffFence` off the loopback owner connection with
`localOwnerRequiredErrorCode` instead of the authentication code. The refusal
conditions and message are unchanged. A paired device or relay client that asks
for the fence no longer reads the refusal as a revoked credential, so its
connection stays open.
