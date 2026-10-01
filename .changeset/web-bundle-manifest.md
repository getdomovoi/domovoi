---
"@getdomovoi/protocol": patch
---

The protocol package gains the web app bundle manifest, `domovoi-web.json`: its schema, the path and extension rules, the size bounds and the protocol compatibility rule, so the web build that writes it and the daemon that reads it share one definition. It is not wire and changes no protocol version.
