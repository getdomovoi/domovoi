---
"@getdomovoi/daemon": patch
---

The `domovoid` one-shot RPC client validates each frame with the JSON-RPC response schema before reading it. A `null`, number, array or notification frame is ignored instead of throwing inside the socket listener, a reply to the request that is not a well-formed response refuses without repeating its text, and `domovoid pair` validates the pairing code result instead of casting it.
