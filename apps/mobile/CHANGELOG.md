# @getdomovoi/mobile

## 0.1.0-alpha.0

### Minor Changes

- 68833ac: A message without a `review` sends no comment. Ruling Q402: the legacy default that attached every
  open comment of the session to a `session.send` carrying no `review` is removed before protocol
  0.8.0 ships. On the wire, `session.send` without `review` now composes the same provider prompt
  as `review: { annotationIds: [] }`: no comment, no build basis, and a handoff context that lists
  no open annotation. The daemon never fills in a review; the only comments that reach the agent are
  the ones the message names. `review` stays optional rather than required, so a daemon cannot
  invent one and a client built before the field keeps sending words; such a client loses the
  comments it never named.
  
  Every client now states its review. Desktop and web (`packages/ui`) and the phone and tablet
  (`apps/mobile`) list a session's comments as open without yet offering the drawn choice of which
  to send, so a send names every open comment of that session, read from the latest snapshot at the
  moment of sending: `openCommentReviewFor` in `@getdomovoi/protocol` keeps the newest up to the 20
  a message may carry, the order the daemon delivered under the old default, and names no build
  basis. When more comments are open than that, the review also carries `omittedOverLimit`, the
  count of older open comments it left out. The wire accepts the count only on a full review, as a
  positive whole number up to 1,000,000. The daemon records it in the sent message's
  `providerPromptDelivery.annotations` (`availableCount` and `omitted.limit`) and tells the agent
  the count, but composes only the comments the review names; the count never selects a comment. A
  queued message keeps the count until release. Desktop and web show the record with the existing
  delivery note line, and the phone and tablet show the same sentence under the sent message, so a comment
  that missed the turn stays visible after the send succeeds. The sentence is
  `annotationsOverLimitLine` in `@getdomovoi/protocol`, the one copy every surface and the History
  tab read; the History tab's `annotationsOverLimit` carries the same `omitted.limit` count, so it
  includes the count a review reported. A message that starts a session the
  client just created, and a `DomovoiClient.sendMessage` given no review, send `{ annotationIds: [] }` explicitly rather than leaving the field out. The
  chosen preview stays a viewer bookmark until the dock sends it (ruling Q342 A). The command line
  sends no message.
  
  A queued message persisted before this change with no review is released as it was queued and
  sends no comment.
  
  An annotation ID is now at most 256 UTF-16 code units, the same bound a send's review uses for
  the IDs it names (ruling Q432 A), so every open comment can be named in a review. A longer ID is
  refused where it enters, for example a session transfer import. The delivery record keeps a
  comment's ID exactly as stored.
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
- 6542cb3: Finish the unblocked V2 phone, tablet, and web interface parity work.
- 42f7640: The phone approval screen draws three facts the daemon now sends with a gate. Turn from names the
  client that started the turn: "you, on this phone" when the attribution carries this phone's paired
  device id, "another phone" when it carries a different device id, and otherwise only the client's
  kind, which is all the phone can say before it knows its own id. Outside project says whether the request reaches outside the session worktree
  and the basis it was judged on: the path it names, or where it runs, which does not cover what the
  command reaches. Plan gives step n of N when a step of the session plan is blocked on this approval.
  A fact the daemon did not send is not drawn. A watching phone shows the same facts.
- 22abb25: The phone has a Tools screen, opened from the connected machine's card on Machines. It reads
  `tool.inventory` and shows what the open repository holds back, every entry grouped by the file
  that declared it, with the reason each is held back and the repository's trust state. A file that
  could not be read is named with its reason, and entries the daemon left out are counted, so the
  list never reads as whole when it is not. A repository that cannot be trusted lists why. A footer
  says trust is granted from desktop or web; the phone has no control that trusts or takes trust
  back.

### Patch Changes

- aa1b14e: Blur what sits behind the floating bars on Android.
  
  expo-blur's Android BlurView blurs one named view, its `blurTarget`, and draws no blur when it has
  none. The tab bar, composer, decision bar, denial bar and Tools footer had no target, so on Android
  they showed only the 60 percent wash over sharp content. Each screen now wraps the content those
  bars float over in a `BlurBackdrop` (expo-blur's `BlurTargetView`), and every `FloatingBar` reads
  that target from a provider at the root. A bar is never drawn inside the target it blurs, because a
  blur that samples itself has nothing stable to sample. iOS draws as before: it blurs whatever is
  behind the bar without a target, so the backdrop is a plain view there and no target is passed.
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
- 1dd9ee7: The approval card offers Always only for a request the daemon resolved. A request it could not
  resolve, such as a Claude Read, Glob, Grep or Task, a WebFetch or MCP call, a read outside the
  worktree or an edit aimed at the worktree root, cannot become a standing rule and the daemon refuses
  one, so the desktop and web card, the phone approval screen and the tablet card no longer show the
  button there. The desktop and web card also no longer offer Always on a hard gate, which the daemon
  refuses too; the phone and tablet already did not. Allow once and Deny are unchanged.
- 1dd9ee7: An Allow now answers the approval card the person saw. When a file-tool card's target changed
  while it waited, the daemon updated only the card's execution record, which no card shows, so a
  second Allow could approve a different file, or make a standing rule for it, without that file ever
  being on screen.
  
  Approval cards carry a `revision`, a non-negative integer that the daemon raises each time it
  rewrites a card. A card saved before this reads as revision 0. `approval.resolve` takes the
  `revision` the client showed: it is required for `allow-once` and `always-project` and optional for
  `deny` and `deny-explain`. The daemon refuses an Allow whose revision is not the card's current one,
  with "The file target changed; review the updated approval before allowing it" on a file-tool card
  and "The resolved command changed; review the updated approval before allowing it" on any other.
  The desktop and web card, the phone approval and denial screens and the tablet card send the
  revision of the card they show. The protocol version stays 0.8.0.
  
  A file-tool card's Affects line names the file the edit reaches, read the way execution resolution
  reads it: "The file src/index.ts in the session worktree.", or, when the file is outside the
  worktree, "The file /path, outside the session worktree." with ", through a link at <path>" when a
  link inside the worktree leads there. A path that names a credential file, or that a link carries to
  one, shows as [REDACTED], and the card is a hard gate: it offers no Always, and no standing rule or
  Build auto answers it. Other text passes through the durable secret redaction; a card whose path
  that redaction changes is a hard gate too, as a secret anywhere else in a card makes it. Control characters in the path are
  escaped and a path past 512 characters is shortened in the middle. The line is set when the card is
  raised and read again when the card is answered: if the file changed, the card is rewritten with the
  new line under the next revision, broadcast, and the Allow is refused. Every Allow on a file-tool
  card is read again this way, including a card the daemon could not resolve (a file with another
  hard link, say), and a change in its target, Affects line, sensitivity or execution record rewrites
  the card and refuses the Allow. An unresolved card still offers no Always.
  
  A blocked or unresolved record reads the same whatever is at the file, so the daemon also reads the
  file itself when the card is raised, with lstat alone and without opening it: the kind of entry
  (regular file, directory, FIFO, socket, device, link or nothing), its device, inode and link count,
  and the path it really leads to. On Allow it reads the file the same way, and any difference is a
  change whatever the record says: a file swapped for a directory, a FIFO, a link, another hard link
  or another file, or removed, rewrites the card and refuses the Allow. A file with nothing at it
  then and now is unchanged. A file that cannot be read on Allow, at its path, in a directory on the
  way to where it leads, or there, counts as changed even when the reading kept with the card could
  not be read either, since two such readings match whatever lies beneath: the card is rewritten and
  the Allow refused, and each Allow is refused while the file stays unreadable. The path Claude Code
  blocked on is kept with the card in memory, so the
  file resolves on Allow as it did when the card was raised. A file-tool name with whitespace around
  it is that tool: the card, its record and what the card hides use the trimmed name.
  
  A card whose Affects line shows [REDACTED] carries `{ state: "unresolved", reason:
  "sensitive-content" }` as its execution record in every copy the daemon saves or sends
  (`workspace.get`, `workspace.changed`, the saved store), so no client receives the path the line
  hides. The daemon keeps the real record in memory only, for the reading on Allow, and forgets it
  when the card leaves.
  
  A card's directory is the directory the request runs in. A path Claude Code blocked on is sent
  beside the request as `blockedPath` and is never the card's directory; before this the Claude
  adapter sent it as the request's directory, so a blocked credential path reached every client and
  the saved store. A directory that names a credential store, or one the durable redaction changes,
  shows as "[REDACTED] in the session worktree" or "[REDACTED], outside the session worktree", the
  card is a hard gate, and a resolved execution record, which names the directory, is replaced as
  above and kept in memory for the reading on Allow.
  
  A card's operation and command lines hide each path the card hides: a credential file, a file
  whose path the redaction changes, a hidden directory, and a path Claude Code blocked on that names
  a credential file or that the redaction changes (such a card is a hard gate too). The exact path is
  replaced with [REDACTED] wherever it stands whole, as written, from the request's directory, where
  it really leads, and relative to the worktree, and the rest of the agent's text stays. The path
  relative to the request's directory counts too, from that directory as given and as it really
  lies, so `.env` or `../src/.env` for a hidden `src/.env` is replaced. Each relative form is
  replaced with "/" or "\" and with or without a leading "./". A name that
  only starts with the path, such as `.env.example` beside a hidden `.env`, is kept. The lines reach
  `workspace.get`, `workspace.changed`, the saved store, the approval receipt and the error log in
  that form. A file hidden only when the card is read again is hidden in the card's text from that
  revision on. A package script whose command line hides a path is read again on Allow from the
  command as the provider sent it, kept in memory until the card leaves.
- 2f29554: Claude Code sessions now refuse, with a message that says what to install, the two installs the
  Claude Agent SDK cannot run. On Windows the SDK starts `claude` without a shell, so the npm `claude`
  shim and `claude.cmd` failed with a raw spawn error; the daemon now takes only the native
  `claude.exe` and otherwise names the shim it found. And nothing tied the installed Claude Code to
  the SDK, which passes the flags of the version it was built against (`claudeCodeVersion` 2.1.263
  for SDK 0.3.263); an older `claude` is now refused with "Update Claude Code to 2.1.263 or newer".
  
  Provider readiness carries the same text in a new optional `problem` field. The desktop and web
  clients show it in Settings and first run, label the provider "Cannot start", and keep it out of
  the launcher. The phone skips such a provider when it starts a fresh session and
  says the problem when no other provider is ready.
  
  The version is read without blocking the daemon's event loop, before a session starts or models
  are listed, and once per executable and modification time. A bare `claude` that a probe with no
  PATH ran on Windows is not called a shim, since Windows starts `claude.exe` for it.
  A `claude` the operating system cannot start at all, such as a `claude.exe` that is not a Windows
  program, leaves the version unknown instead of failing the session start or the model list with
  a raw spawn error.
- dffe022: Mark the point where a provider compacted its context. A system thread row can now carry a context-compaction notice, and clients draw that row as a boundary in the transcript rather than as a general system banner. The copy states both halves of what happened: the provider stopped reading the turns above it, and Domovoi still holds them. A snapshot written before the notice existed keeps parsing, and every other system row keeps its existing styling and detail line.
- 7229239: Pin js-yaml 4.x to 4.3.2 or newer. GHSA-2883-xcg3-v3hh names both 4.3.2 and 3.15.2 as patched, so the 3.x consumer keeps its own patched version rather than being forced across a major.
- 64e9c45: Offer the ride back whenever a thread sits away from its bottom. A streaming
  reply grows one row rather than adding rows, so the unseen count can stay at
  zero while the thread keeps moving, and the pill used to stay hidden. The
  count is still the label when there is one.
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
- dc54753: Under a render's variants the phone says once that choosing the build basis happens at a desktop.
  The second line that repeated it is gone, as the design draws it.
- 80de8a3: Under a render's variants, the phone no longer says choosing a variant decides what the agent builds
  on. A desktop can mark one variant, but only as a bookmark for whoever is viewing, and the agent is
  not told, so the line says that and that a comment is how to tell the agent.
- 8500ac8: Receipts in a phone thread's history are compact: the verdict, the checkpoint line and what was
  decided. The full record, its notes and Watch the rest of the turn appear only on the latest receipt
  of the turn that is still running. The record no longer lists how long the gate waited.
- 2af814b: Phone and tablet correctness. The app keeps one daemon connection: a wake or Retry while a dial is still connecting no longer opens a second one, and a replaced connection can no longer apply deltas twice or turn the live one into watching. A frame the app cannot read (invalid JSON, a snapshot, delta or fleet that fails the schema, or a hello answer that is not a snapshot) is reported in the connection banner instead of dropped. A render error shows a recoverable screen instead of closing the app.
  
  Pairing keeps the kind the code was issued for. A tablet code greets as a tablet, a code for a desktop, web browser or the command line is refused with what to show instead. A credential with no stored kind, one saved before this change or a token typed into Settings, greets as a phone and, if the daemon refuses that credential, tries once as a tablet and keeps the kind that works. A pairing refusal now names a protocol mismatch (and that the code was not used) or a full device list, instead of calling every code spent.
  
  A watching device says a waiting decision waits on a full-access device, on the tablet session list and the phone's jump pill. The tablet thread shows a policy refusal's rule, who set it, where it applies and the remedy, as the phone does. The tablet shows the connection banner, including the out of date notice. A watching tablet is offered no review controls, and a review that fails to post keeps its draft and says why.
- 77ebd4c: The phone draws the Domovoi mark where the v2 design does: beside the Sessions title, paired or
  not, and above the wordmark while the app starts and reaches its machines. It is drawn from the
  design's assets as vector paths in the brand colour, in the form the brand handoff gives its size:
  the full mark, with its mustache, at 28px and above, and the reduced mark below. At launch the
  mark is drawn in its working variant, with the eyes widened as the brand handoff specifies. A
  refused credential keeps its own sign instead.
- 533c2fb: A session holding more than one approval counts its wait from the earliest of them, and its card in
  the Sessions list opens that approval. The clock used to start at whichever approval the snapshot
  listed last while the card opened the first listed.
- 7eac656: While the phone retries a connection that failed, the screen keeps the unplugged sign instead of
  the Domovoi mark, so a failure is not read as the app starting up. The mark leads only the first
  contact of a launch and the restore of a saved pairing.
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
- cb716da: The phone reads the fleet when Sessions opens, not only when Machines does, so the Everything is
  idle card's machine rows and the UNREACHABLE line show on a fresh launch into Sessions instead of
  waiting for the fleet to change.
- 35de80d: The phone's gate screen now reads as the design draws it. The header names the session the gate
  belongs to instead of the word Approval, the headline says Waiting on you in the gate's amber, and
  the body says Nothing has run yet. under the operation. A watching phone, which cannot answer, is
  told the gate is waiting on a full-access device instead.
- 7300598: When the daemon refuses a decision with a message that ends "The approval is still waiting.", the phone quotes that message and no longer adds its own "The gate is still waiting." after it. Other refusals keep the phone's line.
- b768055: The phone says that gates reach it only while Domovoi is open on it. The line appears in three places: above the sessions list, in a new card shown after pairing, and under a Notifications row in Settings. The row is dimmed, cannot be tapped and reads "Not yet". The card names the machine, the route and the device id the machine assigned. It stays on screen until Open Sessions is tapped. A tablet shows the same card centred and names the tablet.
- 08d34e9: A start from the phone that the daemon refused because checking the repository out would run a
  git filter its own Git config sets now shows the refusal in the start sheet: Domovoi refused, the
  reason code, the filter drivers it names with their git config scope, and that nothing ran. See
  what is held back opens the phone Tools screen, and the sheet says Trust from desktop or web where
  trust would lift the refusal, beside A phone shows this but cannot trust it. A refusal for a
  repository that is already trusted says its Git filters are held back until they are reviewed
  again, and also says Trust from desktop or web. The phone still cannot trust. The Tools screen
  lists the repository's filter drivers under their git config file, and says the list is not complete when the daemon could not read the Git config or left
  filter entries out.
- 6c7f53c: The phone Tools screen keys each held-back file group by its kind, scope and path, so one Git config file read from both the repository's config and a worktree's config.worktree shows as two groups that keep their own filter rows across a refresh.
- 17c127c: Before it pairs, the phone heads the machine's grant list with THIS PHONE WILL BE ABLE TO (THIS
  TABLET WILL BE ABLE TO on a tablet) and marks each line with a dot, green for a grant and blue for a
  limit, as the machine's pairing card does. The line terminal output waits on is no longer drawn in
  the warning colour.
- 4d07793: The phone's RPC client is typed against the protocol: each call's params are checked when the app compiles, and each answer is read by its method's result schema and the JSON-RPC response schema before anything waiting on it runs. An answer that fails is reported as an out of date app instead of being used. The phone no longer sends a client field on approval.resolve, which that method does not take. Thread rows that did not change are not drawn or parsed again on a keystroke. The app now builds under the repository's strict TypeScript settings. The review screen no surface reached is removed.
- ba09771: Under the Everything is idle card, a machine that answered and asked to be paired again says Pair
  again instead of when it was last seen. Last seen is kept for machines that do not answer.
- bd7dd7f: Under the Everything is idle card, a machine that does not answer says when it was last seen in a
  few words, last seen 2d ago, on one line that gives way to the machine's name. It used to print a
  sentence that repeated the name and could crowd it out.
- e196905: The Everything is idle card on the phone no longer always says two machines are answering. It
  counts the machines that answer from the fleet the daemon reported, names the machine the phone
  reads when it is the only one, and vouches for no work in flight only on that machine, because the
  fleet list carries no other machine's sessions. The fleet is listed under the card, one row per
  machine with its light and how it is reached or when it was last heard.
- da5ab94: While the phone says it is not connected, the fleet rows under the Everything is idle card lose their
  green lights, because a fleet read before the drop no longer says which machines answer.
- cbd4d2c: While the phone says it is not connected, the Everything is idle card no longer counts machines
  as answering from a fleet read before the drop. It says the machine had no work in flight when
  last read.
- 4301c04: Add a platform key custody probe for P-256, and repair the Reanimated pin that stopped an iOS prebuild.
- 36a4674: A screen reader no longer announces the Domovoi mark. Every place the phone draws it, a heading or
  the wordmark beside it already names the screen, so on the splash Domovoi was read out twice.
- 89a7ada: The Pair this phone card on Machines draws its actions in the card's own blue, as the design does:
  Scan a code is filled with the card's ink and Type it is outlined in the card's border, instead of
  the brand indigo and a grey outline. The card's title is semibold.
- d3e53af: Pairing reads as the design's sheet: a close control and Pair with a machine at the top in place of
  the page heading and the Cancel button at the foot, a viewfinder that fills the screen with its
  four corners drawn and the hint beneath them, and Or type the code in sentence case with a filled
  field. Once paired, the same control closes the sheet.
- 0a81f16: A PLAN.md read on the phone marks list items with a small dot instead of a bullet character, gives
  inline code and checkboxes their 4px corners, which the radius scale had silently dropped, sets
  inline code at 12px and rounds code blocks to 14px, as the design draws the document.
- 82bc1c5: A command refused by policy now says why the phone offers no approve button: There is no approve
  button here, because no decision of yours can permit it. The daemon refused before the command ran.
  The Refused by policy heading is drawn at the design's size with its red dot.
- 9385bb7: A phone receipt no longer calls a legacy receipt's client id a Credential. That id is what the
  client declared when it connected, and no paired credential vouches for it, so RECORDED AS lists it
  as Declared client. The receipt no longer says the audit row names this phone's verified
  credential: a receipt records a client kind and a connection id, and a daemon credential typed into
  Settings can declare phone too, so the phone cannot show that claim is true.
- 68b676b: A receipt for a command that ran past an hour says hours and minutes, 1h 5m, instead of 65m 20s.
  The tablet's decided after line, the gate's wait, reads the same way.
- f1b826f: A decision receipt on the phone now names the checkpoint the daemon took before an allowed command,
  by its commit, and how long the command ran once it finishes: Checkpoint 8f3c1de was taken first,
  then it ran in 12s. The run time comes from the receipt's ranForMs. The receipt used to show the
  time the gate waited for an answer under the label Duration, as though it were the run time; that
  row is gone. RECORDED AS lists the decision, the client it was decided on and the checkpoint. A deny
  no longer wears the success colours and never claims a checkpoint was taken.
- daff23c: The phone follows a watched terminal's grid and ages fleet heartbeats by the daemon's clock.
  
  A phone watch now asks `terminal.watch` with `followResize`, so the cols x rows it names follows the
  holder's resizes as `terminal.resized` arrives, rather than waiting for the next list. The phone
  draws text lines that wrap at its own width, so nothing else changes. A daemon from before the
  notice refuses the field as invalid parameters, and the watch is asked for again without it. A late
  answer to a watch asked before the person left and came back no longer ends the newer watch.
  
  Machines and the Sessions fleet lines measure how long a machine has been silent from the
  `daemonTime` of the fleet snapshot that carried its heartbeat, kept with that snapshot, so a phone
  whose clock is off no longer calls a machine heard from minutes ago silent for hours. A daemon that
  sends no time is measured on the phone's clock, as before. How long a session has waited on you is
  still measured on the phone's clock.
- 3297017: A message that fails to send shows its reason only on the session it was sent to, and keeps it there.
  A failure that arrived after the person had moved to another session used to show on that session's
  composer, and moving between sessions cleared it, so coming back to the session showed nothing while
  the message was gone. The reason now stays with its session until the person types, sends again or
  changes the skills there.
- fd33ce3: The unpaired Sessions screen ends at Pair with a machine, as the v2 design draws it. The line The
  phone is a client. It never runs an agent itself., carried over from the first handoff, is gone.
- 9b4561b: Tell the agent on a policy refusal now says what it does during a running turn. When a message is
  already queued for the next turn, the refusal says the remedy replaces it and shows the queued
  message with its cancel. After the tap it says Sent. It will reach the agent when this turn ends.
  when the message went as the next turn's, or Sent to the agent. when it went straight to the
  session, read from how it was sent rather than from the turn's state at redraw, because the thread
  that would show the message is not drawn under a refusal. When the turn ended before the message
  arrived and the daemon held it, the refusal says Held. It will not reach the agent on its own., and
  the queued message beside it gives the daemon's reason.
- 1a63284: A command refused by policy offers Tell the agent on the phone, which sends the refusal's remedy to
  the session as a message, the same way a typed reply goes. It shows only on a phone that can steer
  the session, and a send the daemon refuses says why under the button.
- 1477a11: Read a session's terminals on the phone, Phone v2 frame 04.
  
  The phone lists the open session's terminals (`terminal.list`), again every ten seconds while the
  session is open because nothing announces a new one, watches each (`terminal.watch`) and applies
  live `terminal.output`, `terminal.closed` and `terminal.ownership`, then unwatches them when the
  person leaves the session. The thread shows each terminal's tail with Show all N
  lines; the full view names the device that holds the claim, says Live, Failed, Closed or
  Unconfirmed, marks where the daemon's record starts and where live output begins, and offers
  Follow output and Jump to latest. It is read-only: the phone never types, resizes or claims. The
  attach sheet's Terminal output row now says picking output to attach is what is not built.
- 520cdcc: Messages in a phone thread are drawn as the v2 design draws them: yours in a bubble filled with the
  primary colour, the agent's in a bordered card, each tailing toward its own side. The diamond that
  stood in for the agent, which a screen reader read aloud, is gone.
- dee0c92: On an unpaired phone, Machines lists what stays unavailable with a reason for each: Sessions,
  nothing to list and nothing hidden; Machines, the screen that owns pairing; Machine settings, which
  live on a machine and wait until one is paired.
- ef710ac: The phone's Sessions list names fleet machines that do not answer under UNREACHABLE, each with when
  it was last seen, below the sessions it can read. Idle sessions stay under QUIET. The phone holds
  no sessions from a machine that is not answering, so it lists the machine itself.
- 7ba960a: The Sessions tab wears the v2 design's message icon instead of the stacked layers it carried from
  the first handoff, and the unpaired Sessions screen draws its empty state as the design does: a
  dashed message icon in a round tinted well over a semibold headline.
- 76161a9: A session waiting on you in the phone's Sessions list says how long it has waited, after its
  machine, as the design draws it: macbook-pro-m3 · 4m. The clock starts when the approval was
  raised. Sessions that wait on nobody show no clock.
- 5a33539: Carry a `protocol-mismatch` payload on every `protocolVersionMismatchErrorCode`
  (`-32012`) refusal: the refusing daemon's protocol version, the client's, and the
  `protocolCompatibility` result between them, validated by `protocolMismatchSchema`.
  `system.hello` and `device.claim` send it with their sentence unchanged. The fleet
  dialer reads the peer's version from the payload and falls back to the sentence
  only for a daemon that predates it, and the phone names both versions from the
  payload with the same fallback.
- b2e05be: A receipt now names the paired device that decided. The receipt thread item and the approval
  history entry carry an optional `device`, the device's id and label in the shape a terminal owner
  names it, bounded like a paired device label. The daemon writes the id of the device record it
  verified on the deciding connection and the label that record has at the decision, when a person
  allows or denies a gate, reverts a file, archives a session or presses the emergency stop; a
  connection on the daemon credential has no paired device and writes none, and an archive resumed
  at startup has no connection and writes none. Renaming the device later does not rewrite a
  receipt. The label is redacted like other durable text when the daemon writes a receipt and when
  a session arrives by transfer. Transfer journals keep the received bytes unchanged, as they do
  for every other field. The daemon tries to remove a transfer's package after commit, and an abort
  also removes its payloads; if cleanup fails, the bytes stay until a later retry or the startup
  pruning of inactive transfers.
  
  The web and desktop receipt reads the label from the wire, before the client kind, as
  `decided from dana · phone, connection ...`; history rows read `decided on dana · phone`; the
  phone and tablet receipt reads `dana · phone · device fcbd…cdf8`. A receipt without a device,
  from the daemon credential or a snapshot written before the field, reads as before.
- 48dabb3: The session refusal card on desktop, web and the phone uses the danger family the Skills design draws for a refusal: danger border, background and text, and a destructive dot. On desktop and web the trusted line after a grant sits on the card ground with a success dot. A refusal no longer reads like held-back inventory.
- 584e7d9: Derive runtime build versions from release metadata. Fleet facts, daemon and client greetings,
  and provider initialization report the running release instead of a fixed development version.
  Production startup refreshes the persisted local version without changing machine identity.
  Wire protocol compatibility and existing pairings are unchanged.
- 6ddadb7: Add explicit terminal claim release, claim timestamps, and opt-in resize notifications.
  Released shells keep running unheld and require a new claim before input, resize, or close.
  Preserve claim times across reconnects, report `claimHeld` on ownership changes, and send
  `terminal.resized` only to watchers that request `followResize`.
  
  Resize notifications mark their position in the output stream before the PTY is resized.
  Already-redacted output queued before a resize is sent before the notice; output drawn
  for the new grid follows it. Text the redactor still retains at the resize, including
  complete lines, can follow the notice. Resizing does not release that text.
  While output is paused for slow readers, adjacent resize markers coalesce to the latest
  dimensions and wait for low water. Resizes with no eligible follower do not observe
  backpressure. Closing a terminal flushes queued output and markers before its closed notice.
  Joining or rejoining a paused terminal preserves that pause. The reply excludes queued
  output from its replay, so that text arrives once through the live stream after resume.
  Live joins also stop draining when delivery first pauses, retaining queued resize markers
  until low water. Same-client ownership moves through input deliver pending text to the
  new connection even though the input reply carries no replay.
  Reopening a same-client terminal with new dimensions captures its replay before resizing,
  so synchronous redraw output arrives only live, after the resize marker. The create reply
  reports the dimensions at the start of its queued live suffix when the connection follows
  resizes; other create replies report the new dimensions. A following watch reply also
  reports the starting grid of its queued suffix. Resize boundaries are retained even when
  no follower exists yet, so a follower joining during a pause receives old-grid output
  before the notice that advances it to the new dimensions. Without an eligible follower,
  resize boundaries wait for normal batch delivery instead of flushing partial output early.
  A retained boundary can split an output notification at that delivery, preserving the
  old-grid and new-grid ordering needed by a follower that joins before the queue drains.
  An empty replay has no start timestamp; if queued output exceeds retained history,
  the watch reply reports that earlier output was dropped.
  
  Protocol version remains `0.8.0`; new fields are optional and older watch requests receive
  no resize notifications.
  
  The desktop and browser terminal pane and the phone's terminal view read `claimHeld` from an
  ownership notice. After a release they say nobody holds the shell, and the former holder's pane
  stops sending input until it takes the shell again. A notice without `claimHeld` still means held.
- 10635fc: Surfaces say what exists: the phone's empty states print the pair command the machine really runs and no installer or `domovoi new`; the pairing credential is described as it is scoped; the fleet's UPDATE badge, which had no update path, is gone.
- ed78e31: The tablet's sessions pane draws the Domovoi mark beside the Domovoi wordmark, as Tablet v2 does,
  from the same mark component the phone uses.
- 88a92fd: When a tablet pairs, the field for the name the machine's device list will show reads Name this
  tablet instead of Name this phone.
- 4e5cad0: When a tablet pairs, the note under its grant list says the credential stays in this tablet's
  keychain; it used to say phone. Before the code is spent the note no longer names a client kind,
  because the pairing code does not carry one: it says the machine minted the credential for a phone
  or a tablet. Once paired, a device whose credential is of the other kind is told so, for example
  Paired as a phone, because the code was issued for one.
- 959d02c: The tablet's decision receipt says what the phone's says. A deny no longer wears the success colours
  or claims a checkpoint was recorded before it ran, an allow that could not take a checkpoint no
  longer prints Checkpoint no checkpoint, an allow that took one says Checkpoint 8f3c1de was taken
  first, then it ran in 12s, and the gate's wait reads decided after 38s instead of a bare number.
- 7d6f7f3: A device paired to watch only now sees every waiting approval in full, with no decision controls, on desktop, web, phone and tablet. The note under the gate says a device paired with full access answers it.
- Updated dependencies [309562f]
- Updated dependencies [1dd9ee7]
- Updated dependencies [5ee1825]
- Updated dependencies [6b2324b]
- Updated dependencies [df3452f]
- Updated dependencies [08e4f00]
- Updated dependencies [1204d6c]
- Updated dependencies [2adb117]
- Updated dependencies [2f29554]
- Updated dependencies [4cacf7a]
- Updated dependencies [dffe022]
- Updated dependencies [ab18590]
- Updated dependencies [711bee5]
- Updated dependencies [b7f7c95]
- Updated dependencies [279349c]
- Updated dependencies [d4228ee]
- Updated dependencies [9a015e9]
- Updated dependencies [0fed2e6]
- Updated dependencies [3d67826]
- Updated dependencies [68833ac]
- Updated dependencies [91b1e15]
- Updated dependencies [a894fcb]
- Updated dependencies [18f6543]
- Updated dependencies [5f104a3]
- Updated dependencies [9db320a]
- Updated dependencies [9e1e9c5]
- Updated dependencies [c32065a]
- Updated dependencies [4359bcf]
- Updated dependencies [8871313]
- Updated dependencies [d3e5aef]
- Updated dependencies [9d94da3]
- Updated dependencies [b8c55c2]
- Updated dependencies [16c242a]
- Updated dependencies [c3229d9]
- Updated dependencies [6b0e4fd]
- Updated dependencies [8ea383c]
- Updated dependencies [64e9c45]
- Updated dependencies [1204d6c]
- Updated dependencies [5ae04b0]
- Updated dependencies [b67435e]
- Updated dependencies [81c488a]
- Updated dependencies [b5b1aa9]
- Updated dependencies [a5f0f7e]
- Updated dependencies [fe7968f]
- Updated dependencies [59b1a7a]
- Updated dependencies [d5bdbe6]
- Updated dependencies [0c88e11]
- Updated dependencies [e6fa2ec]
- Updated dependencies [777efeb]
- Updated dependencies [e736472]
- Updated dependencies [66ade99]
- Updated dependencies [e68d767]
- Updated dependencies [cdf5f87]
- Updated dependencies [45e152d]
- Updated dependencies [02a1b58]
- Updated dependencies [3c2ae09]
- Updated dependencies [e268b8f]
- Updated dependencies [1c67fba]
- Updated dependencies [964c47d]
- Updated dependencies [973430f]
- Updated dependencies [7bea6a9]
- Updated dependencies [19aad21]
- Updated dependencies [e094929]
- Updated dependencies [20e7e91]
- Updated dependencies [9048458]
- Updated dependencies [5a33539]
- Updated dependencies [fb78eda]
- Updated dependencies [9387a5d]
- Updated dependencies [c3e566a]
- Updated dependencies [2b21f85]
- Updated dependencies [b2e05be]
- Updated dependencies [ef58e04]
- Updated dependencies [9c12124]
- Updated dependencies [cad2971]
- Updated dependencies [8523d3d]
- Updated dependencies [d5a77a5]
- Updated dependencies [2f4a95a]
- Updated dependencies [3ccf0f3]
- Updated dependencies [fc40225]
- Updated dependencies [f94caa0]
- Updated dependencies [a5a510e]
- Updated dependencies [e29f975]
- Updated dependencies [1dd9ee7]
- Updated dependencies [584e7d9]
- Updated dependencies [66a1846]
- Updated dependencies [fdc96ec]
- Updated dependencies [0b59f4f]
- Updated dependencies [31b48d4]
- Updated dependencies [36520ce]
- Updated dependencies [6ddadb7]
- Updated dependencies [e583a5a]
- Updated dependencies [f9f2352]
- Updated dependencies [ee3fe90]
- Updated dependencies [7e30caa]
- Updated dependencies [ea2b5ab]
- Updated dependencies [284ad5e]
- Updated dependencies [728416e]
- Updated dependencies [9266302]
- Updated dependencies [9b60965]
- Updated dependencies [01ce5da]
- Updated dependencies [1ed1cdf]
- Updated dependencies [cb8b27a]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [7cf6870]
- Updated dependencies [ef0d241]
- Updated dependencies [b2e5888]
- Updated dependencies [33c937f]
- Updated dependencies [b30b27e]
- Updated dependencies [b90c8de]
- Updated dependencies [fa621d6]
- Updated dependencies [d0a58b7]
- Updated dependencies [6832713]
- Updated dependencies [6832713]
  - @getdomovoi/protocol@0.1.0-alpha.0
