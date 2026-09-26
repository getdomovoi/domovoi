---
"@getdomovoi/ui": minor
---

Reasoning effort can be set again from the desktop and web composer. The model menu has a Reasoning
group listing the efforts the session's model reports, with the model's default marked and the
current effort ticked. A model that reports no efforts, or whose list is still loading or failed,
shows no group. A pick goes to the daemon through `session.setRuntime`, the same request a model
change sends, and applies from the next turn. While a turn runs, the composer says which effort the
next turn will use until that turn ends. The unused Think chip and its helpers are removed.
