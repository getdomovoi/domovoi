# @getdomovoi/mobile

## 0.1.0

### Minor Changes

- 2e30deb: Render agent replies as markdown in the phone's session thread.
- 28a8a68: The phone's gate offers the third decision, "Always allow this here", which allows the command now and stops asking for it in this project; absent on a hard gate, where the daemon refuses a standing rule.
- 1469846: A comment on a render can be made from the phone: pick an element in the render, write, and it is sent as a reference to that element.
- cac2e63: The phone attaches up to two images to a message: a photo or screenshot from the library, or one taken now, each held to 1.5 MB and 2048 px before it leaves the phone, with the size line stating where the bytes go.
- fe7968f: Pairing by camera. The protocol gains `pairingPayloadSchema` and its
  encoder and decoder: the text a pairing QR carries, a daemon address (TLS,
  or plaintext on loopback only) and a client credential. The phone gains
  `expo-camera` and a Scan a pairing code screen that reads it, names the
  machine, asks once and connects; a refused camera pastes the same text.
- d5e7550: The phone pins the working plan: a strip above the thread names the step in progress, tapping it lifts the whole plan as a sheet over the thread, and Unpin collapses it back into the thread.
- c50c37d: The phone's working plan says when it was revised, lets a person rewrite one step in place, and says the edit applies at the next turn boundary.
- 37b3fa0: The phone fetches a preview's render from the machine with a signed grant and shows it in a frame, with the other variants of the same render as tabs.
- 2f47e5d: The phone keeps the daemon's relay identity pin in SecureStore and exposes it to the protocol's
  recovery and adoption functions. The compare runs under one queue per backing store shared by
  every handle, every write is confirmed by read-back, and an unconfirmed write is reported as
  unconfirmed; the writable store is constructed only in the app process.
  Once the daemon has answered the greeting (never on a snapshot pushed before it) the phone enrols the daemon's published relay
  identity as its trusted pin, or recovers a distrusted pin from the daemon's signed successor
  verified against the saved pin only.
  Pins are kept per machine, so pairing with a different daemon starts without one.
- b26506d: Group the phone's sessions under Needs you, Running and Quiet, needs-you first, with a count in each heading and a "need you" count in the header.
- f71e0a3: A session can be started from the phone as another like the one on screen: same machine, repository, provider and model, words from the person, Plan by default with the mode changeable.
- eedb10c: The phone draws text from a generated type ramp and enforces its own type floor in every screen and the tab bar, so no phone text falls under the size the design system sets for it.

### Patch Changes

- 7229239: Pin js-yaml 4.x to 4.3.2 or newer. GHSA-2883-xcg3-v3hh names both 4.3.2 and 3.15.2 as patched, so the 3.x consumer keeps its own patched version rather than being forced across a major.
- 6f3379c: Ship Instrument Sans and JetBrains Mono inside the phone bundle and register them
  before the first frame, with each text style naming its loaded face. The phone's
  colours, radii, and font names are now generated from `packages/ui/src/styles.css`,
  which gains the design system's desk, overlay, danger-on, and info ramp tokens.
- 3e396ce: A failed render fetch on the phone now says what is still true and offers to try again: the
  artifact is on the machine, the comments below are live, only the picture is missing. A fresh
  session reads as ready rather than empty: "Nothing has run yet. The session exists, the worktree
  is cut, and the agent has not been given a turn. Your first message is what starts it."
- a5f0f7e: The phone's thread follows a reply only when the person is already at the bottom. Scrolled up
  to read an earlier turn, the viewport holds still while new output lands, and a pill above the
  composer offers the ride back: "3 new" with a primary dot, or "Waiting on you" on the warning
  ramp with a pulsing dot when a decision arrived below. 44px tall for a thumb. Before, every
  growth of the thread scrolled to the end regardless of where the person was.
  
  `threadFollowState` and `threadFollowPillText` live in `@getdomovoi/protocol` so every surface
  with a thread derives the same three states.
- ccc9dd1: Show the socket's own error or close reason when pairing fails.
- f9a8a99: The phone's Stop everything keeps pausing and killing apart: Pause everything stops at the next turn boundary through system.pauseAll, and Emergency stop is its own control that asks again and says what it destroys.
- 55492e9: Unpinning one session's plan no longer unpins every other session's.
- 9cb178a: A decision receipt in the phone thread names who decided, the credential, the checkpoint and how long the decision took; an explanation stays with the decision.
- d738bee: When the daemon connection drops while a session, an approval or an artifact is open, the
  phone says so on that screen: the banner that already appears on the lists now appears there
  too, saying what is drawn is the last state the phone was sent. The composer refuses to send
  while the socket is not open and says the session is still on the machine. A decision that
  did not come back confirmed keeps the gate on screen with the reason where the buttons are.
  The phone claims only what it can prove: a frame that never left is "Not sent … The gate is
  still waiting"; a frame that left with no answer is "The daemon went away before it confirmed.
  The gate may or may not have been answered; when the connection returns, this screen shows
  which." Before, the rejection was unhandled and the screen showed nothing.
- f2ed466: The sessions header names the machine whose sessions these are and scopes the running count
  to it: `macbook-pro-m3 · none running · 2 reachable · 1 offline`. Before it read
  `3 machines · none running`, a claim about three machines from the data of one; a machine that
  did not answer was rounded into "none running". No results and not searched are different
  answers.
- d7139a4: The phone thread follows a reply that lands, and the composer clears the keyboard by the top inset it sits under.
- c04e75f: Give the phone's Fleet tab the facts it can stand behind. Every machine row now
  says how it is reached, a machine that has stopped answering says when it was
  last heard from, a daemon running inside WSL names its distribution, and the
  title says how many machines answer and how many do not. The card for the daemon
  this phone is connected to carries its session and tool counts, read from the
  workspace snapshot it already holds; no other row gets them, because `fleet.list`
  carries no counts for another machine. The phone also takes the daemon's
  `fleet.changed` push, so a list on screen stops describing the moment the tab was
  opened. Waking a machine and pairing one from the phone are still not offered,
  because neither has a protocol call behind it.
- 4301c04: Add a platform key custody probe for P-256, and repair the Reanimated pin that stopped an iOS prebuild.
- 5a33539: Carry a `protocol-mismatch` payload on every `protocolVersionMismatchErrorCode`
  (`-32012`) refusal: the refusing daemon's protocol version, the client's, and the
  `protocolCompatibility` result between them, validated by `protocolMismatchSchema`.
  `system.hello` and `device.claim` send it with their sentence unchanged. The fleet
  dialer reads the peer's version from the payload and falls back to the sentence
  only for a daemon that predates it, and the phone names both versions from the
  payload with the same fallback.
- 584e7d9: Derive runtime build versions from release metadata. Fleet facts, daemon and client greetings,
  and provider initialization report the running release instead of a fixed development version.
  Production startup refreshes the persisted local version without changing machine identity.
  Wire protocol compatibility and existing pairings are unchanged.
- 10635fc: Surfaces say what exists: the phone's empty states print the pair command the machine really runs and no installer or `domovoi new`; the pairing credential is described as it is scoped; the fleet's UPDATE badge, which had no update path, is gone.
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
- Updated dependencies [9d94da3]
- Updated dependencies [1204d6c]
- Updated dependencies [5ae04b0]
- Updated dependencies [b67435e]
- Updated dependencies [b5b1aa9]
- Updated dependencies [a5f0f7e]
- Updated dependencies [fe7968f]
- Updated dependencies [59b1a7a]
- Updated dependencies [0c88e11]
- Updated dependencies [e736472]
- Updated dependencies [66ade99]
- Updated dependencies [cdf5f87]
- Updated dependencies [3c2ae09]
- Updated dependencies [1c67fba]
- Updated dependencies [964c47d]
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
