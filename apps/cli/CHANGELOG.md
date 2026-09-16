# @getdomovoi/cli

## 0.1.0

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
- a6dbf05: Wait on the credential lock when Windows answers EPERM or EBUSY for an open
  that races the holder's unlink, instead of failing the operation.
- 2278e42: The paired-daemon credential store uses the shared `@getdomovoi/credential-store` policy: OS
  keychain when present, otherwise only an explicit `--credential-file` with the mode enforced
  and the warning printed. Record format, file size handling and messages are unchanged.
- f5765de: `domovoi doctor` checks the daemon, the credential and the protocol, then for each fleet
  machine reports the route the daemon would choose for this client and why the others lost,
  one line per transport kind; exit 1 on any failed probe. `domovoi logs` reads the machine's
  own audit log over the client's channel as a paged query, with filters and `--before` for
  paging and no `--follow`. `domovoi skill install <path>` previews files, digests, signature,
  trust and target, then installs the previewed digest into the chosen scope on confirmation or
  `--yes`; enabling stays a separate decision on the daemon.
- 9571176: Add `@getdomovoi/cli`, the `domovoi` command: the terminal client for a daemon. `domovoi pair`
  takes the client credential `domovoid pair --client cli` printed, proves it with an
  authenticated hello, and keeps it in the OS keychain, or in an explicit `--credential-file`
  with mode 0600 and a stated warning where no keychain exists. `domovoi status` reports the
  daemon, its sessions, and for each fleet machine the route the daemon would choose for this
  client. Loopback and tailnet only; the relay route waits on the relay crypto design like every
  other client.
- 4aa3ef7: Update @napi-rs/keyring to 2.0.0. A locked or inaccessible keychain now throws from every read and write, and a delete returns false only when nothing was there; every caller already reports that throw as unavailable and never as an absent credential.
- ccc14a7: A keychain that does not answer is reported as unavailable, never as an absent credential. `nativeKeyring` wraps anything the native binding throws from a read, write or delete in `CredentialStoreUnavailableError`, with the binding's error as the cause and a message that says to unlock the store and that the pairing is unchanged. A null from the binding stays the only "no credential". The CLI passes that error through instead of printing "Not paired".
- Updated dependencies [1204d6c]
- Updated dependencies [2adb117]
- Updated dependencies [d4228ee]
- Updated dependencies [0fed2e6]
- Updated dependencies [3d67826]
- Updated dependencies [a5fde27]
- Updated dependencies [91b1e15]
- Updated dependencies [18f6543]
- Updated dependencies [9e1e9c5]
- Updated dependencies [c32065a]
- Updated dependencies [4359bcf]
- Updated dependencies [4aa3ef7]
- Updated dependencies [ccc14a7]
- Updated dependencies [1204d6c]
- Updated dependencies [b67435e]
- Updated dependencies [b5b1aa9]
- Updated dependencies [e736472]
- Updated dependencies [66ade99]
- Updated dependencies [cdf5f87]
- Updated dependencies [1c67fba]
- Updated dependencies [e094929]
- Updated dependencies [20e7e91]
- Updated dependencies [9048458]
- Updated dependencies [5a33539]
- Updated dependencies [fb78eda]
- Updated dependencies [9387a5d]
- Updated dependencies [c3e566a]
- Updated dependencies [2b21f85]
- Updated dependencies [ef58e04]
- Updated dependencies [cad2971]
- Updated dependencies [8523d3d]
- Updated dependencies [584e7d9]
- Updated dependencies [704c709]
- Updated dependencies [31b48d4]
- Updated dependencies [36520ce]
- Updated dependencies [f9f2352]
- Updated dependencies [ee3fe90]
- Updated dependencies [ea2b5ab]
- Updated dependencies [284ad5e]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [7cf6870]
- Updated dependencies [ef0d241]
- Updated dependencies [b2e5888]
- Updated dependencies [d0a58b7]
- Updated dependencies [6832713]
- Updated dependencies [6832713]
  - @getdomovoi/protocol@0.1.0
  - @getdomovoi/credential-store@0.1.0
