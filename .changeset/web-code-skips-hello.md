---
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
---

A browser tab pairs with the machine's web code again. The connect page greeted the daemon before it sent the code, the daemon refused a greeting from a tab with no credential, and every code was shown as refused while it stayed unspent. The code is now sent alone on a socket that has not greeted, as the phone app sends it, and the socket closes after the reply. The daemon credential path still pairs through a greeting. A refused greeting is no longer shown as a refused code: the page shows the daemon's own words instead. A browser that greets as a phone or tablet no longer keeps a credential a web code bound to web, which the daemon would refuse at the session: it keeps nothing and says which code it needs.
