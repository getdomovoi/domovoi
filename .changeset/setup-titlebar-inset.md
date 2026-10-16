---
"@getdomovoi/ui": patch
---

On macOS, the first-run setup header, its loading frame and the fullscreen preview's top row now start past the window buttons, by the same inset the titlebar uses, so the buttons no longer sit on the Domovoi mark or the setup title. Each of those rows drags the window, and its controls stay clickable. Linux, Windows, the system window frame and the web reserve no inset, as before.
