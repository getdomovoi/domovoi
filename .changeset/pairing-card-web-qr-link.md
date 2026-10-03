---
"@getdomovoi/ui": patch
"@getdomovoi/desktop": patch
---

On the pairing card's Web browser tab, when the daemon's owner has set the web app address, the QR now holds that address with the code in `?code=`, so a phone camera opens the connect page with the code filled in. The card names that address beside the QR. Phone and tablet QRs still hold the domovoi-pair payload, and a browser QR without a web app address is unchanged.
