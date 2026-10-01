---
"@getdomovoi/daemon": patch
---

The daemon starts only the OpenCode and Kilo releases that passed its live contract test:
OpenCode 1.18.32 and 1.18.33, and Kilo 7.8.1. Its permission names, tool ids and rule shapes were
read from them. It reads the executable's version before starting the server, and the output must
be exactly one version line. Any other release, or an output it cannot read as one version line,
refuses with a message naming the version found and the releases tested. A contract test run with
`DOMOVOI_LIVE_PROVIDERS=1` fails when an installed server's tool ids or permission names drift.
