---
"@getdomovoi/mobile": patch
---

When the daemon connection drops while a session, an approval or an artifact is open, the
phone says so on that screen: the banner that already appears on the lists now appears there
too, saying what is drawn is the last state the phone was sent. The composer refuses to send
while the socket is not open and says the session is still on the machine. A decision that
could not be sent keeps the gate on screen with the reason where the buttons are, and says the
gate is still waiting; before, the rejection was unhandled and the screen showed nothing.
