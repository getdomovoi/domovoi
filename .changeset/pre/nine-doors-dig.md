---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
---

Send up to two bounded PNG or JPEG images with a session prompt. Refuse image sends when the adapter lacks vision support; keep uploads out of daemon persistence. Raise bounded authenticated RPC messages to carry both images over direct and encrypted transports. Advertise optional sessionImageAttachments support in system.hello so clients can refuse image sends to older daemons.
