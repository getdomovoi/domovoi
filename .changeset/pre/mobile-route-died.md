---
"@getdomovoi/mobile": patch
---

When the daemon connection drops while a session, an approval or an artifact is open, the
phone says so on that screen: the banner that already appears on the lists now appears there
too, saying what is drawn is the last state the phone was sent. The composer refuses to send
while the socket is not open and says the session is still on the machine. A decision that
did not come back confirmed keeps the gate on screen with the reason where the buttons are.
The phone claims only what it can prove: a frame that never left is "Not sent … The gate is
still waiting"; a frame that left with no answer is "The daemon went away before it confirmed.
The gate may or may not have been answered; when the connection returns, this screen shows
which." Before, the rejection was unhandled and the screen showed nothing.
