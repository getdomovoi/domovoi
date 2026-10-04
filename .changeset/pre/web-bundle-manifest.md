---
"@getdomovoi/protocol": patch
---

The protocol package gains the web app bundle manifest, `domovoi-web.json`: its schema, the path and extension rules, the size bounds and the protocol compatibility rule, so the web build that writes it and the daemon that reads it share one definition. Paths are ASCII, refuse a trailing period and Windows device names in any segment, and must differ under case folding. It is not wire and changes no protocol version.
