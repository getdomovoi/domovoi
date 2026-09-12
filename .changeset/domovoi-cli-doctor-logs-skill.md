---
"@getdomovoi/cli": patch
---

`domovoi doctor` checks the daemon, the credential and the protocol, then for each fleet
machine reports the route the daemon would choose for this client and why the others lost,
one line per transport kind; exit 1 on any failed probe. `domovoi logs` reads the machine's
own audit log over the client's channel as a paged query, with filters and `--before` for
paging and no `--follow`. `domovoi skill install <path>` previews files, digests, signature,
trust and target, then installs the previewed digest into the chosen scope on confirmation or
`--yes`; enabling stays a separate decision on the daemon.
