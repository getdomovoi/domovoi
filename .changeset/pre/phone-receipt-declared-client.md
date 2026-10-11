---
"@getdomovoi/mobile": patch
---

A phone receipt no longer calls a legacy receipt's client id a Credential. That id is what the
client declared when it connected, and no paired credential vouches for it, so RECORDED AS lists it
as Declared client. The receipt no longer says the audit row names this phone's verified
credential: a receipt records a client kind and a connection id, and a daemon credential typed into
Settings can declare phone too, so the phone cannot show that claim is true.
