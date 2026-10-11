---
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
"@getdomovoi/desktop": patch
---

The effort menu uses the Desktop V2 words and lines for the levels each harness reports.
Claude Code's scale is now its effort levels low, medium, high and max, in place of think,
think-hard and ultrathink, which the daemon never reported. Codex reads None, Minimal, Low,
Medium, High and Extra high (xhigh). The level the daemon reports as the model's default
carries a Model default tag in the menu; the chip still shows only the level's word. A level
Domovoi has no word for shows the value it sends, tagged No word yet, with a line that says so.
The note after a model change moved the effort is drawn in neutral colours instead of amber.
OpenCode and Kilo Code still report one level, medium or none, and send no effort value with a
turn, so their menu shows that level rather than Model's own.
