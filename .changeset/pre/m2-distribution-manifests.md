---
"@getdomovoi/protocol": patch
"@getdomovoi/daemon": patch
---

Verify a canonical release inventory as a distinct TUF target and generate architecture-specific desktop casks from its authenticated identities. Existing daemon target verification and checksum bootstrap remain compatible. Embedding callers of the new inventory APIs must supply their independently trusted root, expected release identity, and durable trusted-metadata persistence. Real signing and channel publication remain separate operator work; no automatic migration or live publisher integration is introduced.
