---
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
---

The pages a browser tab shows before its session (the connect page, the daemon credential prompt and the browser limits) now draw the Web v2 bar: the mark, Domovoi, the page's label and a theme toggle. The theme chosen there is kept where the workspace reads it, so the session opens in the same theme. While the theme follows the system, the toggle follows a change in the system's appearance too. Inside the session the web keeps the desktop bar.
