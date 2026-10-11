---
"@getdomovoi/desktop": patch
---

Desktop builds no longer copy the renderer's packages into `app.asar` as unused `node_modules`.
The UI, React and React DOM are development dependencies of the desktop app: vite already inlines
them and every package they use into the renderer bundle, and the main process and the preload load
none of them. The package list electron-builder's pnpm collector gives for the app drops from 304
to 150, with `lucide-react` and `@xterm/xterm` among those removed. `THIRD_PARTY_NOTICES.txt`
still names every package the renderer bundle contains, including the OFL-1.1 text of the two
renderer fonts, because the notices read the UI's own graph.
