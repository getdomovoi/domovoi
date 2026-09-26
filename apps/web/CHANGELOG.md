# @getdomovoi/web

## 0.1.0-alpha.0

### Minor Changes

- 22b46b6: Give the browser client the host capabilities the desktop already has, and stop the browser holding
  the daemon's root bearer.
  
  `WorkspaceShell` takes a `platform` port beside the desktop `windowBridge`. The browser build
  implements it against the browser's own APIs. Workspace notifications now reach a browser client, so
  the Notifications pane stops being three switches with nothing behind them. The pane names this
  client's delivery permission and install state, offers the permission request where the browser has
  not been asked, and disables the per-kind switches with the reason in view where the browser will
  not raise them at all. Copy worktree path is available to a browser and reports a clipboard refusal
  instead of doing nothing. Opening a project explains, in the launcher, why a browser has no folder
  picker: a File System Access handle names a folder on the device holding the browser, not one on the
  execution machine. Every refusal is typed and takes its copy from one table, so a capability the
  browser cannot honour always says what stopped it.
  
  The web client no longer stores the credential pasted at the connect prompt. That credential is the
  daemon's root bearer: it authenticates every client and cannot be withdrawn on its own. It is now
  spent once on `device.pair`, and only the client-bound device credential that comes back is kept for
  the tab. A paired client can revoke that device without disturbing any other client, and the daemon
  already closes a revoked device's socket. A bearer parked in session storage by an earlier build is
  dropped at startup. The root bearer still passes through the browser once, and a device credential
  has no expiry, so this is not yet a short-lived credential.
- 6542cb3: Finish the unblocked V2 phone, tablet, and web interface parity work.
- ad121ce: After pairing, a browser tab states what it can and cannot do, measured against this browser, before a refusal is hit inside the session.

### Patch Changes

- 3703350: Generate the app icons and the splash from the mark instead of shipping a hand-made tile.
  
  The shipped tile carried an amber radial glow and the full mark at roughly 40 percent of the
  tile. `scripts/brand-icons.mjs` now renders every asset from
  `design/assets/mark-reduced.svg` and `design/assets/mark.svg` with a local Chromium that cannot
  reach the network. Colours come from `apps/mobile/src/theme/tokens.generated.js`, so the artwork
  and the phone read one palette.
  
  iOS, Android, splash and favicon follow the root file "Domovoi App Icon.dc.html" in Claude Design
  project a3b4404e-4d0c-451e-8dd2-203116a76c06, read 2026-09-25, candidate "ink", the file's
  default. The icon is the reduced mark at 60 percent of the tile in `--primary` on `--card`, a
  full-bleed square with no baked radius because the OS applies its own mask, and no alpha. The
  Android adaptive foreground is the glyph on transparency, inset for the mask, with the ground as
  a flat colour in the config. The splash is the full mark at 76pt in `--primary` on `--background`
  for each theme, with no wordmark. The favicon is the reduced mark at 48px on the same ground.
  
  macOS does not mask app icons, and the App Icon file does not cover it. The desktop build for
  macOS therefore uses the brand handoff's macOS rule: the same ink tile as a squircle with a 22
  percent radius on Apple's 824 of 1024 grid. Windows and Linux keep the full-bleed square. The web
  app icons are generated from the same script with the same ink ground.
  
  The mobile app had no icon or splash configured before this change.
- 6378492: Browser and desktop clients can keep each daemon's relay identity pin. The shared store runs the protocol's recovery and adoption over any storage that can compare and swap one key, one key per machine; the web keeps it in localStorage under a Web Lock named by the key. A storage that cannot read reports a failure, never an absent pin, so a pin waiting for recovery is not replaced by a fresh enrolment. Once a daemon has answered the hello, the client enrols the identity it publishes as trusted or recovers a distrusted pin from its signed successor, verified against the saved pin only. A refused relay.recovery leaves the saved pin unchanged.
- 4a32392: Update production dependencies: the Claude, Kilo and OpenCode provider SDKs in the daemon; Electron 44.2.0 in the desktop; React 19.2.8, Lucide 1.42.0 and react-resizable-panels 4.12.4 in the shared ui and the clients. Development tooling moves with them (vitest 5, shadcn 4.21). The phone follows its Expo SDK: expo 57.0.22, reanimated 4.5.1 and worklets 0.10.1 as the SDK resolves them, jest held at 29 because jest-expo 57 expects it, and a deps:check that refuses drift from the installed SDK.
- 6736af1: A browser tab pairs with the code the machine shows in Settings under Phone and tablet, redeemed through device.redeemCode with no daemon credential. The connect page names the address it dials, says how the tab is trusted, draws the daemon's outcome (accepted, refused, protocol mismatch, device limit, no answer) and reads a code from the address bar once. The daemon credential stays reachable one link down. The sessions column in a browser says it reaches this machine only and that the credential ends with the tab.
- Updated dependencies [0a999df]
- Updated dependencies [077c912]
- Updated dependencies [1dd9ee7]
- Updated dependencies [1dd9ee7]
- Updated dependencies [5ee1825]
- Updated dependencies [17a71e2]
- Updated dependencies [08e4f00]
- Updated dependencies [1204d6c]
- Updated dependencies [22b46b6]
- Updated dependencies [c08fb6b]
- Updated dependencies [2adb117]
- Updated dependencies [2f29554]
- Updated dependencies [a67f32c]
- Updated dependencies [1204d6c]
- Updated dependencies [ba325c7]
- Updated dependencies [6378492]
- Updated dependencies [4cacf7a]
- Updated dependencies [d927d11]
- Updated dependencies [54424c9]
- Updated dependencies [35d34d2]
- Updated dependencies [54424c9]
- Updated dependencies [dffe022]
- Updated dependencies [ab18590]
- Updated dependencies [711bee5]
- Updated dependencies [b7f7c95]
- Updated dependencies [279349c]
- Updated dependencies [d4228ee]
- Updated dependencies [4a32392]
- Updated dependencies [3eaa05e]
- Updated dependencies [0fed2e6]
- Updated dependencies [3d67826]
- Updated dependencies [4ac11d0]
- Updated dependencies [950753d]
- Updated dependencies [b13b3b8]
- Updated dependencies [a37ad78]
- Updated dependencies [91b1e15]
- Updated dependencies [251df6d]
- Updated dependencies [18f6543]
- Updated dependencies [b5b1aa9]
- Updated dependencies [ca22e9e]
- Updated dependencies [9e1e9c5]
- Updated dependencies [5c17e88]
- Updated dependencies [3a2bf89]
- Updated dependencies [c32065a]
- Updated dependencies [54424c9]
- Updated dependencies [4359bcf]
- Updated dependencies [54424c9]
- Updated dependencies [f3252e5]
- Updated dependencies [9d94da3]
- Updated dependencies [c3229d9]
- Updated dependencies [6b0e4fd]
- Updated dependencies [64e9c45]
- Updated dependencies [1204d6c]
- Updated dependencies [431a7a1]
- Updated dependencies [bb72c15]
- Updated dependencies [bb72c15]
- Updated dependencies [bb72c15]
- Updated dependencies [5ae04b0]
- Updated dependencies [bb72c15]
- Updated dependencies [b67435e]
- Updated dependencies [c07f062]
- Updated dependencies [6d6a5ca]
- Updated dependencies [b5b1aa9]
- Updated dependencies [bedf4af]
- Updated dependencies [d22da12]
- Updated dependencies [54424c9]
- Updated dependencies [b4d857c]
- Updated dependencies [6f3379c]
- Updated dependencies [a5f0f7e]
- Updated dependencies [fe7968f]
- Updated dependencies [6542cb3]
- Updated dependencies [59b1a7a]
- Updated dependencies [d5bdbe6]
- Updated dependencies [9e8ee80]
- Updated dependencies [0c88e11]
- Updated dependencies [e6fa2ec]
- Updated dependencies [e736472]
- Updated dependencies [aeb4cba]
- Updated dependencies [66ade99]
- Updated dependencies [30c547b]
- Updated dependencies [cdf5f87]
- Updated dependencies [45e152d]
- Updated dependencies [3c2ae09]
- Updated dependencies [8f9ff38]
- Updated dependencies [0989268]
- Updated dependencies [1c67fba]
- Updated dependencies [964c47d]
- Updated dependencies [1644a81]
- Updated dependencies [1c5e749]
- Updated dependencies [7bea6a9]
- Updated dependencies [e094929]
- Updated dependencies [20e7e91]
- Updated dependencies [9048458]
- Updated dependencies [5a33539]
- Updated dependencies [fb78eda]
- Updated dependencies [9387a5d]
- Updated dependencies [c3e566a]
- Updated dependencies [2b21f85]
- Updated dependencies [559648e]
- Updated dependencies [ef58e04]
- Updated dependencies [9c12124]
- Updated dependencies [cad2971]
- Updated dependencies [8523d3d]
- Updated dependencies [f0b708d]
- Updated dependencies [d5a77a5]
- Updated dependencies [1dd9ee7]
- Updated dependencies [584e7d9]
- Updated dependencies [14c51c9]
- Updated dependencies [fdc96ec]
- Updated dependencies [0b59f4f]
- Updated dependencies [54424c9]
- Updated dependencies [5aafe95]
- Updated dependencies [67a2c58]
- Updated dependencies [31b48d4]
- Updated dependencies [03d4e4d]
- Updated dependencies [0fa2731]
- Updated dependencies [36520ce]
- Updated dependencies [f9f2352]
- Updated dependencies [cf5823d]
- Updated dependencies [ee3fe90]
- Updated dependencies [9383fb7]
- Updated dependencies [7e30caa]
- Updated dependencies [59b11f1]
- Updated dependencies [ea2b5ab]
- Updated dependencies [10635fc]
- Updated dependencies [ac569da]
- Updated dependencies [284ad5e]
- Updated dependencies [9266302]
- Updated dependencies [2793da2]
- Updated dependencies [e84ffb2]
- Updated dependencies [4d21256]
- Updated dependencies [41385c3]
- Updated dependencies [2c7ed5f]
- Updated dependencies [8a99cd0]
- Updated dependencies [21275b7]
- Updated dependencies [3879201]
- Updated dependencies [9b60965]
- Updated dependencies [01ce5da]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [7cf6870]
- Updated dependencies [322d3e9]
- Updated dependencies [ef0d241]
- Updated dependencies [b2e5888]
- Updated dependencies [63457d9]
- Updated dependencies [e937e67]
- Updated dependencies [4a53519]
- Updated dependencies [badc888]
- Updated dependencies [118eae8]
- Updated dependencies [6d56837]
- Updated dependencies [e5ba27e]
- Updated dependencies [fb78eda]
- Updated dependencies [358113a]
- Updated dependencies [b05db6b]
- Updated dependencies [82a3a67]
- Updated dependencies [4cacf7a]
- Updated dependencies [33c937f]
- Updated dependencies [fe7bf5c]
- Updated dependencies [e535558]
- Updated dependencies [f693dc8]
- Updated dependencies [951fa87]
- Updated dependencies [cbadf1a]
- Updated dependencies [9158900]
- Updated dependencies [2cda832]
- Updated dependencies [e4783bf]
- Updated dependencies [3a84912]
- Updated dependencies [45f488e]
- Updated dependencies [1f50a69]
- Updated dependencies [7d6f7f3]
- Updated dependencies [ad121ce]
- Updated dependencies [6736af1]
- Updated dependencies [0b81940]
- Updated dependencies [fa621d6]
- Updated dependencies [d0a58b7]
- Updated dependencies [7e8bcca]
- Updated dependencies [6832713]
- Updated dependencies [6832713]
  - @getdomovoi/ui@0.1.0-alpha.0
  - @getdomovoi/protocol@0.1.0-alpha.0
