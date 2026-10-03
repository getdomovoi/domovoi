---
"@getdomovoi/web": patch
---

The browser limits row "Attach a local file" now says "always a payload" instead of "not yet". The web composer already sends an image or file from the device with the message, because there is no shared filesystem. The row also states the limits the composer enforces: a PNG or JPEG image up to 1.5 MB, or a text file up to 256 KB, two per message.
