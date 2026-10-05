---
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
"@getdomovoi/desktop": patch
---

Load less code before the first screen. The command palette, the launcher and the project switch
confirmation now load the first time one opens, and at idle once the shell has painted, like the
Settings, Skills, Machines and Audit log surfaces. The QR code library loads with Settings, where
the pairing card draws it, instead of with the shell. Nothing they show or do changes. Opening one
before its code has arrived draws it once the code lands, and focus stays on the control that
opened it until then. The web startup script graph drops from 1,284,380 to 1,231,989 bytes and
the desktop renderer's from 1,275,722 to 1,221,509 bytes.
