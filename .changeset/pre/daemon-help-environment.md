---
"@getdomovoi/daemon": patch
---

`domovoid --help` now names the four environment variables the daemon reads that it left out: `DOMOVOI_TOOL_PATH`, `DOMOVOI_RELAY_IDENTITY_PUBLIC_KEY`, `DOMOVOI_RELAY_CREDENTIAL_FILE` and `DOMOVOI_WINDOWS_POWERSHELL`. A test now fails when the daemon reads a variable that the help text or the package README does not name.
