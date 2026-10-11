# @getdomovoi/cli

## 0.1.0-alpha.0

### Minor Changes

- 3377402: The paired-daemon record can carry the daemon's relay identity pin, and `relayPinStore` exposes
  it to the protocol's recovery and adoption functions with compare-and-swap. Every writer takes
  one exclusive lock per backing store, beside the credential file or under $HOME for the keyring,
  so two handles or two processes cannot both pass the same compare.
  `domovoi pair` enrols the daemon's published relay identity as the trusted pin over the
  authenticated connection, and `reconcileRelayPin` recovers a distrusted pin from the daemon's signed
  successor, verified against the saved pin only.

### Patch Changes

- c3fc9b0: `domovoi doctor` reports the protocol probe with the shared compatibility rule: compatible when
  major and minor match, otherwise which side is behind and what to update.
- 8efd98b: Stop declaring `@napi-rs/keyring` in the CLI. The CLI reaches the OS keychain only through
  `@getdomovoi/credential-store`, which declares and loads the binding itself, so the CLI no longer
  carries a second version range for it to keep in step.
- a6dbf05: Wait on the credential lock when Windows answers EPERM or EBUSY for an open
  that races the holder's unlink, instead of failing the operation.
- e958ca9: `domovoi pair` redeems the one-time pairing code `domovoid pair --client cli` prints, with
  `device.redeemCode`, the same flow a phone uses, so the daemon did not change. It reads the printed `domovoi-pair:1:` line or the bare code from stdin, dials the
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
- 7debdc1: `domovoi` names the daemon side of pairing as `domovoid pair --client cli` in its help, in the
  message for a daemon it is not paired with, and when a pasted line is not a pairing code. The
  daemon's `--label` is optional and only a suggested name, so the line no longer carries a
  `--label <device label>` placeholder. `domovoi pair --label` still names this device.
- 4d67c41: Publish the CLI publicly with npm provenance, like the protocol, daemon and credential store. A
  `prepack` script builds `dist` before packing, so a tarball can no longer be produced without the
  `domovoi` executable its manifest names. The release tooling now packs, describes and orders all
  four public packages; the CLI and credential store SBOMs take their inventory from the pnpm lock.
- d651e4b: The decision receipt line in `src/transcript.ts` names the decider by the paired device the
  daemon wrote on the receipt, label before client kind, as the web and desktop receipt reads:
  `allowed once by dana's phone · phone on mac-mini-m4 · 14:07:11`. A receipt without a device (the
  daemon credential, or a row written before the field) keeps the label the caller supplies, and
  with none names the client kind alone. Control characters and bidirectional formatting characters
  in the label or machine name are shown escaped, so no field can break the line or carry a
  directional override into the fields after it. The label, machine name and time are each wrapped
  in a first strong isolate and a pop directional isolate (U+2068 and U+2069) that the renderer owns,
  so in a viewer that applies bidirectional ordering, right-to-left text in one field cannot change
  where a neighbouring field such as the time is drawn. Any isolate in the input is shown escaped, so
  the only isolates on the line are the renderer's. No command prints the line yet.
- 2278e42: The paired-daemon credential store uses the shared `@getdomovoi/credential-store` policy: OS
  keychain when present, otherwise only an explicit `--credential-file` with the mode enforced
  and the warning printed. Record format, file size handling and messages are unchanged.
- 54d74b0: CLI output now shows control characters, bidirectional formatting characters and line separators
  in machine names, labels, reasons, paths and messages as visible escapes (`\n`, `\e`, `\u{202e}`
  and so on), so a value can no longer break a line, restyle the terminal or carry a directional
  override into the text after it. Ordinary right-to-left letters are printed as they are, so in a
  viewer that applies bidirectional ordering they can still move a neighbouring field; only the
  decision receipt line isolates its fields. This covers `pair`, `status`, `doctor`, `logs`, `skill install`, the credential file
  warning, every error printed to stderr, and the gate and policy refusal lines in
  `src/transcript.ts`. Ordinary text in any script is unchanged.
- 9a015e9: Update production dependencies. The daemon moves to Claude Agent SDK 0.3.281, Anthropic SDK 0.128.0,
  Agent Client Protocol SDK 1.5.0, Kilo SDK 7.7.9, OpenCode SDK 1.18.32, MCP SDK 1.30.1 and yaml
  2.9.1. Claude Agent SDK 0.3.281 is built against Claude Code 2.1.281, so the daemon now refuses an
  older `claude` with "Update Claude Code to 2.1.281 or newer". The floor was 2.1.263. The keyring
  binding moves to 2.1.0, zod to 4.6.5 and vite to 8.3.0. The shared ui and the web and desktop
  clients move to Lucide 1.47.0 and tailwind-merge 3.7.0, and stay on React 19.2.8 and
  react-resizable-panels 4.12.4: the newer two would put startup JavaScript over its budget. The
  phone takes Expo 57.0.24 and stays on the React, safe-area and SVG versions that SDK bundles.
- f5765de: `domovoi doctor` checks the daemon, the credential and the protocol, then for each fleet
  machine reports the route the daemon would choose for this client and why the others lost,
  one line per transport kind; exit 1 on any failed probe. `domovoi logs` reads the machine's
  own audit log over the client's channel as a paged query, with filters and `--before` for
  paging and no `--follow`. `domovoi skill install <path>` previews files, digests, signature,
  trust and target, then installs the previewed digest into the chosen scope on confirmation or
  `--yes`; enabling stays a separate decision on the daemon.
- 9571176: Add `@getdomovoi/cli`, the `domovoi` command: the terminal client for a daemon. `domovoi pair`
  takes the one-time pairing code `domovoid pair --client cli` printed, redeems it for a client
  credential, proves that credential with an authenticated hello, and keeps it in the OS keychain, or in an explicit `--credential-file`
  with mode 0600 and a stated warning where no keychain exists. `domovoi status` reports the
  daemon, its sessions, and for each fleet machine the route the daemon would choose for this
  client. Loopback and tailnet only; the relay route waits on the relay crypto design like every
  other client.
- c634abf: Add `domovoi daemon install|status|remove`. It runs `runDaemonCommand` from
  `@getdomovoi/daemon/daemon-command`, now a dependency of this package, so the login service
  registers the daemon's own `dist/index.js`, never this CLI's entry. The three commands keep the
  exit codes of `domovoid service`: status exits 0 when the service is installed, even if it is
  stopped, and 1 when it is not or its supervision failed; install and remove exit 0 on success and
  1 on failure. A verb the command does not have is a usage error, exit 2. Where the daemon package
  is not installed beside the CLI, as in the desktop app's runtime, it loads the one daemon at
  `../../daemon/dist/daemon-command.js` from its own `dist`, and refuses when that is absent too.
- 4aa3ef7: Update @napi-rs/keyring to 2.0.0. A locked or inaccessible keychain now throws from every read and write, and a delete returns false only when nothing was there; every caller already reports that throw as unavailable and never as an absent credential.
- ccc14a7: A keychain that does not answer is reported as unavailable, never as an absent credential. `nativeKeyring` wraps anything the native binding throws from a read, write or delete in `CredentialStoreUnavailableError`, with the binding's error as the cause and a message that says to unlock the store and that the pairing is unchanged. A null from the binding stays the only "no credential". The CLI passes that error through instead of printing "Not paired".
- Updated dependencies [f7c19b5]
- Updated dependencies [6696c99]
- Updated dependencies [e594466]
- Updated dependencies [d9add3d]
- Updated dependencies [309562f]
- Updated dependencies [d7dacad]
- Updated dependencies [1dd9ee7]
- Updated dependencies [5ee1825]
- Updated dependencies [6b2324b]
- Updated dependencies [07e8696]
- Updated dependencies [df3452f]
- Updated dependencies [08e4f00]
- Updated dependencies [d76b0e0]
- Updated dependencies [19a5fe5]
- Updated dependencies [56462e5]
- Updated dependencies [76172f8]
- Updated dependencies [dcb26a7]
- Updated dependencies [f9cf76b]
- Updated dependencies [1204d6c]
- Updated dependencies [7888b2c]
- Updated dependencies [5b2daa7]
- Updated dependencies [0ec38aa]
- Updated dependencies [b2f72a9]
- Updated dependencies [0160350]
- Updated dependencies [75f2f28]
- Updated dependencies [e9d4e37]
- Updated dependencies [002c74a]
- Updated dependencies [800de19]
- Updated dependencies [1dd9ee7]
- Updated dependencies [2b6d28e]
- Updated dependencies [1524651]
- Updated dependencies [4884900]
- Updated dependencies [5ffc29f]
- Updated dependencies [2adb117]
- Updated dependencies [1bc7464]
- Updated dependencies [3d92b6f]
- Updated dependencies [d02514f]
- Updated dependencies [4f57611]
- Updated dependencies [8ab80dc]
- Updated dependencies [48dc434]
- Updated dependencies [51de722]
- Updated dependencies [2f29554]
- Updated dependencies [5a14da7]
- Updated dependencies [0cc804a]
- Updated dependencies [31eb8b1]
- Updated dependencies [6fbe2a4]
- Updated dependencies [95810a1]
- Updated dependencies [097e00d]
- Updated dependencies [4a8b80a]
- Updated dependencies [0b293f4]
- Updated dependencies [9dbde2e]
- Updated dependencies [f0d3c74]
- Updated dependencies [c943176]
- Updated dependencies [b772543]
- Updated dependencies [e37020a]
- Updated dependencies [4cacf7a]
- Updated dependencies [a6d18ac]
- Updated dependencies [0bc3530]
- Updated dependencies [aa0c05d]
- Updated dependencies [f303874]
- Updated dependencies [961e74e]
- Updated dependencies [66463b0]
- Updated dependencies [dffe022]
- Updated dependencies [19053b7]
- Updated dependencies [ab18590]
- Updated dependencies [9e29413]
- Updated dependencies [c634abf]
- Updated dependencies [19a5fe5]
- Updated dependencies [707e0ab]
- Updated dependencies [bb0bdf5]
- Updated dependencies [6b22745]
- Updated dependencies [f058294]
- Updated dependencies [03245aa]
- Updated dependencies [9828935]
- Updated dependencies [c746eab]
- Updated dependencies [6f52997]
- Updated dependencies [19a5fe5]
- Updated dependencies [9dc6a6f]
- Updated dependencies [d72874e]
- Updated dependencies [fce431f]
- Updated dependencies [051e889]
- Updated dependencies [f2e4b75]
- Updated dependencies [0080f60]
- Updated dependencies [14527f0]
- Updated dependencies [711bee5]
- Updated dependencies [962980a]
- Updated dependencies [a4200fb]
- Updated dependencies [b7f7c95]
- Updated dependencies [279349c]
- Updated dependencies [77c2829]
- Updated dependencies [d4228ee]
- Updated dependencies [19a5fe5]
- Updated dependencies [cbf620b]
- Updated dependencies [2cd8a1b]
- Updated dependencies [ef91479]
- Updated dependencies [fb78eda]
- Updated dependencies [51a7431]
- Updated dependencies [4a32392]
- Updated dependencies [9a015e9]
- Updated dependencies [d7fea95]
- Updated dependencies [0fed2e6]
- Updated dependencies [3d67826]
- Updated dependencies [68833ac]
- Updated dependencies [df4716f]
- Updated dependencies [a5fde27]
- Updated dependencies [5fea2c8]
- Updated dependencies [91b1e15]
- Updated dependencies [0d60644]
- Updated dependencies [a894fcb]
- Updated dependencies [65da87b]
- Updated dependencies [18f6543]
- Updated dependencies [5f104a3]
- Updated dependencies [9db320a]
- Updated dependencies [ca22e9e]
- Updated dependencies [9e1e9c5]
- Updated dependencies [c32065a]
- Updated dependencies [ccaa2be]
- Updated dependencies [4359bcf]
- Updated dependencies [8871313]
- Updated dependencies [3097d31]
- Updated dependencies [4bf0e8e]
- Updated dependencies [a2fa107]
- Updated dependencies [eb8040e]
- Updated dependencies [357dfb6]
- Updated dependencies [d3e5aef]
- Updated dependencies [16ca29f]
- Updated dependencies [6b30c51]
- Updated dependencies [9d94da3]
- Updated dependencies [12f0a90]
- Updated dependencies [4712ef9]
- Updated dependencies [972e6c7]
- Updated dependencies [5da6a5a]
- Updated dependencies [96c757b]
- Updated dependencies [d47bfc6]
- Updated dependencies [b8c55c2]
- Updated dependencies [16c242a]
- Updated dependencies [c3229d9]
- Updated dependencies [6b0e4fd]
- Updated dependencies [1f80e31]
- Updated dependencies [8ea383c]
- Updated dependencies [64e9c45]
- Updated dependencies [7815f0a]
- Updated dependencies [4aa3ef7]
- Updated dependencies [ccc14a7]
- Updated dependencies [161741e]
- Updated dependencies [1204d6c]
- Updated dependencies [ff9307a]
- Updated dependencies [c5b68b2]
- Updated dependencies [5ae04b0]
- Updated dependencies [21a161c]
- Updated dependencies [b67435e]
- Updated dependencies [aba51b2]
- Updated dependencies [50510c7]
- Updated dependencies [3e2c556]
- Updated dependencies [81c488a]
- Updated dependencies [e199de4]
- Updated dependencies [c60209d]
- Updated dependencies [ccc14a7]
- Updated dependencies [c81939b]
- Updated dependencies [b5b1aa9]
- Updated dependencies [7bc1d86]
- Updated dependencies [f93880b]
- Updated dependencies [0a7be6d]
- Updated dependencies [a5f0f7e]
- Updated dependencies [fe7968f]
- Updated dependencies [59b1a7a]
- Updated dependencies [d5bdbe6]
- Updated dependencies [0c88e11]
- Updated dependencies [e6fa2ec]
- Updated dependencies [777efeb]
- Updated dependencies [e736472]
- Updated dependencies [9901dd5]
- Updated dependencies [9086190]
- Updated dependencies [a38dbbb]
- Updated dependencies [da6d3a7]
- Updated dependencies [ab357e9]
- Updated dependencies [2bad0b8]
- Updated dependencies [95d5434]
- Updated dependencies [966f5c3]
- Updated dependencies [a848818]
- Updated dependencies [4fb3d7c]
- Updated dependencies [263a67e]
- Updated dependencies [36fc9d0]
- Updated dependencies [69cbaee]
- Updated dependencies [767c388]
- Updated dependencies [66ade99]
- Updated dependencies [35a0cc6]
- Updated dependencies [e68d767]
- Updated dependencies [cdf5f87]
- Updated dependencies [45e152d]
- Updated dependencies [02a1b58]
- Updated dependencies [3c2ae09]
- Updated dependencies [c204537]
- Updated dependencies [e268b8f]
- Updated dependencies [1c67fba]
- Updated dependencies [964c47d]
- Updated dependencies [973430f]
- Updated dependencies [7bea6a9]
- Updated dependencies [1fadaa1]
- Updated dependencies [6de27ad]
- Updated dependencies [19aad21]
- Updated dependencies [e094929]
- Updated dependencies [71efbdd]
- Updated dependencies [20e7e91]
- Updated dependencies [9048458]
- Updated dependencies [5a33539]
- Updated dependencies [fb78eda]
- Updated dependencies [ea4a201]
- Updated dependencies [adc3f35]
- Updated dependencies [706d626]
- Updated dependencies [ed11c45]
- Updated dependencies [ce5444a]
- Updated dependencies [cdf92bc]
- Updated dependencies [9387a5d]
- Updated dependencies [c3e566a]
- Updated dependencies [f9955d6]
- Updated dependencies [2b21f85]
- Updated dependencies [28efb31]
- Updated dependencies [80c8318]
- Updated dependencies [2a0d03a]
- Updated dependencies [130500f]
- Updated dependencies [4f3c3b5]
- Updated dependencies [946f8ee]
- Updated dependencies [d34d0a0]
- Updated dependencies [7cd200e]
- Updated dependencies [b2e05be]
- Updated dependencies [997661b]
- Updated dependencies [ef58e04]
- Updated dependencies [bf44657]
- Updated dependencies [7a069eb]
- Updated dependencies [9c12124]
- Updated dependencies [cad2971]
- Updated dependencies [8523d3d]
- Updated dependencies [bbdfa6b]
- Updated dependencies [d5a77a5]
- Updated dependencies [1a246bd]
- Updated dependencies [2f4a95a]
- Updated dependencies [ef22e8e]
- Updated dependencies [8e18a9b]
- Updated dependencies [3ccf0f3]
- Updated dependencies [fc40225]
- Updated dependencies [f94caa0]
- Updated dependencies [c5767cd]
- Updated dependencies [cec544b]
- Updated dependencies [a5a510e]
- Updated dependencies [e29f975]
- Updated dependencies [c9855a1]
- Updated dependencies [9f1ce54]
- Updated dependencies [9cac913]
- Updated dependencies [8e3a45f]
- Updated dependencies [1dd9ee7]
- Updated dependencies [ae04086]
- Updated dependencies [404ea5e]
- Updated dependencies [584e7d9]
- Updated dependencies [66a1846]
- Updated dependencies [e08eda3]
- Updated dependencies [2cdba11]
- Updated dependencies [74d9782]
- Updated dependencies [1ca35e5]
- Updated dependencies [7e84a65]
- Updated dependencies [a352dde]
- Updated dependencies [2b8c93f]
- Updated dependencies [19b1892]
- Updated dependencies [4b6afef]
- Updated dependencies [55ecb69]
- Updated dependencies [900eadd]
- Updated dependencies [24e0aa5]
- Updated dependencies [fdc96ec]
- Updated dependencies [0b59f4f]
- Updated dependencies [788f63d]
- Updated dependencies [234d8fe]
- Updated dependencies [6ab8dad]
- Updated dependencies [704c709]
- Updated dependencies [90a3111]
- Updated dependencies [6b30c51]
- Updated dependencies [f15b01b]
- Updated dependencies [31b48d4]
- Updated dependencies [36520ce]
- Updated dependencies [6ddadb7]
- Updated dependencies [e583a5a]
- Updated dependencies [2c9ffc1]
- Updated dependencies [f9f2352]
- Updated dependencies [c250637]
- Updated dependencies [6e252b0]
- Updated dependencies [ee3fe90]
- Updated dependencies [7e30caa]
- Updated dependencies [5bdac19]
- Updated dependencies [191f4fe]
- Updated dependencies [67e712e]
- Updated dependencies [41a8edf]
- Updated dependencies [77481e5]
- Updated dependencies [bdb1d89]
- Updated dependencies [ea2b5ab]
- Updated dependencies [284ad5e]
- Updated dependencies [e4d278b]
- Updated dependencies [32304b3]
- Updated dependencies [728416e]
- Updated dependencies [7afb1e2]
- Updated dependencies [84d90d5]
- Updated dependencies [52f75d0]
- Updated dependencies [eef6cea]
- Updated dependencies [3fdab3d]
- Updated dependencies [06e19f1]
- Updated dependencies [9266302]
- Updated dependencies [a0bf7a0]
- Updated dependencies [bdac41e]
- Updated dependencies [87b573b]
- Updated dependencies [7fa4caf]
- Updated dependencies [9b60965]
- Updated dependencies [01ce5da]
- Updated dependencies [678e172]
- Updated dependencies [1ed1cdf]
- Updated dependencies [cb8b27a]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [7cf6870]
- Updated dependencies [1c4e9b6]
- Updated dependencies [82ab538]
- Updated dependencies [b235318]
- Updated dependencies [ef0d241]
- Updated dependencies [b2e5888]
- Updated dependencies [8a77b07]
- Updated dependencies [3e773b4]
- Updated dependencies [33c937f]
- Updated dependencies [b30b27e]
- Updated dependencies [d828526]
- Updated dependencies [d46672f]
- Updated dependencies [8a205cf]
- Updated dependencies [b90c8de]
- Updated dependencies [4ddf93f]
- Updated dependencies [12524c9]
- Updated dependencies [107912f]
- Updated dependencies [91ed6c1]
- Updated dependencies [1080704]
- Updated dependencies [08d39f0]
- Updated dependencies [08d39f0]
- Updated dependencies [90bb877]
- Updated dependencies [6011264]
- Updated dependencies [308e63d]
- Updated dependencies [fa621d6]
- Updated dependencies [d0a58b7]
- Updated dependencies [6832713]
- Updated dependencies [6832713]
- Updated dependencies [12ca8d6]
- Updated dependencies [12ca8d6]
- Updated dependencies [232ffe8]
  - @getdomovoi/daemon@0.1.0-alpha.0
  - @getdomovoi/protocol@0.1.0-alpha.0
  - @getdomovoi/credential-store@0.1.0-alpha.0
