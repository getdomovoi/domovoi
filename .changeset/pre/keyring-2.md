---
"@getdomovoi/credential-store": patch
"@getdomovoi/daemon": patch
"@getdomovoi/cli": patch
---

Update @napi-rs/keyring to 2.0.0. A locked or inaccessible keychain now throws from every read and write, and a delete returns false only when nothing was there; every caller already reports that throw as unavailable and never as an absent credential.
