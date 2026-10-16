---
"@getdomovoi/daemon": patch
---

Serve artifacts under the names a TLS listener answers to. A main listener bound to an address
with TLS, as in the tailnet setup that binds the tailnet address or `0.0.0.0`, answered
`/artifacts/` only when Host named the bound address, while every client sends the certificate's
name. Previews over that name returned 404.

Artifact requests now answer to the same Host authorities as the web app: the bound address,
`localhost` on a loopback bind, each DNS name on the certificate, and the advertised names that
listener carries (`DOMOVOI_ADVERTISE_HOST`, and `DOMOVOI_TAILNET_HOST` unless the separate tailnet
listener is on), each with the listener's port. A wildcard address such as `0.0.0.0` or
`::` is a Host neither artifacts nor the web app answer to, however the bind or an advertised name
spells it (`0`, `0x0`, `0:0:0:0:0:0:0:0`). Host is compared in the canonical form the web app uses, so case is
folded and the scheme's default port may be omitted. Every artifact still needs its signed grant.
