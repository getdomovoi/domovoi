---
"@getdomovoi/ui": patch
---

A menu closed with the mouse no longer leaves a focus ring on its trigger, such as the usage chip in
the composer. A modal menu still returns focus to its trigger, so the next Tab starts from it. A menu
that is not modal, such as the mode chip's, leaves focus where the click outside it went. A menu
closed with the keyboard returns focus with its ring as before.
