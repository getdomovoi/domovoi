---
"@getdomovoi/ui": patch
"@getdomovoi/desktop": patch
---

On the pairing card's Web browser tab, when the daemon's owner has set the web app address, the QR now holds that address with the code in `?code=`, so a phone camera opens the connect page with the code filled in. The card names that address beside the QR. When no web app address is set, the browser tab draws no QR, because a camera could not open it, and says to type the code into the web page instead. Phone and tablet QRs still hold the domovoi-pair payload.
