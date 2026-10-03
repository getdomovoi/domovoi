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
