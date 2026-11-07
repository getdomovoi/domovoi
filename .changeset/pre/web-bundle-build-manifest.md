---
"@getdomovoi/web": patch
---

The web build writes `domovoi-web.json` beside the built app: every emitted file with its SHA-256 and size, the workspace version and the protocol version, checked with the schema the daemon loads it with, so a build the daemon would refuse fails at build time. A built page takes its rpc URL from its own location, `wss://<host>/rpc` on https and `ws://<host>/rpc` on http; `VITE_DOMOVOI_RPC_URL` still wins and the dev server keeps `ws://127.0.0.1:47831/rpc`. A page whose origin is not `localhost`, `127.0.0.1` or `[::1]` offers code pairing only: it does not show the daemon credential prompt and refuses a pasted daemon credential before it opens a connection. This is the page's rule; the daemon still accepts its credential from any client it admits.
