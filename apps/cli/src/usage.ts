import { defaultEndpoint } from "./rpc.js"

export const usage = `Usage:
  domovoi pair   [--daemon <ws-url>] [--credential-file <path>]   reads the credential from stdin
  domovoi status [--daemon <ws-url>] [--credential-file <path>]
  domovoi doctor [--daemon <ws-url>] [--credential-file <path>]
  domovoi logs   [--limit <n>] [--action <name>] [--outcome <o>] [--session <id>] [--before <id>]
  domovoi skill install <path> [--scope user|project] [--yes]

doctor: checks the daemon, your credential and the protocol, then for each fleet machine reports
the route this daemon would choose for you and why the others lost. Exit 1 on any failed probe.
logs: your own copy of the machine's audit log, read over your channel; nothing is uploaded. It is
a paged query, so there is no --follow; page with --before.
skill install: previews (files, digests, signature, trust, target), then installs the previewed
digest into the chosen scope; enabling is a separate decision on the daemon.

Pairing: 'domovoi pair' stores a client credential. Paste the credential alone, or a line
'Client credential: <credential>'. It is read from stdin so it never lands in shell history or
the process table. 'domovoid pair --client cli --label <device label>' prints a one-time
pairing code, not a credential, and 'domovoi pair' refuses a code. Today a client credential
comes from a device.pair request made with the daemon's own credential.
Credentials live in the OS keychain. Where there is none (a headless host, WSL, a container),
pass --credential-file to keep them in a file you own; the CLI never writes one on its own.
Default daemon: ${defaultEndpoint}
`

// Said by every command that needs a stored credential and finds none.
export function notPairedMessage(daemon: string, credentialFile: string | undefined): string {
  return `Not paired with ${daemon}. 'domovoi pair --daemon ${daemon}${credentialFile === undefined ? "" : ` --credential-file ${credentialFile}`}' reads a client credential from stdin; 'domovoi --help' says where one comes from.\n`
}
