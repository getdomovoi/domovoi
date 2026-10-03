---
"@getdomovoi/mobile": patch
---

A phone receipt no longer calls a legacy receipt's client id a Credential. That id is what the
client declared when it connected, and no paired credential vouches for it, so RECORDED AS lists it
as Declared client. The note that the audit row names this phone's verified credential shows only
for a phone decision the daemon recorded over a verified connection.
