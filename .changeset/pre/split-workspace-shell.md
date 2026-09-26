---
"@getdomovoi/ui": patch
---

`workspace-shell.tsx` is split into one module per surface: `thread.tsx`, `artifact-dock.tsx`,
`launcher-dialog.tsx`, `history-panel.tsx`, `app-bar.tsx`, `workspace-selectors.ts` and
`restore-focus.ts`. Every public name is re-exported from `workspace-shell.tsx`, so nothing
importing it changes. No behaviour change.
