---
"@getdomovoi/cli": patch
---

The paired-daemon credential store uses the shared `@getdomovoi/credential-store` policy: OS
keychain when present, otherwise only an explicit `--credential-file` with the mode enforced
and the warning printed. Record format and messages are unchanged.
