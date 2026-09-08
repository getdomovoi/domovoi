---
"@getdomovoi/desktop": patch
---

Tell the development daemon which origin its renderer is served from.

The daemon's default trusted origin list names the packaged app and port 5178.
Vite serves the desktop renderer on its own port, so the renderer's first
WebSocket was refused and the window reported "Cannot reach ws://127.0.0.1:.../rpc".

The desktop already resolves its renderer target before the first acquisition,
so it now derives `DOMOVOI_ALLOWED_ORIGINS` from that target when the target is
a development URL. It names one origin, the one the renderer is actually served
from, whatever port Vite took. A packaged app is untouched, and an operator who
set the list keeps it.
