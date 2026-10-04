---
"@getdomovoi/ui": patch
---

Hide plan wrapper tags in a streaming assistant reply. A provider that returns a plan wraps it in
standalone marker lines, and the daemon removes them only when the turn completes. The thread now
removes complete and partially streamed markers as the reply arrives, and separates surrounding
prose from the plan with a blank line so the two do not merge into one Markdown block.
