---
"@getdomovoi/desktop": patch
---

Desktop builds no longer copy the renderer's packages into `app.asar` as unused `node_modules`.
The UI, React and React DOM are development dependencies of the desktop app: vite already inlines
them and every package they use into the renderer bundle, and the main process and the preload load
none of them. That drops about 180 packages and 16 MB, `lucide-react` and `@xterm/xterm` among them,
from each build. `THIRD_PARTY_NOTICES.txt` still names every package the renderer bundle contains,
including the OFL-1.1 text of the two renderer fonts, because the notices read the UI's own graph.
