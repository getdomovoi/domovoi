# @getdomovoi/desktop

## 0.1.0

### Minor Changes

- 9dc6a6f: Desktop now builds its daemon through the shared production factory instead
  of a hand-assembled server with a random per-launch token. The daemon keeps a
  persisted credential and machine identity across launches, so paired devices
  keep working after Desktop restarts, and the renderer connects to the URL and
  token of the daemon that was actually started rather than a fixed address. The
  launch smoke no longer requests daemon credentials and fails if a daemon state
  directory appears during the packaging test.

### Patch Changes

- ee3fe90: Refuse Fleet routes whose normalized hostname cannot name one exact CSP source.
  URL-valid semicolons and commas, including percent-encoded forms, could previously
  authorize a different hostname when Chromium parsed the worker policy. These routes
  now fail before a ticket is issued, rather than escaping or broadening the policy.
  
  Use a normal DNS hostname or IPv4 route when admission reports that no client route
  is available. No protocol change or re-pairing is required. Existing exact origins,
  ports and URL-normalized internationalized names retain their behavior.
- 92ca11f: Desktop quit no longer reports a bounded daemon release as a clean shutdown.
  When the ten second release bound wins the race, the lifecycle now reports a
  `DesktopDaemonReleaseTimeoutError` naming the pending release and the bound it
  outlived, so the failure reaches the main-process error sink. Quitting still
  proceeds without waiting for a release that will not settle, and a release that
  settles inside the bound reports nothing.
- 796f353: Let the development renderer load under its own content security policy.
  
  The renderer policy ends `script-src 'self'`, which blocks every inline script.
  Vite serves the react-refresh preamble as an inline module script, so the
  development page failed with "@vitejs/plugin-react can't detect preamble", left
  `#root` empty, and showed the window's background colour and nothing else.
  
  Before the document is asked for, the main process now reads the development
  page, hashes the inline scripts it actually carries, and names those hashes in
  `script-src`. There is no `'unsafe-inline'` and no pinned preamble text, so a
  change to the plugin's preamble changes the hash rather than breaking the load.
  
  The packaged application is unchanged. It serves its own HTML through the
  `domovoi-app` protocol, that HTML carries no inline script, and the policy stays
  `script-src 'self'` there.
- 796f353: Tell the development daemon which origin its renderer is served from.
  
  The daemon's default trusted origin list names the packaged app and port 5178.
  Vite serves the desktop renderer on its own port, so the renderer's first
  WebSocket was refused and the window reported "Cannot reach ws://127.0.0.1:.../rpc".
  
  The desktop already resolves its renderer target before the first acquisition,
  so it now derives `DOMOVOI_ALLOWED_ORIGINS` from that target when the target is
  a development URL. It names one origin, the one the renderer is actually served
  from, whatever port Vite took. A packaged app is untouched, and an operator who
  set the list keeps it.
- ee3fe90: Add separate, kind-bound remote client grants and Fleet client admission. A machine pairing remains daemon-to-daemon authority, not permission for a desktop or browser to control the target.
  
  Operators issue a separate client credential on the target with `domovoid pair --client desktop --label "My desktop"`, then choose Authorize this client in Fleet. Use, Terminal and inventory reads require the target identity and client receipt to verify. Desktop main verifies each enrolled route through the home daemon and grants only that exact socket origin. Update both daemons and the client before using these additive calls. The wire remains 0.5.0, existing pairings remain valid and no re-pair is required.
  
  Client credentials stay only in app memory. Closing the app or removing local access does not revoke the remote grant; revoke the device in the target's Devices list. Remote Desktop preview frames remain unavailable until they have a separate verified path. This does not enable a hosted relay or expose the daemon's machine keychain to the client.
  
  Desktop serves its bundle from an explicit app origin so response CSP is enforced. Existing development profiles may need appearance, layout and first-run preferences selected again because old file-origin browser storage is not migrated. The daemon profile and its canonical sessions are unchanged.
  
  If `DOMOVOI_ALLOWED_ORIGINS` is explicitly configured, add the exact `domovoi-app://desktop` origin and restart that daemon. The default configuration already includes it; custom lists are not silently widened.
- 43f512c: Update the desktop to Electron 44.1.0 with newer Chromium and Node runtimes.
- 8a77b07: Stop two tests failing on a loaded CI worker.
  
  `annotation-visual-context.test.ts` waited for a crop file through 100 event-loop
  turns. Turns cost microseconds and the write costs a disk, so a busy Ubuntu
  worker exhausted them and the test reported a timeout on a crop that was on its
  way. It now waits through `waitForDaemon`, the measured budget the rest of the
  daemon observations use.
  
  The desktop signing tests ran under `node --test`, which forks a child and reads
  its results back over a serialized protocol. Twice that stream was reported
  corrupt, as "Unable to deserialize cloned data due to invalid or unsupported
  version", after every assertion in the file had already passed. The file now runs
  in process, where `node:test` needs no child and no protocol between them, and a
  failing assertion still exits non-zero.
  
  The corruption itself is unreproduced here: it needs the Node 22 that CI uses,
  and this machine runs Node 26. This removes the channel rather than claiming a
  diagnosis of it.
- Updated dependencies [f7c19b5]
- Updated dependencies [d9add3d]
- Updated dependencies [077c912]
- Updated dependencies [f9cf76b]
- Updated dependencies [1204d6c]
- Updated dependencies [5b2daa7]
- Updated dependencies [0ec38aa]
- Updated dependencies [b2f72a9]
- Updated dependencies [0160350]
- Updated dependencies [75f2f28]
- Updated dependencies [e9d4e37]
- Updated dependencies [002c74a]
- Updated dependencies [22b46b6]
- Updated dependencies [1524651]
- Updated dependencies [3d92b6f]
- Updated dependencies [95810a1]
- Updated dependencies [097e00d]
- Updated dependencies [1204d6c]
- Updated dependencies [a6d18ac]
- Updated dependencies [d927d11]
- Updated dependencies [54424c9]
- Updated dependencies [35d34d2]
- Updated dependencies [54424c9]
- Updated dependencies [707e0ab]
- Updated dependencies [bb0bdf5]
- Updated dependencies [f058294]
- Updated dependencies [c746eab]
- Updated dependencies [6f52997]
- Updated dependencies [9dc6a6f]
- Updated dependencies [d72874e]
- Updated dependencies [fce431f]
- Updated dependencies [0080f60]
- Updated dependencies [a4200fb]
- Updated dependencies [d4228ee]
- Updated dependencies [cbf620b]
- Updated dependencies [fb78eda]
- Updated dependencies [51a7431]
- Updated dependencies [0fed2e6]
- Updated dependencies [3d67826]
- Updated dependencies [df4716f]
- Updated dependencies [91b1e15]
- Updated dependencies [251df6d]
- Updated dependencies [18f6543]
- Updated dependencies [b5b1aa9]
- Updated dependencies [ca22e9e]
- Updated dependencies [9e1e9c5]
- Updated dependencies [3a2bf89]
- Updated dependencies [54424c9]
- Updated dependencies [4359bcf]
- Updated dependencies [54424c9]
- Updated dependencies [6b30c51]
- Updated dependencies [1204d6c]
- Updated dependencies [3e2c556]
- Updated dependencies [e199de4]
- Updated dependencies [b5b1aa9]
- Updated dependencies [bedf4af]
- Updated dependencies [d22da12]
- Updated dependencies [54424c9]
- Updated dependencies [7bc1d86]
- Updated dependencies [6f3379c]
- Updated dependencies [66ade99]
- Updated dependencies [30c547b]
- Updated dependencies [1c67fba]
- Updated dependencies [1fadaa1]
- Updated dependencies [71efbdd]
- Updated dependencies [20e7e91]
- Updated dependencies [5a33539]
- Updated dependencies [9387a5d]
- Updated dependencies [28efb31]
- Updated dependencies [80c8318]
- Updated dependencies [2a0d03a]
- Updated dependencies [130500f]
- Updated dependencies [946f8ee]
- Updated dependencies [7cd200e]
- Updated dependencies [997661b]
- Updated dependencies [8e3a45f]
- Updated dependencies [584e7d9]
- Updated dependencies [2cdba11]
- Updated dependencies [54424c9]
- Updated dependencies [5aafe95]
- Updated dependencies [788f63d]
- Updated dependencies [67a2c58]
- Updated dependencies [90a3111]
- Updated dependencies [6b30c51]
- Updated dependencies [f15b01b]
- Updated dependencies [31b48d4]
- Updated dependencies [03d4e4d]
- Updated dependencies [36520ce]
- Updated dependencies [f9f2352]
- Updated dependencies [ee3fe90]
- Updated dependencies [bdb1d89]
- Updated dependencies [284ad5e]
- Updated dependencies [7afb1e2]
- Updated dependencies [84d90d5]
- Updated dependencies [52f75d0]
- Updated dependencies [87b573b]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [7cf6870]
- Updated dependencies [ef0d241]
- Updated dependencies [b2e5888]
- Updated dependencies [63457d9]
- Updated dependencies [8a77b07]
- Updated dependencies [e937e67]
- Updated dependencies [4a53519]
- Updated dependencies [fb78eda]
- Updated dependencies [45f488e]
- Updated dependencies [d0a58b7]
- Updated dependencies [6832713]
- Updated dependencies [6832713]
- Updated dependencies [12ca8d6]
- Updated dependencies [12ca8d6]
- Updated dependencies [232ffe8]
  - @getdomovoi/daemon@0.1.0
  - @getdomovoi/ui@0.1.0
