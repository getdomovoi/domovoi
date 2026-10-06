---
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
"@getdomovoi/desktop": patch
---

The effort menu uses the Desktop V2 words and lines for the levels each harness reports.
Claude Code's scale is now its effort levels low, medium, high and max, in place of think,
think-hard and ultrathink, which the daemon never reported. Codex reads None, Minimal, Low,
Medium, High and Extra high (xhigh), and OpenCode and Kilo Code name the level that sends no
effort value Model's own. The level the model reports as its default carries a Model default
tag in the menu; the chip still shows only the level's word. A level Domovoi has no word for
shows the value it sends, tagged No word yet, with a line that says so. A model that reports
levels but none of them as its default gets a line that says so. The note after a model change
moved the effort is drawn in neutral colours instead of amber.
