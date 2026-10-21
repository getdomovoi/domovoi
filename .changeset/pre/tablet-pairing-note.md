---
"@getdomovoi/mobile": patch
---

When a tablet pairs, the note under its grant list says the credential stays in this tablet's
keychain; it used to say phone. Before the code is spent the note no longer names a client kind,
because the pairing code does not carry one: it says the machine minted the credential for a phone
or a tablet. Once paired, a device whose credential is of the other kind is told so, for example
Paired as a phone, because the code was issued for one.
