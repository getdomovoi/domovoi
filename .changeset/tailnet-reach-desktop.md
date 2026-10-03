---
"@getdomovoi/desktop": minor
---

The desktop main process can turn TailnetReach on and off over the
`domovoi:tailnet-reach` channel. On, it reads `tailscale status --json`, runs
`tailscale cert` for this machine's own name into `<profile>/tls/<name>.crt` and
`.key`, and restarts the daemon once so it also answers on the tailnet address:
the in-app daemon through the settings it saves in the app's data directory, the
login service through its update. Off, it deletes only the files it wrote and
restarts the daemon on 127.0.0.1 only. It refuses while a turn runs or a gate
waits, and never replaces a file it did not write.

While the switch is on, the desktop runs
`tailscale cert --min-validity 720h` every 12 hours, the first time a minute
after it loads. It replaces only its own files and restarts the daemon only when
Tailscale returned a different certificate. A failure keeps the current
certificate, is tried again after an hour, and is reported with the switch's
state. A hand-set `DOMOVOI_HOST` beyond loopback keeps the saved settings out of
the in-app daemon, which starts without the tailnet listener; the switch says
why and does not turn on.

Turning on again and renewing set the files in use aside in a private pending
directory first. Any failure before the restart succeeds, a thrown error
included, puts those files back, and the record when turning on, and starts the
daemon as it was if the restart had begun; the pending directory is removed only once nothing in it is still needed.
When the files cannot be put back, they stay in that directory and the switch's
state says where, until someone moves them. A directory like that found when
the app starts is reported apart, since it may be from a change that did not
finish. When the in-app daemon's tailnet listener comes from
`DOMOVOI_TAILNET_ADDRESS` set by hand in the app's environment, the switch's
state says so, because turning the switch off cannot clear it.
