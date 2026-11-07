---
"@getdomovoi/ui": patch
---

Keep the end of a streaming reply in view. The thread followed the number of rows, so a reply that streamed into a single row grew below the fold and the reader had to scroll by hand. At the bottom the thread now follows the scroll height instead. A reader who has scrolled up is still left alone, and growth inside a message they can already see is not counted as new.
