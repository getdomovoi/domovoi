---
"@getdomovoi/daemon": patch
---

The daemon now checks the connection's credential before it takes `repository.trust` or
`repository.revokeTrust`, never the client the connection declares. It admits the owner's bearer
credential when the connection declared desktop or web, which means any process running as the
owner can call them, and a paired desktop or web credential with full access. It refuses a relay
channel with "This method requires a direct connection", and every other connection (a paired
command-line, phone, tablet or watching credential, a machine credential, and a bearer that
declared another client or none) with "Repository trust requires the daemon credential or a paired
desktop or web credential with full access". The methods have no handler yet.

`device.pair` now refuses to mint a desktop credential for a connection that declared web, phone or
tablet, with "A web, phone or tablet connection cannot pair a desktop credential", so a browser that
holds a pasted bearer cannot pair itself as a desktop.
