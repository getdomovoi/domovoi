---
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
---

Opening the browser limits moves focus to their heading, and the way back returns focus to the link that opened them instead of the document body. If pairing finished while the limits were open, so that link is gone, focus goes to the same link on the outcome card. Opened from the accepted pairing card, where the tab is already paired, the button reads Back rather than Back to pairing.
