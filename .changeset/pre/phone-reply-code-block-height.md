---
"@getdomovoi/mobile": patch
---

A reply with a fenced command no longer fills the phone thread with an empty frame.

The command block in an agent's reply scrolls sideways, and a sideways scroller grows by default.
Inside the reply bubble, which is sized to its content, React Native's layout stretched that growth
to the height of the whole thread, so the bubble and the block covered every other item and the
command itself sat out of view. The block no longer grows, so it is as tall as its command.
