---
"@getdomovoi/ui": minor
---

Desktop Settings draws "Reach this machine from my tailnet" as a row of the
daemon card: no tailnet, off with what turning it on changes and what Domovoi
never touches, turning on and off with the steps in order, on with the tailnet
name, the certificate's expiry and where the daemon answers, a failed renewal,
a daemon not answering on the tailnet in its own words, and a hand-set
`DOMOVOI_HOST` that keeps the settings out. It claims reach only while the
daemon's `tailnet.status` says it listens, and says when that is not known. The
pairing card's "Go to the tailnet setting" leads to it, and "Get it from
Tailscale" turns it on. A login service installed while the switch is on keeps
the tailnet listener. While Settings is open the row reads the switch and
`tailnet.status` again when the window is focused or shown again, and every
minute while it is shown, so a failed renewal or an expired certificate is
drawn without a click. Automatic reads run one at a time while Settings is
open. Triggers received during a read queue one follow-up, which runs if
Settings is still open and visible and no change is running. An automatic read
waits at most 120 seconds for the desktop's status before the next may run;
the desktop is not asked again until that answer is in.

When the daemon still answers on the tailnet with the switch off because
`DOMOVOI_TAILNET_*` was set by hand, the row says the switch cannot clear it
instead of offering to turn it off again. When a change could not put the
previous certificate and key back, the row says which directory holds them; a
directory found when the app started is named with a softer line, since it may
be from a change that did not finish. When a turn-off could not delete the
files it set aside, the row says "The certificate and key were set aside in
<dir> and could not be deleted." in the same softer style. These three lines
are drawn with every state, no tailnet included. When the restart fails after
such a turn-off, the deletion step is not drawn as done.

Off, the row says only this computer can reach the daemon only for the daemon
inside this app, when the daemon has said it has no tailnet listener and no
hand-set `DOMOVOI_HOST` beyond loopback is in the app's environment. Beside such
a `DOMOVOI_HOST` it says the daemon listens beyond this computer. While
`tailnet.status` has not answered, or for a daemon this app did not start, whose
first listener `tailnet.status` does not describe, it says that is not known.
