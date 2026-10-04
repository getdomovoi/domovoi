---
"@getdomovoi/cli": patch
---

`domovoi pair` redeems the one-time pairing code `domovoid pair --client cli --label <device
label>` prints, with `device.redeemCode`, the same flow a phone uses, so the daemon did not
change. It reads the printed `domovoi-pair:1:` line or the bare code from stdin, dials the
address the line carries unless `--daemon` is given, spends the code on a socket that holds no
credential yet, proves the minted credential with an authenticated hello, and keeps it with the
device label the daemon recorded (`--label`, default the hostname). A code issued for another
kind of client is refused and nothing is stored. The usage text that named a command that printed
a credential is corrected.

The CLI adopts the exit code table from the CLI transcripts design, whole, before 1.0: 0 ok,
1 internal, 2 usage, 3 daemon-unreachable, 4 not-found, 5 not-paired, 10 gate-waiting,
11 turn-failed, 12 refused-by-policy, 21 connection-lost, 22 stopped-unconfirmed,
31 already-decided, 32 not-permitted, 33 needs-a-person, 130 detached. Two codes change for the
commands that exist: a daemon that never answered exits 3 instead of 1, and no stored credential
for the daemon exits 5 instead of 2. `--help` and the README print the table.

The lines a session transcript will print are fixed in `src/transcript.ts` for the session
commands to inherit: a gate prompt with its facts one per line and never a boxed card, a decision
receipt that names the person as the paired device's label beside the client kind and machine,
and a policy refusal that draws the rule, who set it, its scope and the remedy as the daemon sent
them, with no org-owner line. No command prints them yet.
