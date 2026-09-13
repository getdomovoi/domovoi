# @getdomovoi/cli

## 0.1.0

### Patch Changes

- c3fc9b0: `domovoi doctor` reports the protocol probe with the shared compatibility rule: compatible when
  major and minor match, otherwise which side is behind and what to update.
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
- Updated dependencies [1204d6c]
- Updated dependencies [2adb117]
- Updated dependencies [d4228ee]
- Updated dependencies [0fed2e6]
- Updated dependencies [3d67826]
- Updated dependencies [91b1e15]
- Updated dependencies [18f6543]
- Updated dependencies [9e1e9c5]
- Updated dependencies [c32065a]
- Updated dependencies [4359bcf]
- Updated dependencies [1204d6c]
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
- Updated dependencies [584e7d9]
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
