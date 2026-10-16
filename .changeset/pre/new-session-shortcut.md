---
"@getdomovoi/ui": patch
---

The desktop app binds Cmd+N (Ctrl+N on Windows and Linux) to New session, the key the title bar's tip names. It runs the same action as the title bar button, and does nothing in a watching window, while a dialog such as the command palette holds focus, or when a focused terminal takes Ctrl+N for its shell. A browser tab never receives that key, so the browser's tip now reads New session with no shortcut.
