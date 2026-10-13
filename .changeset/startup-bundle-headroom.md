---
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
"@getdomovoi/desktop": patch
---

Load less code before the first screen. The relay pin's recovery code, with the curve and hash
libraries under it, now loads only when a distrusted pin is recovered; enrolling or keeping a
trusted pin never loads it, and a recovery whose code fails to load leaves the saved pin as it
was. Desktop first-run setup now loads when it opens, on the first launch or from Settings, and
the web never loads it. Until its code arrives a full-window frame with the setup's name and
loading bars stands in, and closing it with Escape skips setup as Skip for now does, so the skip
holds when the code lands. The Settings components no longer load with the shell. The web startup
script graph drops from 1,287,162 to 1,224,391 bytes and the desktop renderer's from 1,276,792 to
1,212,085 bytes.
