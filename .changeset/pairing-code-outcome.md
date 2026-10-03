---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
"@getdomovoi/ui": minor
---

The window that shows a pairing code now learns what became of it. `device.issueCode` returns a
`pairingId` beside the code, and the daemon sends a `device.codeOutcome` notification naming
that id to the connection that issued a client code, and to no other connection. It says the
code was redeemed, with the paired device row; refused because the device speaks another
protocol (with its label and both versions; the code stays open), because the paired device
list is full (with its label), or because the code was spent as a machine pairing; or closed
because wrong codes used up its attempts or another code replaced it. A code that runs out its
time sends nothing, since the issuer holds its expiry. The device that spent the code still gets
the same uniform refusal as before. Codes issued without a client kind report nothing.

The shared client accepts the notification and publishes it as a `device-code-outcome` event.
