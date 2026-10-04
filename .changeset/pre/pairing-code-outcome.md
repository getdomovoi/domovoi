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
time sends nothing, since the issuer holds its expiry. The device that spent the code gets the
same answers as before: the uniform refusal, or its own protocol-mismatch and device-limit
errors. For a protocol mismatch, the daemon writes that refusal first and only then matches the
code and tells its issuer, and the match costs the same whether the code is live, wrong, expired
or spent. Only the issuer of the code that was open when the refusal went out is told, so a code
issued in between hears nothing of it, even when its words repeat. Codes issued without a client
kind report nothing.

The shared client accepts the notification and publishes it as a `device-code-outcome` event.
