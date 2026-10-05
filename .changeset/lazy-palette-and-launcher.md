---
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
"@getdomovoi/desktop": patch
---

Load less code before the first screen. The command palette and the launcher now load the first
time one opens, and at idle once the shell has painted, like the Settings, Skills, Machines and
Audit log surfaces. The QR code library loads with Settings, where the pairing card draws it,
instead of with the shell. Nothing they show or do changes. Opening one before its code has
arrived shows a dialog of the same size and title with loading bars, which closes the way the
dialog itself does, with Escape or a click outside. A closed one stays closed when the
code lands; an open one is replaced by the dialog. The project switch confirmation still loads
with the shell, so the sessions, worktrees and running work a switch stops show as soon as the
daemon asks. The web startup script graph drops from 1,284,380 to 1,234,668 bytes and the
desktop renderer's from 1,275,722 to 1,224,198 bytes.
