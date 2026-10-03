---
"@getdomovoi/daemon": minor
---

Add an optional second listener on this machine's Tailscale address, beside the
loopback one. Set `DOMOVOI_TAILNET_ADDRESS`, `DOMOVOI_TAILNET_TLS_CERT_PATH` and
`DOMOVOI_TAILNET_TLS_KEY_PATH` together, with `DOMOVOI_ALLOW_REMOTE_TRANSPORT=1`
and a loopback `DOMOVOI_HOST`. The address must be in 100.64.0.0/10 or
fd7a:115c:a1e0::/48. The listener serves TLS only, on the loopback listener's
port, with the same authentication as any non-loopback listener. The saved
service configuration keeps it as `tailnetListener`.

A certificate that cannot be read, has expired or does not match its key
refuses only the tailnet listener: the daemon starts on loopback, logs why and
answers `tailnet.status` with the reason. The certificate and key are read only
when both are regular files of at most 64 KiB that are not links, opened without
following a link and checked on the opened file, and within 5 seconds, so a
FIFO, a directory or a stalled read cannot hold the daemon's start. An address that is not on the machine
yet, as when Tailscale is not up at login, is tried again every 30 seconds.
When the certificate passes its expiry while the daemon runs, the daemon closes
the tailnet listener and its connections, logs why and reports it refused. A
timer armed for the certificate's expiry does this, re-armed when the expiry is
further off than one timer can wait. While the listener answers, a pairing code names the host on its certificate,
and the fleet advertises a tailnet route under `DOMOVOI_TAILNET_HOST`.

`updateDaemonService` takes a `tailnet` change that sets or clears the listener
in the saved service configuration, written and restarted by the update. It
changes nothing for a service that already listens beyond loopback or runs in a
WSL guest.

`readLocalTailnetStatus` reads `tailnet.status` from a local daemon endpoint
and throws when the daemon cannot be read.
