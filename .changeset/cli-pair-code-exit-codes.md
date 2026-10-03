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
