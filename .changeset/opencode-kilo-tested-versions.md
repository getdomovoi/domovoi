---
"@getdomovoi/daemon": patch
---

The daemon starts OpenCode only at 1.18.x and Kilo only at 7.8.x, the lines its permission names,
tool ids and rule shapes were read from. It reads the executable's version before starting the
server, and any other version, or one it cannot read, refuses with a message naming the version
found and the one tested. A contract test run with `DOMOVOI_LIVE_PROVIDERS=1` fails when an
installed server's tool ids or permission names drift.
