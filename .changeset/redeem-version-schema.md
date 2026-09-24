---
"@getdomovoi/protocol": patch
"@getdomovoi/daemon": patch
---

`device.redeemCode` validates `protocolVersion` with the shared protocol version schema, like every other version reader. A noncanonical or overlong version (such as `01.8.0`) is now refused as invalid params with the request's id, instead of passing validation and failing inside the compatibility check as an internal error with `id: null`.
