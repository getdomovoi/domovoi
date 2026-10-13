---
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
---

The web connect page says where it came from. A page the daemon served shares the daemon's origin, so the first trust fact reads "This page came from the daemon at <host>". A page from any other origin names that host and still says the tab talks only to the daemon. The trust facts sit in the drawn bordered card, and the accepted line leads with the route (loopback, tailnet, direct or plaintext).

Inside the session, the command palette lists "What a browser tab can and cannot do". The limits open as a dialog over the live session, and Back or Escape closes it with the session as it was. On a phone each limit's reason takes its own line.

The pre-session bar draws the reduced 22px mark. The limits page and the daemon credential prompt no longer draw a second mark tile under it.

After an unconfirmed sign-out, the alert names the controls that check it: Sign this device out, or the connection bar's Retry now.
