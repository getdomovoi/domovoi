# @getdomovoi/daemon

## 0.1.0-alpha.0

### Minor Changes

- 5ee1825: A person's allow now takes a checkpoint before the agent hears the decision. Allow once and
  always allow in this project take one; a denial and a standing rule or Auto allowing a command
  take none. The agent is still mid-turn, so the checkpoint is a snapshot: a commit built in a
  temporary index and kept under `refs/domovoi/checkpoints/`, with HEAD, the branch, the index and
  every file left as they were. The receipt names that checkpoint's commit. If the checkpoint cannot be taken, the
  command does not run, the gate stays open and the person is told to decide again. When a
  submodule has changed tracked files or untracked files, the checkpoint could not hold them, so the
  allow is refused the same way and the message says so. A session with
  no worktree records the checkpoint as unavailable.
  
  The receipt also says how long the allowed command ran, as `ranForMs`, once the agent reports the
  command's item complete. Gates now carry the provider's `itemId` so the daemon can match that
  completion. When the turn ends or the daemon restarts before the item completes, the receipt has
  no run time. Session history carries `ranForMs` on approval entries.
- 6b2324b: Approval cards carry optional attribution for the client that started their turn and a realpath-aware outside-project fact relative to the session worktree. Each containment value names its path or working-directory basis; working-directory containment does not restrict a command's reach. Working-directory facts require a directory reported for that specific command. Reloaded cards omit working-directory containment because their saved directory is display text, not the original request evidence. Unknown facts stay absent, including on older saved cards, and phone and tablet snapshots retain the facts.
  
  Export `approvalPlanStep` to derive a current 1-based step and total from the session plan's approval blocker without storing a stale step number on the card.
- df3452f: A checkpoint the daemon takes before an allowed command now says why. `checkpointReasonSchema`
  adds `before-approved-command`, and the daemon sets it on the checkpoint it records when a person
  allows a gated command. The thread item and its session history entry carry it, so a client can
  name the reason beside the time instead of showing only the time. Checkpoints recorded before
  this change carry no reason, as before. The desktop checkpoints list reads it as "before an
  approved command".
- 08e4f00: A session names the branch its worktree is on (`branch`, `domovoi/<session id>`) from creation
  and fork, and an archived session says how many files that branch changed that the source
  checkout never received (`unmergedFiles`, read at archive before the worktree is removed: files
  differing between the merge base with the source's HEAD and the branch, so a branch merged
  before archive says 0). Both feed the archived notice, "Branch <b> and its final checkpoint are
  kept" and "N files never merged". Sessions from an older daemon carry neither field.
- 1204d6c: Enroll fleet peers through a source-daemon-owned, authenticated exchange and refresh their reported facts with bounded heartbeats. Keep machine credentials in the OS keychain, publish pending cross-store operations honestly, and distinguish confirmed from unconfirmed remote revocation when forgetting a peer.
  
  The wire protocol moves to 0.4.0. Replace device.saveCredential and device.machineCredential with fleet.enroll and fleet.forget; fleet.list now returns the machine, pending, and unenrolled entry union. Older peers must update, but existing bound credentials and valid 0.3 workspace state are preserved without another forced pairing cycle. Enrollment does not grant a client credential for remote Use or Terminal.
  
  Keep legacy recovery rows visible beyond the 128-machine admission limit, bound wire snapshots to 512 entries, and report overflow without truncation. Local fleet-keychain recovery commands list IDs without credential bytes and remove a named local key only after the operator confirms Domovoi is stopped; remote revocation remains a separate action.
  
  Fix canonical transfer serialization of undefined optional fields, so real working-plan edits survive a machine transfer with the repository and history.
- 800de19: Add bounded update metadata discovery and signature verification.
- 2b6d28e: `domovoid service install` run from the runtime the Domovoi app ships (its launcher in `<resources>/daemon-runtime/bin`) no longer points the login service into the app. It first copies that runtime under the profile, to `<profile>/runtime/<version>/<id>`, the same copy the app's Install makes, publishes it under the service-operation lease after the profile checks, and records the service and `service.json` against the copy. It prints where the copy went. Inside WSL it makes the same copy, under the same leases, and registers the Windows task and records `service.json` against it. As the app's Install does, it makes the copy in a private staging directory under the system temporary directory and leaves that directory there by design: empty after a publish, holding the partial copy after a failure. A check that the path is still that directory cannot be bound to its removal in Node, so a directory swapped in between would be removed instead (security review round 8 of #577). When the system temporary directory is on another volume from the profile, as a tmpfs `/tmp` is on Fedora, Arch and Debian 13 with `TMPDIR` unset, it stages under `${XDG_STATE_HOME:-~/.local/state}/domovoi/runtime-staging` instead (not on Windows), with the checks the app's data directory gets (same volume as `<profile>/runtime`, a real directory, outside every profile and repository), and ignores a relative `XDG_STATE_HOME`. Besides `<profile>`, `<profile>/runtime`, `<profile>/runtime/<version>` and the copy, the only directories it may create are a private staging directory under the system temporary directory or, in that fallback, the missing ones among `<state>`'s ancestors, `<state>`, `<state>/domovoi` and `<state>/domovoi/runtime-staging` (with `XDG_STATE_HOME` unset, at most `~/.local`, `~/.local/state`, `~/.local/state/domovoi` and its `runtime-staging`), each private to the user, and one private staging directory inside `runtime-staging`. The only thing it deletes is what the app's Install deletes after a confirmed change (#635, `removeUnusedDaemonRuntimes` with the same rules): once the service manager has accepted the new service, the copies under `<profile>/runtime/<version>/<id>` that neither the new service nor the one before this install runs. Inside WSL it deletes nothing. Right before it makes each of those, it checks that the directory above is still the one it checked or made, by device and inode, and refuses if not; the instant between that check and the mkdir is not covered, since Node has no mkdir relative to an open directory, so another process of the same user could still have one empty directory made through a link it swaps in there, the same residual race round 8 of #577 accepted for the staging directory. A refusal names the directory that could not be used, and lists any directories it had already made, which hold no files. The copy routine, for the CLI and the app's Install alike, now also pins `<profile>/runtime/<version>`, the directory the copy is renamed into, by device, inode and real path, and checks it and the destination's absence again right before the rename. It also pins the staging place it chose (the system temporary directory, the app's data directory or the state directory fallback) when it checks or makes it, checks it again with every check it passed right before it makes the private staging directory there, and checks that directory, a real directory right under the place, before the copy goes in and before the copy is moved out. Ruled Q411 A, as round 8 of #577 did for the staging directory, the instants between those checks and the calls after them stay open, since Node has no mkdtemp, copy or rename relative to an open directory: another process of the same user could have the private staging directory made, or this copy of the shipped runtime written, in a directory it swaps in, or could move this copy into another directory on the same volume or a directory of its own into the profile's runtime directory, replacing and removing nothing, where that user can already write the profile. Those windows are open to that user alone (security review round 2 of #712): a staging place, and every directory above it, must be one no other account can change, or it is refused, naming the directory that failed. That check reads the place's real path, so every later staging call (the missing directories, the private staging directory, the copy into it and the rename out of it) goes through that real path, not the spelling given: a link above the place, in a directory another account can write, cannot redirect them after the check (security review round 3 of #712). On macOS and Linux each must be owned by the user or root and writable by neither group nor others, unless owned by root with the sticky bit set, as `/tmp` is; a group-writable directory is refused even when the group holds only the user, which cannot be read (Q413 A). On macOS each must also have no access control entry that allows anyone but the user's own user entry to change it (to write, add, append or delete entries, or change its attributes, access rules or owner), read with `/bin/ls -lde`; deny entries pass, such as the `group:everyone deny delete` macOS gives every home folder, and a list that cannot be read refuses the place (security review round 3 of #712, Q415 A). The command's refusal then says what fixes it: for the user's own directory that group or others can write, `Run chmod go-w <directory> and try again.`; for one another account owns, that it belongs to another account, with no chmod; for one refused for an access control entry, neither, since chmod go-w does not remove an entry; each beside the advice to set `TMPDIR` or `XDG_STATE_HOME` elsewhere. The app's refusal names that directory and the check it failed, with no chmod command, instead of saying the profile is on a different volume, which it still says for every other staging refusal. On Windows, where Node cannot read ACLs, the place must be inside the user's own profile directory, which holds the default `TEMP` and the app's userData; a `TEMP` elsewhere is refused. Inside means that one of the place's directories is the profile directory itself, by volume and file id, not a name that matches it case-folded, since a directory can be case-sensitive and hold a sibling whose name differs only in case; a place whose identity cannot be read, or reads as a file id of 0 or all ones, which a file system with no unique 64-bit id answers, is refused (security review rounds 3 and 4 of #712). That is a check of location only: Windows access rules (ACLs) are not checked, so a grant inside the profile that lets another account change the place is not detected; only the user or an administrator can add one there (Q416 B). On POSIX systems (macOS and Linux) the private staging directory must be the user's with mode 0700 and, on macOS, have no access control entry at all, inherited or not. On Windows its owner, mode and access rules are not checked; only the place it is made in is. Run from an app on a disk image (under `/Volumes` on a read-only mount, so an app on an external drive there installs as usual), from macOS App Translocation's temporary copy or as an AppImage, it refuses and installs nothing, and says to move the app or use Install under Daemon on this machine in Settings. A run from an installed copy, a package install or a checkout installs as before. The copy routine moved from the desktop into the daemon and is exported as `prepareDaemonRuntime` and `nodeRuntimeFileSystem`, with the `PreparedDaemonRuntime` type; the desktop now calls it through the daemon it loads.
- 1524651: Add explicit TLS tailnet advertisements and source-local configured SSH-forward routes. Services retain both settings. Machine authentication, route deadlines and forget masking still apply; removing SSH configuration removes that fallback after restart. Domovoi does not start SSH tunnels or add WSL or relay transports.
  
  Loopback advertisements now reflect whether the listener uses TLS. Peers cannot enable a source-local route through their own SSH or loopback advertisements, including TLS loopback URLs.
- 1bc7464: Add DOMOVOI_PROFILE_DIR for isolated daemon state without changing provider HOME. Save the selected profile in per-user service registration while retaining the shared service-operation lock.
- 4cacf7a: Show Codex OAuth 5-hour and weekly usage windows using provider-reported
  percentages and reset times. Providers that do not report quota windows keep
  the explicit unavailable state.
- 707e0ab: Persist current context occupancy reported by Claude, Codex, and ACP providers,
  and expose it only while its provider runtime and thread remain active.
- bb0bdf5: Classify a turn that outgrows the model context window as
  `context-window-exceeded` rather than a retryable rate limit or unknown failure,
  and keep a usage limit written with the words spelled out classified as a rate
  limit.
- 6b22745: Remove the `@getdomovoi/daemon/internal` entry point. It exported only two types that the main
  entry already exports, and no npm release carried it, so `@getdomovoi/daemon` is now the
  package's only entry point.
- 9dc6a6f: Replace the public raw daemon constructor with `createProductionDaemon`. The
  factory always installs a durable root credential and machine identity,
  provider discovery, the peer-credential store, persistent state, and configured
  transport protection, so shipped entry points cannot omit production
  dependencies that tests inject.
  
  This is a breaking embedding API change. Consumers must await the factory and
  use its returned handle.
- d72874e: Give the provider prompt composer one total budget and a documented drop order.
  `providerPromptBudgetCodeUnits` lowers the 262,144 UTF-16 code unit default and is
  validated with the other daemon options. Over budget, the composer drops project-default
  skills, open annotations, then handoff history, annotations, and artifacts one item at a
  time, stops as soon as the prompt fits, records every drop on the sent turn's
  `providerPromptDelivery`, and refuses the turn when the request, working plan, and handoff
  summary cannot fit.
- fce431f: Surface provider rate limits, expired authentication, exhausted quota, and missing
  model access as their own classified failures. The Claude adapter kept a bounded,
  redacted tail of provider stderr and preserves the reported error text, so these
  conditions no longer reach a client as unknown or retry.
- 0080f60: Bind relay admission to the active paired bearer and its authenticated static key.
  Keep enrolment on direct connections and carry admitted RPC through the existing
  dispatcher. The endpoint adapter does not implement relay registration, dialing
  or secret-key provisioning.
- 962980a: `@getdomovoi/daemon` exports the service installer for the desktop: `installDaemonService({
  runtime: { nodePath, daemonEntryPath }, environment? })`, `readDaemonServiceStatus()` and
  `removeDaemonService()`, with their result types. The caller names the Node executable and the
  daemon entry it ships; the service (launchd agent, systemd user unit or Windows logon task) runs
  those. A missing, relative or non-file runtime path is refused with
  `DaemonServiceRuntimeMissingError` before the profile is claimed or any file is written.
  
  `installDaemonService` also takes `releaseInAppDaemon`, called once the runtime, platform and
  configuration checks pass and the service-operation lease is held, and before the profile is
  claimed, so a refused install never stops the desktop's in-app daemon. A rejected release stops the
  install with nothing claimed or written. The profile is checked first: it must be free, or owned by a
  desktop owner, the in-app daemon the handoff stops; any other owner refuses with
  `ProfileAlreadyOwnedError` before the handoff. If another daemon takes the profile after the handoff,
  the install fails with `DaemonServiceHandoffError`, nothing claimed or written.
  
  `readDaemonServiceStatus`, `removeDaemonService`, `domovoid service status` and
  `domovoid service remove` treat a Windows task under Domovoi's name as Domovoi's only when
  `service.json` holds a Domovoi registration and the task runs that file through exactly the runtime
  and daemon entry `service.json` records (`serviceRuntime`, now written by every install that names a
  runtime). Any other task is reported as not installed and is neither stopped nor deleted
  (`WindowsTaskNotDomovoiError`). An install from before that record stays removable only when it runs
  `node.exe` on an `@getdomovoi\daemon\dist\index.js` or `apps\daemon\dist\index.js` entry.
  
  On macOS and Linux, status and removal from both entry points report or stop a job named for
  Domovoi only when Domovoi's plist or unit file is there, and on macOS only when `launchctl` says the
  job was loaded from that plist. With no such file, status reports nothing installed or running and
  removal asks no service manager to stop anything.
  
  The Windows logon task, from the desktop and from `domovoid service install` alike, always runs the
  daemon entry through the named Node runtime, and a runtime, entry or configuration path that
  contains a percent sign is refused (`WindowsTaskPercentSignError`), because Task Scheduler expands
  `%NAME%` when the task runs. A path that contains `$(` is refused (`WindowsTaskArgumentVariableError`),
  because Task Scheduler substitutes `$(Arg0)` and the like in task arguments. On Linux, a runtime, entry or
  configuration path that contains `$` or `%` is refused (`SystemdPathCharacterError`), because systemd
  expands variables and specifiers in `ExecStart`. A path that is not in the plain form
  Windows reports (`.` or `..` parts, doubled or forward slashes, a DEL character) is refused
  (`WindowsTaskPathError`), because Domovoi could not recognise that task later. Install refuses a
  same-named task Domovoi did not register (`WindowsTaskNotDomovoiError`) rather than replace it.
  
  When the service manager refuses the new definition (`schtasks /create`, `launchctl bootstrap` or
  `systemctl daemon-reload`), or a service file cannot be written, install puts the previous
  `service.json` and service file back, or removes them when there were none, so the record still
  names what the manager runs. On macOS, when the install had sent a bootout for Domovoi's idle
  job and a later step fails, or the bootout reports failure after unloading the job, the previous
  agent is loaded again. On macOS,
  install boots out an idle job loaded from Domovoi's plist before bootstrapping the new one, and
  refuses before the handoff when the label is loaded from another plist (`LaunchdJobNotDomovoiError`).
- a4200fb: Add `domovoid service install`, `status`, and `remove`. The systemd user unit,
  launchd agent, and Windows logon task generators now ship inside the package
  instead of living as repository scripts no shipped command could reach.
- 77c2829: Add `updateDaemonService({ runtime })`, which moves an installed per-user service to the Node and
  daemon the app now ships, in place. The runtime is checked first and nothing changes before that
  passes. launchd boots the agent out, holds the profile while it writes the new agent, then boots
  it in; systemd writes the new unit, reloads and restarts it; the Windows logon task is stopped,
  the profile held while it lets go, and the task registered again with the new command and run.
  A WSL guest service records its intent, retires its old task, saves the new guest runtime with
  the profile held, and registers and starts a task for it. A start counts only once the daemon
  reports ready. If any step fails, a timeout included, the previous service is put back under its
  own time budget and must report ready too; the error says which way that went, or that nothing
  was changed. The saved configuration is read under the service-operation lease, a restore waits
  for any write still pending, an unreadable owner record fails the update, and the WSL update
  record is read only as a private regular file that matches the saved registration. An install now
  records the Node executable and daemon entry it installed in service.json (`serviceRuntime`), and
  an update records the new ones once they are written, or for a WSL guest once the new service
  reports ready. The previous plist, unit, task action or WSL guest runtime is put back only in the
  shape a Domovoi install writes (absolute runtime and daemon entry, then the saved configuration
  path) and only when its runtime and entry are exactly the ones service.json records. Anything
  else, and any install whose service.json has no such record, is refused before anything changes,
  with the outcome `changed-outside`: "The installed service file was changed outside Domovoi, so
  Domovoi will not update it. Remove the service and install it again to replace it." A service
  that is not installed keeps the outcome `not-installed` and its own words.
  
  On macOS the update and its restore boot out a job under Domovoi's label only when `launchctl`
  says it was loaded from Domovoi's plist; a job from another plist refuses the update with nothing
  changed (`LaunchdJobNotDomovoiError`). On Windows an update refuses, with nothing changed, when the
  previous task action it would register again contains `%`, `$(` or a path Windows would not report
  in that form. A WSL update refuses, with nothing changed, when the old or the new task would carry `%` or `$(`
  in its `wsl.exe` path or arguments, and a Linux update refuses when the recorded old runtime or entry
  contains `$` or `%`. `domovoid service install` for a WSL guest refuses, with the same lines, a
  distribution, Linux user, guest runtime, entry, `wsl.exe` path or configuration path that contains
  `%` or `$(`, before any file is written or task command runs.
- d4228ee: Bind project standing approvals to versioned, server-resolved execution digests.
  Legacy text-only rules remain visible but inactive until explicitly reapproved,
  and package-script changes invalidate pending or reusable approvals.
- cbf620b: Persist structured working plans from Codex, Claude, and ACP providers, apply
  attributed human edits at turn boundaries, and track approval blockers without
  discarding queued or conflicted drafts across session lifecycle changes.
- ef91479: The daemon persists its trusted update metadata versions under the profile lease, read through a strict schema and published durably, and stages a verified update target through the bootstrap installer, which now ships inside the daemon package as `dist/bootstrap-install.js` so an installed runtime can stage without the repository.
- fb78eda: Stamp each usage row with the time its turn was first recorded and answer
  `usage.window` with one query over the ledger. Rows recorded before the stamp
  existed and rows imported by a session transfer carry no time, so they never
  count toward a window; rows a transferred or archived session left behind keep
  counting. Costs in more than one currency within a window are not combined.
- 0fed2e6: Give `device.rename` an optional `expectedLabel` precondition. When present, the
  daemon renames only a row whose label still reads that way, in one conditional
  update, and otherwise refuses with `deviceLabelMismatchErrorCode` (`-32017`) and
  a `device-label-mismatch` payload carrying the row as it stands. A rename without
  the field is unchanged. Undo in the paired devices table sends the label its own
  rename produced, so a rename from another client in between is kept: the row
  shows the current name, the Undo offer is dropped, and the device action alert
  says the name was changed elsewhere.
- 3d67826: Add `device.rename`, which changes the label on a paired device or machine
  credential row and nothing else. The request carries the device id and the new
  label only; the row keeps its id, binding, credential, and timestamps, so a
  rename can never move a machine identity or a credential. Labels are trimmed,
  bounded like a pairing label, and refuse control characters. The daemon authorizes
  the call like `device.revoke`, refusing a device credential, and records it in
  the audit log against the device id. The paired devices table renames in
  place, with Save and Cancel inside the field and Undo after a commit.
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
- a894fcb: Preview comments can now be sent explicitly. `session.send` takes an optional `review`: the ids
  of the open comments this message sends (at most 20) and, as `buildBasis`, the preview the person
  chose for the agent to build on. A message that carries a review delivers only the comments it
  names, so a half-written comment does not steer that turn. `review: { annotationIds: [] }` is
  the explicit send of nothing: no comment and no build basis. The review is checked when the message
  is sent, when it is queued and when a queued message is released: a comment that is not open on
  the session, or a build basis that is not one of its previews, refuses the whole message rather
  than sending less than the person chose. The refusal carries error data
  `{ kind: "session-review-refused", reason: "comment-unavailable" | "build-basis-unavailable" }`,
  so a queued message that meets it at release is refused, as attachment and skill faults are. Only the named comments' crops are read. The build basis
  is never dropped for the payload budget; comments still are, oldest first, as before. A turn's
  delivery record names the build basis it carried. A queued message keeps its review across a
  restart.
  
  Ruling Q402: a message without a review sends no comment and no build basis. A legacy default
  that attached every open comment of the session to such a message was carried for one
  pre-release step and removed before protocol 0.8.0 shipped; the release note "A message without
  a `review` sends no comment" describes what every client now sends. Phone and tablet keep the
  same methods: `review` rides on `session.send`, which they already hold. The first message after
  a cross-provider handoff follows the same rule: the handoff context carries no current comment,
  and only the review's comments reach the provider.
- 9d94da3: Add retained rule revocation, persisted use counts and renderable hard-gate categories for the Rules tab.
  
  The wire protocol moves to 0.7.0. Update clients and daemons together: a peer on another minor version is refused at `system.hello` with `-32012`.
- c3229d9: `device.issueCode` answers with the address a device dials to spend the code, as
  `pairingAddress`: `{ url, label?, loopback }`, the name on the certificate the daemon serves and
  never the address it binds, or `{ problem }` when there is nothing a device could verify (no
  certificate on a non-loopback listener, an unreadable certificate, a certificate naming no host or
  several). The desktop pairing card, the web connect page and `domovoid pair` draw the same address
  from this one answer; the command line no longer works it out on its own.
- 1f80e31: Every snapshot the daemon sends lists its active projects in `projects` and states `projectCap`.
  The daemon still keeps one project open at a time, so the list holds the open project, or nothing
  before one is opened, and the cap is 1. A `session.create`, `tool.inventory` or `skill.*` call that
  names a `projectId` other than the open project's is refused with "That project is not open. Open it
  first, or leave projectId out to use the open project." Naming the open project answers as leaving
  it out does. `project.close` is refused with "Closing a project is not available yet. Opening another
  project switches to it after you confirm the sessions it stops." and changes nothing. A phone or
  tablet credential cannot call it.
  
  Stored state that a newer Domovoi wrote with several active projects, meaning a stored project
  list naming another project, or a session or approval rule of another project with or without such
  a list, is not loaded, and is not moved aside as corrupt. The store reads it before opening the
  file for writing, from a private copy when the write-ahead log holds changes, so a refusal leaves
  the database, its log and its index as they were. In a database damaged elsewhere, it is refused
  before the database would be moved aside for salvage. The daemon does not start, says "Domovoi
  state at <path> was written by a newer
  Domovoi that keeps several projects open, and this daemon keeps one project open at a time. It was
  left as it is and this daemon did not start. Run the newer Domovoi again.", and leaves the stored
  rows as they are. A stored list naming only the open project is dropped when the state is read, so
  it is not saved again after another project opens.
  
  A saved project's own row must hold that project only: its own project under its own key, no list
  naming another, and no session or approval rule of another. `project.open` refuses any other row
  with "The saved state for this project holds another project's sessions or rules, as a newer
  Domovoi that keeps several projects open writes it. It was left as it is. Open this project with
  that version." It reads the row before stopping anything, so the open project keeps running as it
  was. Salvage of a damaged database does not copy such a row into the replacement.
- b67435e: Recover saved client relay pins through externally signed daemon channel-key rotation and durable successor adoption.
- e199de4: Prevent CLI, service and Desktop daemons from writing the same profile concurrently. A separate
  profile lease precedes store construction. Local clients can acquire an owned handle or attach
  only after a same-socket instance proof and ordinary authenticated hello. Attachments cannot stop
  the owner, and restarting or unconfirmed owners never trigger a Desktop fallback.
  An attached handle notifies the client when its verification socket closes, without polling or
  automatic reacquisition.
  
  Service installation refuses while the profile is owned. Close Desktop, install or start the
  service, then reopen Desktop to attach. Port zero requests a kernel-assigned port and discovery
  reads the current bound endpoint from the owner record. Stop older processes before upgrading;
  they do not participate in the new lease protocol. Windows retains the existing user-profile ACL
  policy. The daemon's declared Node requirement now matches the repository's Node 22.13.0 minimum.
- b5b1aa9: Bind every paired credential to one exact client kind or machine identity. The
  authenticated actor now comes from that binding, not from identity fields a
  caller sends after connecting, so audit entries, approvals, plan edits, and
  transfer decisions cannot be attributed to a different client. Device activity
  is recorded only after an accepted hello.
  
  This is a breaking wire change and moves the shared protocol to 0.3.0. Older
  peers fail at the handshake instead of agreeing to talk and then failing inside
  a call. Transfer wire assertions are now named `initiatedByClient`, and the
  retired pre-contract transfer RPC family is removed.
  
  One migration handles both legacy shapes: credentials that could act as either
  a machine or a person, and client credentials that did not record a client
  kind. Any such pairing is revoked once and must be made again. The record keeps
  the two legacy shapes apart for auditing, and the paired-device list tells one
  upgrade story for both, so a person who skipped both migrations is not told the
  pairing broke twice. Authentication remains deliberately uniform so it does not
  reveal whether a presented credential ever existed.
  
  Daemon and device credentials are now fixed-width 256-bit base64url values. A
  configured daemon credential in the older weak shape is rejected at startup
  with an actionable error. A paired client credential grants ordinary client
  authority, including sending or steering work, answering approvals, and using
  terminals, so it must be protected as an account-equivalent secret.
- d5bdbe6: Each model says whether it takes image input. `runtime.models` entries carry `imageInput`,
  `true` when an image attachment on a send to that model is delivered and `false` when it is not;
  the daemon fills it from the same rule the send uses, the adapter's vision capability. A send with
  images to a model that takes none is still refused whole. The error message now names the model
  and the image count, and the error data keeps the shape released clients parse. The attach sheet's
  code is the exported constant `modelImageInputRefusalCode`.
- 0c88e11: Send up to two bounded PNG or JPEG images with a session prompt. Refuse image sends when the adapter lacks vision support; keep uploads out of daemon persistence. Raise bounded authenticated RPC messages to carry both images over direct and encrypted transports. Advertise optional sessionImageAttachments support in system.hello so clients can refuse image sends to older daemons.
- 66ade99: Add opt-in per-file evidence with explicit unknown test links, observed Git revert targets, and commit-bound revert confirmations.
- e68d767: Store an optional suggested label with a Domovoi client pairing code. The device's own name is used when it pairs; the stored suggestion is not read yet.
  
  Make --label optional on domovoid pair --client. Print the word code and browser instructions for web pairing.
- 02a1b58: The window that shows a pairing code now learns what became of it. `device.issueCode` returns a
  `pairingId` beside the code, and the daemon sends a `device.codeOutcome` notification naming
  that id to the connection that issued a client code, and to no other connection. It says the
  code was redeemed, with the paired device row; refused because the device speaks another
  protocol (with its label and both versions; the code stays open), because the paired device
  list is full (with its label), or because the code was spent as a machine pairing; or closed
  because wrong codes used up its attempts or another code replaced it. A code that runs out its
  time sends nothing, since the issuer holds its expiry. The device that spent the code gets the
  same answers as before: the uniform refusal, or its own protocol-mismatch and device-limit
  errors. For a protocol mismatch, the daemon writes that refusal first and only then matches the
  code and tells its issuer, and the match costs the same whether the code is live, wrong, expired
  or spent. Only the issuer of the code that was open when the refusal went out is told, so a code
  issued in between hears nothing of it, even when its words repeat. Codes issued without a client
  kind report nothing.
  
  The shared client accepts the notification and publishes it as a `device-code-outcome` event.
- 3c2ae09: Pair a phone with a single-use code the machine draws itself
- 1c67fba: Keep machine-pairing claims pending for five minutes instead of activating a remote credential
  before the source can store it. The source journals the claim and verifies durable keychain
  readback before confirming activation. Pending credentials cannot authenticate, and an abandoned
  re-pair does not revoke the previous active credential. Lost confirmation replies recover
  idempotently after restart; unconfirmed claims expire without ever granting normal authority.
  
  The wire moves to protocol 0.5.0. Update peers together before enrollment. Existing active bound
  credentials remain valid and do not need re-pairing. If an unfinished claim expires, issue a new
  code on the target and enroll again. Transport or storage ambiguity remains pending for retry.
- 964c47d: Narrow a phone or tablet credential to the pairing card's promise
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
- ef58e04: Deliver signed relay successors before admission and return complete identity pins during opt-in pairing.
- ef22e8e: `session.create`, `session.fork` and a session transfer arriving now refuse to check a repository out
  when the new worktree would run a git filter the repository's own Git config sets. The worktree is
  added without a checkout, Git's config is read as that worktree reads it (so a filter an
  `includeIf "onbranch:"` include or a copied `config.worktree` sets is found), and it is checked
  out only when no such filter would run. Otherwise the worktree and the branch it made are taken
  away and nothing runs. The checkout itself runs in a temporary Git directory that borrows the
  repository's objects and reads none of its config: only the person's global and system config,
  the checkout settings it carries over (line endings, symlinks, case, Unicode and file mode
  handling, path protection, long paths, encoding round trips, sparse checkout, the Git LFS object
  store and the exact `git lfs install` lines), a copy of info/attributes and no hooks. So no
  repository key, a filter, core.sshCommand, core.askPass, a credential helper or core.fsmonitor,
  starts a program during the checkout, through Git or through git-lfs. The index it writes is
  copied into the new worktree, which is an ordinary linked worktree afterwards. Each remote's url,
  pushurl and lfsurl, and lfs.url and lfs.pushurl, are carried when they are https, http, ssh, git
  or scp-like addresses (ext::, fd::, other helper addresses, file:// and local paths are dropped),
  and a partial clone's partialClone extension with its promisor remote, so git-lfs finds its
  endpoint and a missing blob is fetched with the person's own transport settings over https,
  http, ssh or git only. Each checkout directory records the process that made it. A later checkout
  in that repository removes one whose process has ended, never one whose process still runs, and
  one with no such record once it is ten minutes old. `session.create` and `session.fork` answer with
  `repositoryGitFilterErrorCode` and the drivers, the configuration digest and the repository's
  trust read at that moment; a transfer keeps its existing refusal. Filters from the person's global
  or system Git config, and the exact lines `git lfs install` writes, still run. The Git LFS
  settings in the repository's own config that make git-lfs start a program (a custom transfer
  agent's path or args, a standalone transfer agent, an extension's clean or smudge command) are
  refused, reported and pinned like a filter command.
  
  The repository trust digest now covers each filter driver the repository's own Git config sets,
  by scope, key and value, so a grant pins them. A repository that sets none keeps the digest it
  had, and every grant recorded for it keeps its meaning. `tool.inventory` lists those drivers in
  the repository's `gitFilters` block, each held back: nothing runs a repository filter under trust
  yet. A Git config the daemon cannot read (past its output cap, or any failure other than the
  folder not being a Git repository) changes the digest and is listed as unreadable with its
  reason, so trust granted over the readable config no longer applies.
- 1ca35e5: Keep the Linux login service running while its person is away, as decided on 2026-09-17, and
  harden the Windows logon task.
  
  On Linux, `domovoid service install` turns lingering on with `loginctl enable-linger` when it is
  off, says so, and records `"lingerEnabledByDomovoi": true` in `service.json`. Lingering that was
  already on is left alone and recorded as `false`. `domovoid service remove` turns lingering off only
  on `true`. When `loginctl` is missing or refuses, the install still succeeds, records nothing, and
  says on stderr that the daemon stops at logout and starts again at the next login. The desktop's
  install and removal return what they did as `linger`, and Desktop shows that same warning with the
  install result.
  
  On Windows, the logon task still runs the daemon itself and has no crash supervision yet; that
  returns with the job-object work. Each registration now lifts Task Scheduler's default 72 hour
  execution limit and battery stops, as the WSL task does, so the daemon is not ended after three
  days or on battery. Install, update, restore and the desktop's runtime readers now run the
  `schtasks.exe` under `SystemRoot`, from its own directory, instead of one found by name, which
  could have been a repository's own.
  
  Known limit, unchanged by this release: a WSL update from the app retires the supervisor
  registration and registers it again under the same ID, so the new supervisor refuses to start, the
  restored one refuses too, and the service stays down. Starting the task by hand does not help;
  remove the service and install it again. A separate change will fix it with per-start IDs and a
  start fence held through cleanup.
- fdc96ec: `session.send` accepts text files and worktree file paths as attachments beside images, at most two in total. Text files are written into the session worktree for the agent to read; worktree paths must stay inside the worktree. New refusal reasons: `invalid-text` and `invalid-workspace-file`.
- 0b59f4f: `session.search { query, limit? }` searches a daemon's sessions by title and by summary, the
  newest assistant message the daemon holds for the session, case-insensitively, and answers
  `{ query, matches: [{ session, matchedIn: "title" | "summary" }], truncated }` without a whole
  snapshot. It is read-only and unaudited, like `session.history`. A desktop or web client fans it
  out per admitted machine for the palette's "Sessions on other machines"; each machine answers
  for itself, so a machine that did not answer stays "not searched" rather than "no match".
- 234d8fe: Select the Windows-owned guest supervisor when installing from WSL 2. Persist
  the guest launch inputs, report task and guest status, and prove guest shutdown
  before removing the registration. Existing systemd registrations remain manageable.
- 31b48d4: Add a skill from a folder on the execution machine after a review. `skill.installPreview` returns
  the parsed manifest, the declared capabilities, the content and source digests, the signature and
  trust state, the file list, and the install targets per scope. `skill.install` copies the folder
  into the `user` or `project` Domovoi skill root only when its digest still matches the preview,
  refuses a blocked skill, a link that leaves the folder, and an existing name with different files,
  stages the copy inside the root and renames it into place, and audits the result. The Skills
  surface gains an Add skill review step with the scope choice, and `domovoid skill add` prints the
  same review and installs with `--yes`.
- 36520ce: Verify skill signatures against a local trust file. A `SKILL.md.sig` whose Ed25519 signature
  over the content digest verifies against a key in `~/.domovoi/skill-trusted-keys.json` now yields
  a trusted state; a key the file does not list stays unverified, and a failing signature or content
  changed since signing is blocked. `domovoid skill keygen`, `sign`, and `trust` create a signing
  key, sign a skill, and add a public key to the trust file. The delivery record on a sent turn
  carries the trust state each delivered skill had, and the skill browser names an untrusted key.
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
- e583a5a: Ruling Q401: the workspace snapshot now carries turn timing, one source for "Worked for N" and
  the header clock on desktop and tablet. `turns` lists, for each turn the snapshot's thread links,
  its `id`, `sessionId`, `ordinal`, `startedAt`, `completedAt` when known, and `status`. The daemon
  derives it from its usage ledger for every snapshot it sends and never stores it; it is absent
  when the thread links no turn. A pending turn is running; completed and failed turns ended when
  the daemon saw them end; an interrupted turn has `completedAt` only when the daemon saw it stop.
  Each turn id is listed once. If the ledger cannot be read, the snapshot goes out without `turns`
  and the daemon reports the failure once until a read succeeds again.
  
  A turn that was still running when the daemon itself stopped has no `completedAt` in the
  snapshot: the restart time is not when it ended. The ledger still records that restart time, and
  now says so: its turn metadata, and the `turn` on `session.history` entries, carry
  `completedAtSource: "daemon-restart"` for such a turn. Records written before this change carry
  no mark. Phone and tablet access is unchanged.
- f9f2352: Add machine-local runtime discovery for remote session forms, with provider model
  and reasoning choices, a complete default with Auto off, supported permission modes,
  and explicit authentication, timeout, empty-catalog and discovery refusals.
  
  Check provider readiness before offering or creating a runtime. Bound discovery
  end to end, cancel expired catalog work, and prevent late results from poisoning
  retries. Keep the existing model-list and session-create contracts and wire version.
- 284ad5e: Record machine transfer coverage and approval decision latency in durable session history. Protocol 0.6.0 requires clients and daemons to update together; legacy receipts keep missing measurements absent.
- 32304b3: Add an optional second listener on this machine's Tailscale address, beside the
  loopback one. Set `DOMOVOI_TAILNET_ADDRESS`, `DOMOVOI_TAILNET_TLS_CERT_PATH` and
  `DOMOVOI_TAILNET_TLS_KEY_PATH` together, with `DOMOVOI_ALLOW_REMOTE_TRANSPORT=1`
  and a loopback `DOMOVOI_HOST`. The address must be in 100.64.0.0/10 or
  fd7a:115c:a1e0::/48. The listener serves TLS only, on the loopback listener's
  port, with the same authentication as any non-loopback listener. The saved
  service configuration keeps it as `tailnetListener`.
  
  A certificate that cannot be read, has expired or does not match its key
  refuses only the tailnet listener: the daemon starts on loopback, logs why and
  answers `tailnet.status` with the reason. The certificate and key are read only
  when both are regular files of at most 64 KiB that are not links, opened without
  following a link and checked on the opened file, and within 5 seconds, so a
  FIFO, a directory or a stalled read cannot hold the daemon's start. An address that is not on the machine
  yet, as when Tailscale is not up at login, is tried again every 30 seconds.
  When the certificate passes its expiry while the daemon runs, the daemon closes
  the tailnet listener, logs why and reports it refused. Each tailnet connection
  ends at once, without waiting for the client to answer a close, and nothing it
  sent that has not started is handled. A request that had already started
  before expiry may still finish and take effect; its reply is not delivered.
  The listener admits no connection from then on, including one whose upgrade
  began before expiry and finishes after it; such a connection is ended before
  anything it sends is handled. Loopback connections stay open. A
  timer armed for the certificate's expiry does this, re-armed when the expiry is
  further off than one timer can wait. While the listener answers, a pairing code names the host on its certificate,
  and the fleet advertises a tailnet route under `DOMOVOI_TAILNET_HOST`.
  
  `updateDaemonService` takes a `tailnet` change that sets or clears the listener
  in the saved service configuration, written and restarted by the update. It
  changes nothing for a service that already listens beyond loopback or runs in a
  WSL guest.
  
  `readLocalTailnetStatus` reads `tailnet.status` from a local daemon endpoint
  and throws when the daemon cannot be read.
- 9266302: A phone or tablet can read a terminal. Three read-only methods join the phone and tablet
  allow-list: `terminal.list` names a session's terminals, `terminal.watch` returns what the
  daemon kept of one (redacted before it was kept, at most 65,536 characters, with when that
  record starts and whether earlier output was dropped) and then sends its live output, and
  `terminal.unwatch` stops that. None of them reach the shell: `terminal.create`, `terminal.claim`,
  `terminal.input`, `terminal.resize` and `terminal.close` stay refused to those credentials, so
  the one claimant still types.
  
  Terminal notifications now go to the connections that opened, claimed or watch a terminal,
  not to every client. A closed terminal stays readable for one hour with its exit code, then is
  dropped; the daemon holds it in memory only. The owner on the wire also names the paired
  device the daemon verified on the claiming connection, id and label at claim time, when there
  is one. The pairing card's unbuilt line is the short form, "Terminal output is not on a phone
  yet."
- b5b1aa9: Settle a session two machines claim. When a target turns out to already hold the
  session, the source freezes instead of thawing, so the two copies cannot both be
  written. Conflicts record how they were found, either a target that was observed
  to hold the session or a recovery that was later contradicted, rather than
  recording one as the other.
  
  The way out is deliberately one way. A machine can give up its claim and let the
  other keep the session; it cannot take the session back, because that needs the
  other machine's agreement and not a local click. Releasing leaves the worktree in
  place and readable, and nothing removes it automatically.
  
  A released session is recorded as released rather than as a completed move, so it
  never reports that a transfer succeeded when what happened is that this machine
  gave up.
- b5b1aa9: Agree what a move carries before it happens. A transfer is previewed first, and
  the move is refused unless it carries the contract version and intent digest the
  preview returned, so a session that changed after the preview cannot be moved on
  a stale description of itself. When that happens the dialog previews again rather
  than leaving a digest that can never be accepted.
  
  The dialog lists what the daemon reports the move will carry, instead of a list
  maintained beside it that had drifted into promising things the contract never
  moved.
- b5b1aa9: Move portable session history and resources with checkpointed machine transfers,
  while keeping machine-local credentials, provider state, and reusable authority
  on the machine where they were granted.
- b235318: A repository trusted on this machine now runs its own git filters. When the repository's
  configuration digest read at the call equals this machine's grant, the grant was made by a client
  that showed the filters (`repository.trust` `gitFilters.reviewed`, recorded only when the read
  listed every filter; a `reviewDigest` other than the one the daemon's own read gives grants
  nothing) and nothing in it refuses trust, the filter definitions the grant reviewed
  run at session create and fork, a transfer arriving,
  checkpoint, snapshot, restore, file revert, a transfer leaving and evidence. They run only as the
  values the digest covers: a reviewed definition confirms the value the operation reads, never
  supplies one, so a reviewed command changed after that read refuses the operation, naming the key,
  and runs neither the old command nor the new one, and a later empty override of a command or path
  turns it off. A custom transfer's `args` is not a command: emptied or removed, it is a change. The
  values confirmed are the trust step's effective ones: each reviewed key's last value, and each
  reviewed driver's `required` as Git reads it, so a `required` turned off after the check, or a key
  set twice that goes back to its first value, refuses the same way. A
  session worktree that reads other filters than the project
  root (an `includeIf "onbranch:"` include, an edited `config.worktree`), a configuration that
  changed since trust, or trust taken back while the operation runs refuses with
  `repositoryGitFilterErrorCode` and nothing runs. Every existing grant, and any grant from a client
  that does not acknowledge the filters, keeps them held back with a refusal that says to review and
  trust the repository again from an updated client; grants for repositories without filters behave
  as before. The grant keeps the review digest of the git filter block it acknowledged, and the
  filters run only while the block read at the operation lists every filter and has that digest:
  the configuration digest does not cover the file that sets a filter, so settings moved to another
  file keep the configuration digest but hold the filters back until the repository is trusted
  again. The trust store gains columns for the acknowledgement and that digest, 0 and NULL for the
  grants already in it, and refuses a table with a foreign key or a trigger that names it.
  A driver's `filter.<driver>.required` is reviewed with its commands and pinned to the reviewed
  value; `tool.inventory` shows its effective state with each driver command. A `required` value Git
  would not read as a boolean, or a filter command written with no value, in any scope, is a config
  Git stops on: Domovoi reads it as unreadable and refuses, naming the key. A trusted filter runs as you, including a command that runs a file in the repository,
  which an agent's edit also changes.
  
  Checkpoint, snapshot, restore, file revert, transfer and evidence now run every Git command that
  reads or writes the worktree's files or index in the same temporary Git directory as a new
  session's checkout, so no repository config key (core.sshCommand, core.askPass, a credential
  helper, core.fsmonitor, a Git LFS program setting, an included file) starts a program there,
  trusted or not. That directory never reads your live global or system config: it reads a snapshot
  of it taken once as the operation starts, with includes and conditional includes followed as the
  worktree reads them, written to a private temporary directory, so a file edited during the
  operation changes nothing there. The snapshot copies Git's config bytes exactly, checked byte for
  byte when it is read back; a key or value that is not valid UTF-8 refuses the operation, naming the
  key, or saying a config key when the key itself is not valid. A config value on more than one line,
  in any scope, or a filter or Git LFS key holding "=", refuses the same way, in the trust step's
  filter read too: Git LFS reads Git's config one line at a time and splits each line at its first
  "=", so such an entry would give it settings no check sees. A harmless multiline value refuses
  too. The snapshot reaches Git through `GIT_CONFIG_GLOBAL`, which Git
  added in 2.32, so these operations need Git 2.32 or newer: on an older Git, or when its version
  cannot be read, they refuse with a message that names the version found, with no fallback. Each
  operation finds its Git once, as an absolute path from an absolute PATH entry on every platform,
  checks that binary's version and runs every Git command of the operation with it. Every filter driver's clean, smudge, process and required the
  worktree sets, in any scope, empty overrides included, is in it at the worktree's value, and a
  filter key the directory would read otherwise refuses the operation, naming the key. Git LFS
  extension, custom transfer and standalone agent settings follow the same rule: each at the
  worktree's value, and one whose program the repository's own config names held back unless
  reviewed. A filter
  driver, Git LFS extension or custom transfer with an empty name is refused. Git LFS reads a custom
  transfer's program from any key with `lfs.customtransfer.<name>.path` in it; the trust step, the
  snapshot and the check after it share one model of those keys, and a key in any other spelling
  (`lfs.customtransfer.` inside another key, or a variable that only begins with `path`) is refused,
  naming the key.
  Commits are written with Git's plumbing, since `git commit` and every index write
  can run a clean filter. A checkpoint stages and commits in an index of its own, seeded from the
  worktree's, so a failed checkpoint leaves the worktree's index as it was and undoes nothing another
  Git wrote meanwhile; on success the worktree's index becomes the checkpoint's, written under
  `index.lock` as Git writes one, only if it still holds the entries it had at the start. Those operations read the exact `git lfs install` lines as exempt and the
  Git LFS program settings as repository filters, as a new session's checkout does, and refuse
  while the repository's Git config cannot be read. Without trust, evidence still reads with the
  repository's filters treated as absent; a diff driver's `diff.<driver>.binary` setting is carried,
  so a file the repository marks binary stays out of the evidence diff, and external diffs and text
  conversion stay off. A session bundle is written in that directory too, from object ids and with
  lazy fetching off, so a partial clone's missing blob fails the transfer instead of being fetched
  with the repository's own transport settings. Restore clears the merge, cherry-pick, revert and
  finished sequencer state `git reset --hard` clears, and refuses while a submodule has local
  changes, as a snapshot does. Push and fetch for a transfer allow only https, http, ssh and git
  remotes, and refuse a remote whose address is anything else, a local path or a file:// URL
  included, or that names a remote helper; a received bundle is still read from its own file, with
  lazy fetching off, so a prerequisite the target lacks fails the transfer instead of being fetched
  from a promisor remote the target's config names. Neither fetch recurses into submodules.
  Submodules are checked for local work each through an isolated Git directory of its own, the
  superproject's status and diff keep out of submodule worktrees, and checkpoint, snapshot, restore,
  revert and transfer refuse while a checked-out submodule's own Git config sets a filter or makes it
  a partial clone, which no trust covers. Every other daemon Git command runs with lazy fetching off
  (Git 2.45 and later), so a partial clone's missing object fails the command instead of being
  fetched through the repository's own promisor and transport config; only the isolated directory,
  with the filtered transports, fetches one. Git before 2.45 cannot be kept from lazy fetching, so
  on it, or when the version cannot be read, a repository or worktree that is a partial clone by
  its own config is refused with a message naming the Git version needed; other repositories work
  as before.
  
  Under trust, a filter runs in a process group of its own on macOS and Linux, and a timeout or an
  emergency stop ends the whole group. A process a filter started can leave that group, so after a
  kill the operation's descendants count as unknown: a session create stopped part way keeps its
  worktree and branch for recovery rather than deleting them under a writer that may still run.
  Taking trust back restarts no thread for a filter. Files already checked out under trust stay as
  they are, and archiving a session no longer refuses, since removing its worktree runs no filter.
  
  Checkpoint, restore, revert and `session.transfer` refused over a repository filter now answer
  with `repositoryGitFilterErrorCode` and its data, as `session.create` and `session.fork` do, and
  so does `transfer.commit` on the target. `tool.inventory` reports a repository's git filters as
  running, not held back, under a grant for the digest read now.
- ef0d241: Allow a turn to select an exact reviewed skill set. Explicit selections pin
  reviewed content and capabilities, remain required under prompt pressure, and
  fail with structured skill-specific reasons when they can no longer be used.
- 33c937f: Add watching-only client authorization, durable policy refusals, and daemon-owned next-turn message queues.
  
  The wire protocol moves to 0.8.0. Update clients and daemons together: a peer on another minor version is refused at `system.hello` with `-32012`.
- 6832713: Discover WSL distributions from Windows and open work inside them through the
  daemon that runs there. `domovoid wsl list` asks `wsl.exe` for every
  distribution, its WSL version and state, and whether a Domovoi daemon has
  published an endpoint inside it, reporting the loopback endpoint WSL forwards
  and never the credential. `domovoid open` on a `\\wsl$` or `\\wsl.localhost`
  path asks that distribution's own `wslpath` where the path lives and sends
  `project.open` to the daemon inside it; a stopped distribution, a WSL 1
  distribution, a distribution with no daemon, and a Windows drive the
  distribution mounts are each refused with the remedy, without assuming where
  drives are mounted. A daemon refuses `project.open` on a WSL share path, so
  no repository work runs through `\\wsl$`. A daemon inside a distribution
  reports the distribution and WSL version in its fleet facts, and the Fleet
  surface names it as the distribution with a WSL mark.

### Patch Changes

- f7c19b5: Never abandon a resource a deadline created. A deadline rejects the moment its signal aborts,
  without waiting for the operation it abandoned, so an expiry in the middle of a creation left the
  only record of that resource inside the discarded operation.
  
  Bootstrap installation now holds its staging creation and its receipt publication and settles both
  in the cleanup phase. An expiry during the staging `mkdtemp` no longer skips removal and leaves a
  `.runtime-` tree in the release directory, and a receipt whose hard link landed after the refusal
  now keeps the runtime tree it names instead of having it deleted. Staging removal retries a
  removal refused with EBUSY, EMFILE, ENFILE, ENOTEMPTY or EPERM inside the existing cleanup budget,
  which is what an aborted npm child that still holds a handle produces on Windows.
  
  Bootstrap archive publication holds its staging creation the same way. An expiry during that
  creation used to report nothing about the directory it left behind; the refusal now names the
  retained staging. Cleanup still shares the caller's budget, so an expired run reports the retained
  path rather than removing it.
  
  Session create and fork now remove a worktree the creation deadline abandoned. An expiry while
  `git worktree add` was running left the worktree and its `domovoi/` branch with no reference, so
  the existing cleanup was skipped entirely. The late result is now removed under the same agent
  timeout, and a failure to remove it is reported.
- 6696c99: A stored Cursor or Grok session can now be switched to another provider while both are turned off.
  The switch starts a new thread with the chosen provider and no longer tries to stop a Cursor or Grok
  thread, since the daemon runs neither. Continuing such a session is refused with "This session uses
  Cursor, which is turned off in Domovoi for now. Cursor loads MCP servers, hooks and permission rules
  from the repository it works in, and Domovoi does not load repository-brought configuration until a
  trust gate ships. The worktree and conversation are kept. Switch this session to another provider to
  continue." (and the same for Grok).
- e594466: Cursor and Grok are turned off until the trust gate ships. Both load MCP servers, hooks and
  permission rules from the repository they work in, and neither can be told not to, so the daemon no
  longer runs `agent`, `cursor-agent` or `grok` for any reason: not to detect them, list their models,
  or start or resume a session.
  
  Provider discovery reports both as unable to start, with the reason "Cursor is turned off in
  Domovoi for now. Cursor loads MCP servers, hooks and permission rules from the repository it works
  in, and Domovoi does not load repository-brought configuration until a trust gate ships." (and the
  same for Grok). Runtime discovery reports that the daemon has no session adapter for them, and a new
  session or a switch onto them is refused with that reason.
  
  Continuing a stored Cursor or Grok session is refused with "This session uses Cursor, which is
  turned off in Domovoi for now. Cursor loads MCP servers, hooks and permission rules from the
  repository it works in, and Domovoi does not load repository-brought configuration until a trust
  gate ships. The worktree and conversation are kept." A request that finds no adapter for its
  provider now returns that provider's reason instead of an internal error.
- d9add3d: Windows fleet dialing can reach an enrolled WSL 2 daemon through a freshly authenticated local route. Pair the guest first and run domovoid inside the distribution on a distinct loopback port. No new pairing or wire migration is required.
  
  The source checks the distribution before each attempt, uses the existing paired-machine credential, and produces a WSL candidate only after the expected daemon authenticates. A stopped distribution, stale endpoint or rejected credential does not produce a route. Discovery, connect and hello share the route's slice of the overall dial deadline. Root credentials from endpoint files are never used for fleet admission.
- d7dacad: Approval cards no longer claim every request is contained. The daemon wrote "Files and processes in
  the session worktree" and "No agent network access granted" into every approval, although only
  Codex runs commands in a sandbox, and an approved Codex request usually asks to run outside it. The
  card's Affects and Network facts now come from the provider and the request: an unsandboxed
  provider (Claude Code, OpenCode, Kilo, ACP agents) says an approved command can reach anything the
  user account can and has the machine's network access; Codex says what its sandbox allows and what
  running outside it means; a request about a file names the file and says whether it is outside the
  session worktree.
  
  Codex's line follows the session's mode: in Ask and Plan the sandbox reads anything the user
  account can except credential stores and secret files, and writes nothing; in Build it writes only
  in the session worktree. A file path on the
  card is redacted like the command, and a secret in it makes the gate a hard gate. Its control
  characters show as escapes, and a long path is shortened in the middle. Inside or outside the
  worktree is decided on the real path, so a link out of the worktree names where it leads. A file
  tool's card names the file the edit really reaches, so a link that stays inside the worktree names
  its target.
  
  Each path a card holds (its file, the directory the request runs in, and a path the provider
  blocked on) is also judged on every spelling the daemon derives for it: as given, resolved, after
  each link, and relative to the worktree and the request's directory. A secret name in any spelling
  hides the path in every one of them and makes the card a hard gate; a path with more spellings than
  the daemon checks hides the card's command and operation whole. A directory that the durable secret
  redaction changes is hidden whole. A name with `.env.` inside it, such as `x.env.example`, is a
  secret file name too.
  
  One path classifier decides whether a path names a credential store or a secret file. It compares
  path components after Unicode NFKC normalization with full case folding and without
  default-ignorable code points, so a ligature such as "ﬁ", a fullwidth letter, or "ß" for "ss" reads
  as the name it stands for. It takes either slash as a
  separator, drops repeated separators and "." components, and judges a path both as written and with
  ".." applied. A store matches when its components appear in the path; the credential stores the
  Codex sandbox refuses (such as `.git-credentials`, `.pgpass` and `~/.aws`) come from one list shared
  by the sandbox, the card, and the command hard gate. A secret file matches on a component name: any
  stem, including none, before `.pem`, `.key`, `.p12` or `.pfx`; `id_rsa`, `id_dsa`, `id_ecdsa` or
  `id_ed25519` with any suffix; the `.env` family, a name that starts with `.env` or ends with `.env`
  or `.envrc`, so `process.env.HOME` in a command or a file name is not one; and a few named files. When the card path, any
  link followed on the way, any link target, or the file it ends at matches, the path is shown as
  "[REDACTED]" with its location kept, and the gate is a hard gate. A command is split into shell words, each also
  split on "=" and ":", and every word goes through the same classifier; a match makes the gate a hard
  gate, as does the earlier command-line check. Shell words are read as a POSIX shell reads them, with
  a backslash before a newline joining the lines and ANSI-C quotes such as `$'\x2eenv'` decoded the
  way bash decodes them: escapes are bytes read as UTF-8, an octal escape past `\377` keeps its low
  byte, and the quoted text ends at its first NUL byte. Words are also read with backslash as an
  ordinary character, the way PowerShell and cmd read it. Other shell obfuscation (variables, command
  substitution, `eval`, encodings, brace and glob expansion, and where another shell decodes an
  ANSI-C quote differently from bash) is a known limit of matching command text.
  
  `~/.docker` and `~/.domovoi` also hold ordinary files, so the card marks them by their secret files,
  `config.json` and `daemon.token`. The store root itself, with or without a trailing slash, or with a
  pattern such as `~/.docker/*`, names the whole store and is hidden and hard-gated too, so archiving
  or copying it is a hard gate; a project's own `.docker/Dockerfile` and files in session worktrees
  under `~/.domovoi` stay visible.
  
  Each path is also judged at its real path when any of it exists: the card path, every operand of the
  command and of a resolved script, and the directory the request runs in are resolved through the
  filesystem, so a link with an ordinary name, or a name the filesystem treats as another, that reaches
  a credential store makes the gate a hard gate. A path that does not exist yet is followed one
  component at a time from its root, so a link is followed before a ".." after it, as the filesystem
  does, and the directory the request runs in is read the same way, so `deep-link/..` is the directory
  the link leads to. Operands are read from that real directory, and a script's operands from its
  package's directory.
  
  Every approval card is made in one place. A new card, a card judged again before an Allow, a card
  read back from disk, and a request a standing rule would answer are all settled the same way: the
  execution is resolved, the operands come from the command and from that execution, and the
  directory as written and at its real path, the file, every operand, and the directory and manifest
  in the execution record are judged. Any credential path among them makes the card a hard gate and
  is hidden, and a manifest reached through a link into a store hides the execution record in every
  copy the daemon saves or sends. One 2 second deadline covers the whole request, the execution
  lookup included; a lookup that runs out of time, or that the filesystem refuses, gives a hard gate
  with the directory, the file and the execution record hidden, and the session is never held. Only
  a settled card enters the workspace state, and every save and broadcast seals any approval that did
  not, as a hard gate with its paths hidden. A standing rule answers only a settled request that is
  not a hard gate.
  
  Before an Allow is accepted, the card is settled again from the request as it is now: a link can
  move to a credential path, and a package script can change, after the card was made. If the card
  changes, it is saved and sent, and the Allow is refused with "The file target changed; review the
  updated approval before allowing it", or, when only the resolved command changed, "The resolved
  command changed; review the updated approval before allowing it".
  
  An approval saved before this change is classified as written when the state loads and whenever it
  is saved, so its stored copy is repaired: the directory, the directory in the execution record, the
  manifest a script came from, and a file line written before its path was classified are hidden, and
  the approval becomes a hard gate. When the daemon starts or opens a project, its saved approvals are
  then settled at their real paths before any client sees them. A standing rule whose execution record
  holds such a path is dropped.
  
  A saved card keeps its file only as its file line, so at load and at Allow each path that line names
  is followed on disk under the same 2 second deadline: a file that became a link into a credential
  store is hidden and the card becomes a hard gate, and a line that no longer reads back as a path
  (shortened, with an escaped character, or in another format) seals the card. A saved file line is
  read back only when it reads exactly one way as one of the card's three file sentences, no path in
  it holds that sentence wording (" in the session worktree", ", outside the session worktree" or
  ", through a link at "), and the reading renders back to the same line; any other line seals the
  card, so a file name that holds the wording cannot be read as other paths. A sealed card keeps a
  provider's own reach line and hides any other Affects line, whatever its format.
  
  A saved card's execution record is not trusted at load or at Allow. The execution is resolved again
  from the card's saved directory, command, and, for a file or read tool, the file its file line
  names, through the same resolution a new card uses and under the same 2 second deadline. If the
  fresh result differs from the saved record in digest, state, or reason, or any path or operand on
  the card reaches a credential store, the card becomes a hard gate and its record is hidden. A saved
  card whose directory or file line is hidden cannot be resolved again, so it is sealed. So is a
  saved card for a file or read tool, such as Edit or Read, whose resolution reads a file path, when
  its Affects line is not a file
  line that reads back as a path, such as a provider's reach line or an older daemon's wording, since
  nothing on it says which file to judge.
  
  When a card hides a path (a credential file or store, a hidden directory, or any path on a sealed
  card), that path is replaced with "[REDACTED]" in the card's operation and command lines, and the
  rest of the agent's text stays, so `cat ~/.aws/credentials` shows as `cat [REDACTED]`. The path is
  matched as written, at its real path, and in the forms the path classifier compares. A hidden file
  is also matched relative to the worktree and relative to the directory the request runs in, each
  as given and as it really lies, so `src/.env` or `.env` for a hidden `src/.env` requested from
  `src` is replaced; each relative form with "/" or "\" and with or without a leading "./". A name
  that only starts with the path, such as `x.envy.txt` beside a hidden `x.env`, is kept. The text is
  not split into words first, so a hidden name that holds a comma, a space, a quote or a colon, such
  as `src/.env,prod`, is replaced whole. A secret file that only the agent's text names, such as
  `src/private.pem` in the operation of a card for `src/index.ts`, is judged by the same classifier,
  replaced the same way, and makes the card a hard gate. Such a name is read whole beside a curly
  quote, a guillemet, a fullwidth bracket, an em dash, an ellipsis or a line suffix such as `:12` or
  `#L3`. The matching has a work limit: a card whose text would take more, or that names a hidden path
  longer than any real path, shows its operation and command as `[REDACTED]`. The classifier reads `.env.example` and
  `.envrc` as secret files too, so those names are replaced as well. A hidden
  directory at the start of a longer path is replaced, and a shell word that decodes into the path
  through quotes or escapes is replaced whole. An execution record whose command words hold the path
  is hidden. This holds for new, settled, sealed and saved cards, in workspace.get, workspace.changed,
  the store and approval receipts. A relative word under a directory that is itself a credential path
  is replaced only when it exists there, so a program name such as `ls` stays.
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
- 07e8696: `approval.resolve` saves the decision before it answers the agent. When the save fails, the daemon answers `daemonPersistenceUnavailableErrorCode` (`-32014`), the agent is not told, no standing rule is created, and the approval stays pending. Before, the agent was allowed to proceed and the caller was told "Internal daemon error", and an "Always in this project" rule the person was told had failed reached disk on the next save. If the save succeeds but the agent cannot be told, the decision is undone with a second save and the approval stays waiting. An emergency stop that lands during the save keeps its denial, and the stale decision is neither applied nor sent. Cached session history shows the new receipt.
- d76b0e0: The session artifact watcher no longer rescans the worktree for events inside directories its scan never enters (`node_modules`, `.git`, build output, coverage and the rest of its ignore list), so a build or test run there no longer costs a full walk. On platforms other than macOS and Windows, where Node emulates a recursive `fs.watch` by walking the whole tree synchronously and holding one inotify watch per file, the watcher now polls its bounded asynchronous scan every 2 seconds instead, so a worktree with installed dependencies no longer stalls the daemon or exhausts the user's inotify watches. There, a session is scanned every 2 seconds while a turn starts or runs and after any scan that finds a new or changed artifact. After 3 scans in a row find nothing new and no turn is running, it is scanned every 10 seconds (ruled 2026-09-23), so an idle session's artifact can take up to about 10 seconds to appear. A turn starting puts it back on 2 seconds at once. Each scan reads at most 20,000 directory entries to depth 12 and skips the ignored directories. A failing scan backs off the same way. On every platform, at most one scan runs per session and at most one waits behind it, so a scan slower than the poll does not build a queue, and a scan failure that repeats on every poll (a worktree past the 20,000-entry scan limit, or a deleted root) is reported once until a scan succeeds again.
- 19a5fe5: Give each provider message its own thread item.
  
  The daemon keyed the streaming assistant item on the turn, so every message a
  provider sent during one turn appended into a single item. Two messages ran
  together with no separator, and because the item kept the position it was
  created at, tool calls that ran between messages were placed after all of the
  text instead of where they happened.
  
  The Codex adapter now forwards the provider item id on an agent message delta,
  the same way it already forwards it on command output, and the daemon keys the
  assistant item on that id. Adapters that report no item id keep the previous
  turn-scoped behaviour.
- 56462e5: Raise the daemon's MCP SDK floor to 1.31.0. Earlier 1.x versions can send OAuth client credentials
  to an authorization server the MCP server chooses (GHSA-6qxp-vccf-f47h, high). The workspace also
  forces patched versions through scoped overrides: the MCP SDK reached through the Claude Agent SDK
  and the shadcn CLI, `shell-quote` 1.11.0 or newer (GHSA-pqg4-j6r4-53mv, critical) and
  `source-map-js` 1.2.2 or newer (GHSA-68fv-2mgg-jv7q, high). `shell-quote` is reached through
  `@changesets/cli` and the private mobile app's Expo toolchain, and `source-map-js` through postcss
  in tsup and vite; no released package ships either.
- 76172f8: The audit log prunes only when its per-class row count says the cap is reached, instead of walking the index to the cap on every append. Retention is unchanged: the prune itself still deletes by position, so a count left high by a caller's rolled-back transaction deletes nothing and is recounted.
- dcb26a7: An audit append at the retention cap no longer walks the cap's worth of index rows to find what to prune. The retained count per class is kept exact (a caller's rollback is detected by checking that the last appended row, matched by sequence, entry id and class, still exists, and the count is then recounted; the sequence alone is not enough, because SQLite reuses a rolled-back sequence), so the prune removes only the oldest rows past the bound, found from the front of the index. Retention is unchanged: each class still holds exactly its bound.
- f9cf76b: Record a session-start checkpoint at worktree creation and expose semantic reasons for every new checkpoint in paged history.
- 7888b2c: An interrupted turn's late end no longer completes the turn sent after it. The Claude Code and
  OpenCode adapters (Kilo shares the OpenCode one) kept one active turn per thread and ended whichever
  turn held it when a completion arrived. Stop returns once the provider acknowledges the interrupt,
  and the interrupted turn's own result or idle comes after that, so a message sent in the gap was
  recorded as finished at once while the provider kept working on it, and its reply was dropped.
  
  Claude Code: a result that names only the user messages of an interrupted turn
  (`user_message_uuid`, `user_message_uuids`) is that turn's and ends nothing. Any other result ends
  the active turn as before, including one naming a message the SDK made itself or naming none.
  OpenCode and Kilo: after an interrupt, a `session.error` and the `session.idle` that ends the
  interrupted run, when they come before the next turn's own messages, are that run's and end
  nothing, since the server finishes an aborted run before it takes the next prompt. When the error
  arrives while the interrupted turn still holds the slot, it ends that turn, and the idle that
  follows still ends nothing. Without an interrupt, the first idle or error ends the turn as before.
- 5b2daa7: Name the installation step that ran out the bootstrap budget. An expired install reported only the
  total, the phrase "including installation and verification", and the destination to inspect. That
  does not say whether the download, the dependency install, the native terminal build or a
  verification pass held the clock, which is the difference between retrying and diagnosing. The
  refusal now appends the step that was still running and how long it had been running, and keeps the
  unannotated total as its cause.
  
  Nothing about cancellation changed. The same operation rejects at the same moment, an expired run
  still publishes nothing, and staging cleanup still spends its own separate budget.
- 0ec38aa: Find npm when Node is installed through Homebrew. The bootstrap probed only two paths beside the Node executable, so a Cellar layout that links its npm launcher was told to install a supported Node distribution while a working npm 11 was present. It now follows that link to a real npm-cli.js, and refuses dangling links, shell wrappers and directories. It also resolves the extracted package directory before handing npm a prefix, because a symlinked staging path made npm treat the package as a separate linked root.
- b2f72a9: Bound bootstrap HTTPS inactivity to 30 seconds of network waiting between non-empty body chunks,
  inside the existing five-minute installation deadline. Headers, redirects, and empty chunks do
  not renew the allowance; local disk backpressure remains bounded by the original total. Embedded
  callers can set a positive integer `inactivityTimeoutMs`.
  
  Abort fetch and reject late results with `BOOTSTRAP_DOWNLOAD_INACTIVE`, an origin-only diagnostic,
  and a connection-check remedy. Cancellation does not promise immediate runtime socket disposal:
  a stalled TLS connection can delay process exit until Node's own connect timeout. No expired
  download may proceed to publication or installation.
- 0160350: Prevent concurrent verified bootstrap downloads from replacing each other's archive bytes. Each
  download uses private staging and atomic no-replace publication. Matching existing archives are
  verified and reused; conflicting archives are retained and refused. Publication and cleanup share
  one bounded deadline, and cleanup failures name both the archive outcome and retained staging.
  This protects archive publication; verified runtime installation is a separate phase and service
  supervision remains separate.
- 75f2f28: Stream bootstrap archives into private staging while hashing and bounding each download, instead
  of retaining multiple archive-sized buffers. Bound SHA256SUMS separately to 256 KiB. Keep both
  checksum checks, fsync, and atomic no-replace publication before reporting success.
  
  Downloads, staging, and publication share a five-minute total deadline; publication also has a
  30-second phase limit within the remainder. Expired operations cannot begin later steps. Timeout
  errors name the archive to inspect, and private staging can remain if its cleanup budget expired.
  The streamed archive phase does not itself install dependencies or manage a service.
- e9d4e37: Retain production daemon diagnostics in five local JSONL files of at most 1 MiB
  each. Redact and bound records before writing, preserve limits across restart,
  and report file failures through stderr while keeping existing error delivery.
- 002c74a: Keep WSL helper paths and Git arguments literal by bypassing the default Linux shell with --exec. This fixes UNC path translation and prevents shell expansion of arguments. Update the Windows daemon; no re-pairing or protocol change is required.
- 1dd9ee7: Build auto no longer runs a package script without a card when the script's runner loads worktree
  code. `pnpm test`, `pnpm build` and `pnpm lint` whose bodies run vitest, jest, mocha, ava, eslint,
  prettier, stylelint, oxlint, knip, madge, vite, tsup, rollup, esbuild, swc, webpack, next, astro,
  changeset, attw or publint now ask on every run, because those runners execute test files,
  JavaScript config, plugins or lifecycle scripts the agent can write. Scripts that run only `tsc`,
  `tsd` or `biome` are still allowed. A hard gate anywhere in a script graph is now found even when an
  earlier step already needs review.
- 4884900: Daemon Git commands never run repository hooks. A relative `core.hooksPath` resolves inside the
  session worktree, where the agent can write, so a checkpoint on archive, provider switch,
  transfer, restore or file revert used to run a hook file the session had edited, with the
  daemon's full user rights and outside any gate or sandbox. Every Git command the workspace
  service runs now points `core.hooksPath` at a path that cannot be a directory and turns
  `core.fsmonitor` off.
  
  Checkpoint commits also skip commit signing. A signing setup with no key for the Domovoi
  committer, or a failing `pre-commit` hook, no longer makes every checkpoint in that repository
  fail. When a checkpoint fails after staging, for any reason, the index is put back byte for byte
  as it was, so the worktree is not left staged and anything the person had staged stays staged.
  
  Git filter drivers set in the repository's own config (local or worktree scope) now refuse
  checkpoint, restore, file revert, archive and transfer with an error that names the filter and the
  config that sets it. Git runs a filter's command on every add, checkout and reset, and a
  repository-set command such as `./scripts/clean.sh` runs a file the agent can edit. Turning the
  filter off instead would change what a checkpoint stores, for example git-crypt plaintext. Filters
  from your global or system Git config, such as Git LFS, still run.
  
  The file-change view reads its evidence with those repository-set filters treated as absent, so
  their commands never run there. A filtered file can show as changed in that view; nothing is
  stored.
  
  Daemon Git commands no longer inherit Git settings from the daemon's own environment
  (`GIT_CONFIG`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_COUNT`
  and its keys and values, `GIT_CONFIG_PARAMETERS`, `GIT_DIR`, `GIT_WORK_TREE`,
  `GIT_INDEX_FILE`, `GIT_EXEC_PATH`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `GIT_EXTERNAL_DIFF`,
  `GIT_PAGER`, `GIT_EDITOR`). Session push and fetch replace an ssh command, askpass, credential
  helper, upload-pack or receive-pack that the repository's own config sets with your global or
  system value, or Git's default, turn the `ext` transport off and skip push signing. A URL rewrite
  or proxy command the repository's own config sets refuses the push or fetch with an error that
  names it. A restore into a session worktree this machine already holds checks that worktree's own
  config for filters too.
- 5ffc29f: A checkpoint now includes a file whose name is only whitespace. The daemon read the staged file list
  through a helper that trims git's output, which stripped such a name from the NUL-delimited list, so
  a checkpoint whose only change was that file found nothing to commit and saved nothing.
- 3d92b6f: Stop reporting every cached Claude turn as failed.
  
  Anthropic reports cache reads and cache writes beside `input_tokens` rather than
  inside it, so a normal cached turn reports something like 4 input tokens next to
  21,393 read from cache. The normalized counters treat cached input as part of
  input, so `normalizeUsage` refused the turn with "Cached input tokens cannot
  exceed input tokens" after the reply had already been delivered. The session went
  to `failed`, the thread showed "Provider request failed", and the desktop raised
  "Agent work failed" on every response.
  
  `normalizeProviderUsage` now folds `cache_read_input_tokens` and
  `cache_creation_input_tokens` into the input count, which is what the provider
  billed. Only Anthropic reports those two names, so no other payload shape moves.
  
  Second, a usage counter that does not add up no longer fails a delivered turn.
  The Claude adapter drops the unusable readout and reports the turn as what it
  was, because usage is a readout and not the work.
- d02514f: A read-only Git command from Claude Code now skips Domovoi's approval only when Git is not configured
  to run a program for it. Domovoi reads the worktree's effective Git configuration first (every
  scope, includes resolved) and asks instead when it finds an fsmonitor helper, an external diff,
  a diff textconv or command, a filter, signature verification or a GPG program, when a
  post-index-change hook exists (git status can rewrite the index), or when `GIT_EXTERNAL_DIFF` is
  set. A configuration that cannot be read also asks.
- 4f57611: Pager settings (`core.pager`, `pager.*`, `GIT_PAGER`, `PAGER`) no longer make a read-only Git command
  from Claude Code ask. Git starts a pager only when its output is a terminal, and Claude Code runs
  Bash commands without one. A command that fakes a terminal, such as `script` or `unbuffer`, is not a
  listed read and still asks.
- 8ab80dc: A Git read from Claude Code no longer asks just because Git LFS is set up: the four filter lines
  `git lfs install` writes are allowed when they are exactly `git-lfs clean -- %f`,
  `git-lfs smudge -- %f`, `git-lfs filter-process` and `true`. Any other filter or value still asks.
  In a repository with a submodule every such Git read now asks, because git status runs each
  submodule under its own configuration.
- 48dc434: The Git settings check behind Claude Code's read-only Git commands now also asks when
  `GIT_EXEC_PATH` is set, when `format.pretty` or a `pretty.*` format uses a signature placeholder
  (`%G?`, `%GG`, `%GS`, `%GK`, `%GF`, `%GP`, `%GT` or `%GR`, which make git log run the signature
  program), and it now finds a post-index-change hook under a hooks path that starts with a space.
- 51de722: A read-only Git command from Claude Code now asks in a partial clone (a promisor remote, a
  partial-clone filter or `extensions.partialClone`), because commands such as `git log --stat` fetch
  missing objects on demand and run the remote's programs to do it. A pretty format with an escaped
  `%%G` no longer counts as a signature placeholder.
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
- 5a14da7: Keep the Claude conversation across a mode change; a reopen happens only for an ended session, resumes only a started one, and a failed reopen leaves the thread usable.
- 0cc804a: Claude Code sessions now send reads outside the session worktree to an approval. Claude Code runs
  its read-only commands (`cat`, `grep`, `find`, read-only `git` and others) and approves file reads
  inside its working directory before Domovoi's approval callback runs, so `cat ~/.aws/credentials`
  or a `Read` of a private key never produced an approval card, in any mode.
  
  The daemon registers a `PreToolUse` hook for every Claude Code session. A `Bash`, `Read`, `Glob`,
  `Grep`, `LS` or `NotebookRead` call that names a path outside the worktree (after following links),
  starts with `~`, expands a variable, runs a bare `cd`, or runs from a shell directory outside the
  worktree is sent to the approval path with the reason on the card. A read-only call that names a
  secret, such as `git show HEAD:.env`, goes there too, so the credentials hard gate applies. In Ask,
  which has no approvals, those calls are refused and recorded as a policy refusal. Reads that stay
  inside the worktree still run without a card.
  
  A standing rule no longer covers a `Read`, `Glob`, `Grep`, `LS` or `NotebookRead` of a path outside
  the worktree: those requests are never fingerprinted, so each one asks.
- 31eb8b1: Claude Code's read-only Bash commands now skip Domovoi's approval only when they are `cat`, `head`,
  `tail`, `wc`, `ls` without `-R`, or a Git read that prints no file content, and only when every
  argument is a path Domovoi can see before the command runs. Any other read, such as `grep -R`,
  `find -exec`, a glob or a pipe into `xargs`, now raises an approval card in Plan and Build and is
  refused in Ask, because it can reach files outside the worktree that are only known at run time.
- 6fbe2a4: A Claude Code session in a repository this machine trusts loads part of the repository's
  configuration when it opens, if the session worktree still has the trusted digest. Claude keeps
  `settingSources: ["user"]` and reads no repository file itself: the daemon passes hooks of every
  event except `PermissionRequest`, `PreToolUse`, `Elicitation` and `ElicitationResult`, the `env`
  block without keys that steer Claude, its network or the programs it starts, and deny and ask
  rules through the SDK `settings` option, and adds `.mcp.json` servers once Claude has listed the
  person's own. A server whose name contains `__`, one whose tool names would read as one of the
  person's, a remote server whose address or headers contain `$`, and a server with other fields are
  held back, as are allow rules, `defaultMode`,
  `additionalDirectories`, plugins, helper commands and every other setting. A running session keeps
  what it loaded. `tool.inventory` reports a trusted repository's Claude Code entries as loading
  exactly when they load.
- 95810a1: Fix Desktop discovery of a local TLS daemon whose configured certificate chain omits the root, while retaining certificate expiry, hostname, and owner-proof checks.
- 097e00d: Bound `domovoid pair` and `domovoid open` with one 15-second deadline that starts before the
  socket exists and covers connect, `system.hello`, and the call itself. A listener that accepts
  the connection and then says nothing is refused instead of holding the terminal forever, and so
  is a peer that completes the handshake and then stalls mid-call. Neither command can obtain a
  fresh allowance for a later phase.
  
  The refusal names the address that was waited on, which wait expired, and the remedy: check that
  domovoid is running at that address, then run the command again. `domovoid pair` repeats that
  refusal rather than its generic line, while every other daemon error stays generic so nothing
  quotes the request back to the screen. A refused command drops the transport instead of asking a
  stalled peer for a close handshake, but disposal remains Node's: a connection stalled inside a
  TLS handshake can outlive the refusal.
- 4a8b80a: The `domovoid` one-shot RPC client validates each frame with the JSON-RPC response schema before reading it. A `null`, number, array or notification frame is ignored instead of throwing inside the socket listener, a reply to the request that is not a well-formed response refuses without repeating its text, and `domovoid pair` validates the pairing code result instead of casting it. A pairing code result of the wrong shape is refused with the same `The daemon refused device.issueCode` error as a malformed reply, not a schema error.
- 0b293f4: When the Codex app-server dies partway through a line of output, the error shown is again its exit
  code and the reason it printed on stderr (for example that the sign-in expired), not "emitted invalid
  JSONL" for the leftover fragment.
- 9dbde2e: The Codex notice's repository-history scan now runs only when the worktree's Git settings could not
  run a program (the same check that gates Claude Code's Git reads), and it runs with repository hooks
  and fsmonitor switched off, no `ext::` transport, and lazy fetching disabled. A partial clone or a
  program-running setting makes the notice say "Domovoi could not finish checking the repository
  history." instead of running the scan.
- f0d3c74: The Codex notice's repository-history scan now refuses every Git transport while it runs, so a
  partial-clone setting written after Domovoi's check cannot make it fetch, and it does not run at all
  with a Git older than 2.45, which cannot refuse lazy fetches; the notice then says "Domovoi could
  not finish checking the repository history."
- c943176: When the Codex notice's repository-history scan fails, times out or reaches its bound, the notice
  now says "Domovoi could not finish checking the repository history." instead of listing nothing.
  `pwd` and a plain `echo` (no redirect to a file, no substitution) join the Claude Code reads that
  skip Domovoi's approval.
- b772543: Domovoi's note about the files the Codex sandbox refuses is now added to your own Codex developer
  instructions instead of replacing them. Before each Codex thread starts, Domovoi asks Codex for the
  `developer_instructions` it resolved for the session worktree (`config/read`) and sends both. If
  Codex cannot answer that request, the thread does not start.
- e37020a: The Codex sandbox notice now also names the files in the repository history that match the denied
  patterns, with "Codex can still read these through Git", because the sandbox refuses the file on
  disk but not a committed copy. The history scan is bounded to 1,000 matching commits, 3 seconds and
  256 KiB of output; a scan that fails or hits a bound lists nothing, and the session still starts.
- a6d18ac: Split Codex reasoning output from visible output tokens so usage totals preserve
  the provider-reported total without dropping or double-counting reasoning.
- 0bc3530: Codex sessions are refused in a worktree that holds configuration Codex would load from the
  repository itself: `.codex/config.toml`, `.codex/hooks.json` or `.codex/rules/*.rules`, in any
  directory from the session's directory up to the project root. Codex loads these once the person
  trusts the project, and they can start programs or change agent permissions. The refusal happens
  before Codex is asked anything, at session start, fork, a switch onto Codex, resume and each turn,
  and names the file: "Codex would load .codex/config.toml from this worktree, and that file can start
  programs or change agent permissions. Domovoi does not load repository-brought configuration until a
  trust gate ships. Remove .codex/config.toml from this worktree or use another provider here."
  
  A session worktree is a linked git worktree, and Codex takes hook declarations for it from the
  repository's main checkout: `.codex/hooks.json` and the `[hooks]` table of `.codex/config.toml`, in
  the main checkout folder matching each directory from the session's directory up to the worktree
  root. When the worktree is clean but the main checkout holds one of these files, the session is
  refused at the same points and names the file and the main checkout: "Codex would load
  .codex/hooks.json from this repository's main checkout at /path/to/repo, and that file can start
  programs or change agent permissions. Domovoi does not load repository-brought configuration until a
  trust gate ships. Remove .codex/hooks.json from the main checkout or use another provider here."
  
  Every Codex thread Domovoi starts or resumes now marks the project untrusted for that thread:
  `thread/start` and `thread/resume` carry `config.projects` entries with `trust_level = "untrusted"`
  for each path Codex consults for trust, the canonical path of every directory from the session's
  directory up to the project root and of the repository root, which for a linked worktree is the main
  checkout. Codex then loads no project `.codex` configuration, hooks or rules, and no longer writes a
  trusted entry for the project into the person's Codex `config.toml` when a Build thread starts. A
  trust level the person set for these paths is overridden for Domovoi's threads only; their
  `config.toml` is not changed. Codex turns shell snapshots off for untrusted projects.
  
  An untrusted project also stops Codex reading the repository's `AGENTS.md`, so Domovoi reads it and
  sends it with every Codex turn as `additionalContext`, including the first turn after a resume:
  `AGENTS.override.md` if it is a file, otherwise `AGENTS.md`, at the worktree root, in Codex's own
  "AGENTS.md instructions" format, within Codex's default 32 KiB budget and Domovoi's existing limits
  for instruction files (a regular file of at most 128 KiB that resolves inside the worktree). Text
  over Codex's 4,000-byte limit for one context value is sent as numbered entries so Codex does not
  shorten it. The person's own `~/.codex/AGENTS.md` still loads through Codex.
  
  Codex does not escape a context value, so an `AGENTS.md` could close the `INSTRUCTIONS` tag and its
  own entry and open a forged `domovoi-sandbox` entry. Domovoi sends the `<` of any `INSTRUCTIONS` or
  `domovoi-` tag in the file, opening or closing, in any case, as `&lt;`, and never splits a `&lt;`
  across two numbered entries. The rest of the file is sent as written.
- aa0c05d: Every Codex turn now also carries Domovoi's note about the files the sandbox refuses, as turn
  context (`additionalContext`), so a Codex thread started before that note existed learns it after
  it is resumed. Codex keeps the note once. A Codex that does not accept the field runs the turn
  without it.
- f303874: When a session starts on Codex, is handed off to Codex or is forked to Codex, the thread now says
  that the Codex sandbox refuses reads of `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`,
  `.netrc` and `.pypirc`, and that a test or build that loads `.env` fails with "Operation not
  permitted". Codex emits nothing for a refused command, so Domovoi also starts each Codex thread with
  developer instructions that name those files and ask the model to say so in its reply when a
  command fails on one of them.
- 961e74e: Codex sessions can no longer read common credential stores. Every Codex mode ran with whole-disk
  read access, so a command such as `cat ~/.aws/credentials` ran inside the sandbox with no approval
  card. The daemon now starts `codex app-server` with two permission profiles, `domovoi-read` for Ask
  and Plan and `domovoi-build` for Build, and selects one per turn in place of the old sandbox policy.
  Both keep the previous read, write and network limits and deny reads of `~/.ssh`, `~/.aws`,
  `~/.domovoi`, `~/.config/gh`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/.gnupg` and other credential
  stores, and deny secret files inside the worktree: `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`,
  `.npmrc`, `.netrc` and `.pypirc` at any depth. A test or build that loads `.env` inside the Codex
  sandbox now fails. Other reads outside the worktree still run without a card; a strict allow-list waits for a
  survey of the toolchains commands load. A denied command fails with "Operation not permitted", and
  commands that need `~/.gnupg` or `~/.npmrc`, such as signed commits, fail inside the sandbox too.
- 66463b0: A Codex session in a repository this machine trusts gets the repository's tool servers when its
  thread opens, if the session worktree still has the trusted digest. Codex keeps the project
  untrusted and reads no repository file itself: the daemon passes the `mcp_servers` entries of the
  digested `.codex/config.toml` in the thread config, with only their command, arguments,
  environment, working directory, address, literal headers, timeouts and tool lists, and without
  environment keys that steer an agent, its network or the programs it starts. Every passed server is
  made to ask before each tool call, and the question comes to Domovoi as an approval card. A server
  named like one of the person's own, a plugin's included, one Codex treats as its own, and a remote
  server that reads a variable or a program's output into its requests are held back, as are every
  other setting, hooks and rules. When Codex's server catalog cannot be read, or the thread may get
  an execution environment other than the local one, no repository server passes. The file refusal is skipped only for a thread opened under a trusted verdict; hooks in a
  main checkout still refuse every thread. The refusal text now says how trust changes it.
  `tool.inventory` reports a trusted repository's Codex servers as loading exactly when they are
  passed.
- 19053b7: Read login service status under a shared, read-only lease without changing profile files or timestamps. Allow concurrent status readers while continuing to exclude service mutations.
- ab18590: The daemon bearer no longer reaches child processes or borrows a device's name. A daemon started
  with `DOMOVOI_AUTH_TOKEN` kept it in its environment, so the Claude Code SDK, OpenCode and Kilo
  servers, agent processes and every terminal inherited the credential that resolves approvals. The
  daemon now removes `DOMOVOI_AUTH_TOKEN` and `DOMOVOI_CREDENTIAL_PATH` from the process environment
  once it has read them, including when the desktop app passes its own environment, and keeps them
  in memory so a second start in the same process uses the same bearer and path. The kept values are
  pinned to the profile directory that named them (its device and inode), and only a later read of the
  process environment for that same profile gets them back. Every acquisition takes them out first,
  including one that refuses, before it reads any option. `DOMOVOI_RELAY_CREDENTIAL_FILE` is
  taken and pinned the same way. The desktop app takes all three, and its development daemon token,
  out of its environment as the first thing its main process does. `AcquireLocalDaemonOptions` and `ProductionDaemonOptions` take
  `environmentOverrides`, settings added on top of the environment, which the desktop uses in
  development instead of a copy of its environment. Overrides may not set `DOMOVOI_AUTH_TOKEN`,
  `DOMOVOI_CREDENTIAL_PATH` or `DOMOVOI_RELAY_CREDENTIAL_FILE`; an acquisition given such an override
  throws before anything starts.
  
  A connection authenticated with the daemon bearer chose its own audit identity in `system.hello`,
  including a paired phone's `device-...` id, so its approvals were recorded under that phone. Such a
  hello is now refused, and `terminal.create` and `terminal.claim` refuse a request that names a
  paired device's id the connection did not authenticate as. Client audit actors carry
  `credential: "daemon"` or `"device"`, stored with the audit entry, including on a queued send the
  daemon releases later.
- 9e29413: Report the source commit in daemon update status when built from a clean tracked repository.
- c634abf: Service follow-up lines name the command that was run. Through `runDaemonCommand`, which the
  `domovoi` CLI calls, they name `domovoi daemon install`, `status` and `remove`, and profile
  recovery reads `domovoid profile recover --confirm-no-supervisor (domovoid is Node running
  <daemon entry>)`. Through `domovoid service` they keep the `domovoid` spelling. This covers the
  Linux lingering lines, the profile recovery advice after removal, the interrupted WSL update
  advice and the Windows removal failure. The supervised worker's exhaustion lines name both
  status commands.
  
  A macOS removal whose stopped daemon does not let the profile go in time now says so in its own
  words, keeps the launch agent file and saved configuration, and asks for the removal again once
  that daemon has exited, instead of the update's sentence.
- 19a5fe5: Record provider context compaction as a quiet system marker in the session thread.
- f058294: Grade a fleet peer that refuses this daemon's protocol by which side is behind.
  The dialer reads the peer's version out of its refusal, and the heartbeat
  records `upgrade-required` when the peer is the older side and
  `version-mismatch` when it is the newer one, where it recorded
  `version-mismatch` for both. A refusal that names no version is graded by the
  version the peer last advertised.
- 03245aa: On Windows the daemon runs Git by an absolute path. Windows looks for a bare command name in the current directory before PATH, and a session worktree is the current directory of most daemon Git commands, so a `git.exe` committed to a repository could run as you before any filter isolation. Every daemon Git command now takes the first `git.exe` in an absolute PATH entry, passing over empty, relative and drive-relative entries and never looking in the current directory, and refuses when there is none. On macOS and Linux Git is still found by the system's PATH search, which does not look in the current directory unless PATH names it, except for the Git commands of checkpoint, snapshot, restore, file revert, transfer, evidence and a new session's checkout: those run the first `git` in an absolute PATH entry, by its absolute path, found once per operation, and refuse when there is none.
- 9828935: `domovoid --help` now names the four environment variables the daemon reads that it left out: `DOMOVOI_TOOL_PATH`, `DOMOVOI_RELAY_IDENTITY_PUBLIC_KEY`, `DOMOVOI_RELAY_CREDENTIAL_FILE` and `DOMOVOI_WINDOWS_POWERSHELL`. A test now fails when the daemon reads a variable that the help text or the package README does not name.
- c746eab: Publish a machine identity without replacing one won by an overlapping daemon
  start, so every concurrent start adopts the same durable machine ID.
- 6f52997: Keep project standing approvals in Domovoi and grant providers one command at a time.
- 19a5fe5: Use provider-native Plan mode when available, keep prose plans available as a fallback, and expose provider-reported file changes with per-file line counts on tool activity.
- 051e889: Switching projects after a queued send no longer breaks the daemon. Queued sends load with the project that owns their session. A send still waiting when a switch interrupts its turn is held, so it is never released on a later, unrelated turn.
- f2e4b75: Classify provider errors worded "rate limited", "rate-limited" or "rate_limited",
  and Codex usage-limit messages written with a typographic apostrophe, as a rate
  limit instead of a generic provider failure.
- 14527f0: Provision and reopen profile-scoped relay channel keys, retain only an external identity public anchor, and verify signed successors without silently replacing missing keys.
- b7f7c95: The switch to or from the login service is now held by the daemon itself. `system.serviceHandoffFence` (loopback, daemon credential only) answers the same refusal as the window's check, or, when nothing runs, no dispatch is in flight and no gate waits, admits no new turn until the connection that took it closes. The desktop takes it right before it stops the daemon inside the app or removes the service, so a turn that starts after the first check makes the switch wait instead of being stopped.
  
  Staging the shipped runtime refuses an app version that is not one release version, a `~/.domovoi` or `~/.domovoi/runtime` that is a link, a shipped part that is not a regular file, and a link that leads outside the shipped runtime, all before any byte is copied. Links inside the runtime are copied as they are. An earlier copy of the same version is moved aside and put back if the new copy cannot be renamed into place.
  
  After a failed install or removal the desktop reads the service back and reports it, along with the daemon it reaches afterwards, including one this app did not start. Settings no longer says nothing was installed or removed unless the read-back shows it.
- 279349c: The desktop can install the daemon as a login service from Settings and remove it again. The app copies the runtime it ships under the profile, asks the daemon's own installer to register the service pointing at that copy, and only then stops its in-app daemon and attaches to the service. The switch refuses while a turn runs or a gate waits and names the sessions; a runtime the app does not ship is reported without touching anything.
  
  Install and Remove both wait while a turn runs or a gate waits. The desktop main process checks this too, before anything is stopped: it reads the workspace from its own daemon (`readLocalServiceHandoffRefusal` in `@getdomovoi/daemon`) and applies the same check the window uses (`serviceHandoffRefusal` in `@getdomovoi/protocol`). A workspace it cannot read also makes the switch wait. While the service takes over the profile or gives it back, a window reconnect waits for the handoff instead of starting a daemon inside the app. The runtime copy is made in a fresh directory and renamed into place, so no file from an earlier copy of the same version survives. Settings says when the service was installed but this window could not reach it, when the daemon inside the app stopped and did not start again, and what to run when a removal leaves the profile owner unresolved. A daemon running outside the app is drawn as the installed service, with Remove available, only when the desktop reads the service as installed from the service manager.
- 19a5fe5: Batch adjacent streaming workspace deltas within the named 32 millisecond
  budget while preserving session and operation order. Flush queued deltas
  before snapshots, turn boundaries, other agent events, and shutdown so clients
  cannot apply streamed text twice. Reuse the active assistant item during a
  turn instead of scanning the full thread for every token.
  Mutating RPCs now return their snapshot once to the caller while still
  broadcasting the same change to every other client.
- 2cd8a1b: The daemon resolves the PATH it looks for provider CLIs on at startup, from an override, the account's login shell and the launch environment, records it in tools.json, and names the absolute path each CLI was found at. A packaged app launched from Finder or the Dock no longer reports every harness as not installed.
- 51a7431: Refuse corrupt WSL listings instead of reporting missing distributions. Discovery requires a
  valid header and every nonblank row to parse, with no partial results. Both `domovoid wsl list`
  and `domovoid open` report the corrupt classification and a diagnostic command to run, without
  repeating unreadable row contents. Header-only listings and explicit absence answers still work.
- 4a32392: Update production dependencies: the Claude, Kilo and OpenCode provider SDKs in the daemon; Electron 44.2.0 in the desktop; React 19.2.8, Lucide 1.42.0 and react-resizable-panels 4.12.4 in the shared ui and the clients. Development tooling moves with them (vitest 5, shadcn 4.21). The phone follows its Expo SDK: expo 57.0.22, reanimated 4.5.1 and worklets 0.10.1 as the SDK resolves them, jest held at 29 because jest-expo 57 expects it, and a deps:check that refuses drift from the installed SDK.
- 9a015e9: Update production dependencies. The daemon moves to Claude Agent SDK 0.3.281, Anthropic SDK 0.128.0,
  Agent Client Protocol SDK 1.5.0, Kilo SDK 7.7.9, OpenCode SDK 1.18.32, MCP SDK 1.30.1 and yaml
  2.9.1. Claude Agent SDK 0.3.281 is built against Claude Code 2.1.281, so the daemon now refuses an
  older `claude` with "Update Claude Code to 2.1.281 or newer". The floor was 2.1.263. The keyring
  binding moves to 2.1.0, zod to 4.6.5 and vite to 8.3.0. The shared ui and the web and desktop
  clients move to Lucide 1.47.0 and tailwind-merge 3.7.0, and stay on React 19.2.8 and
  react-resizable-panels 4.12.4: the newer two would put startup JavaScript over its budget. The
  phone takes Expo 57.0.24 and stays on the React, safe-area and SVG versions that SDK bundles.
- d7fea95: `captureInheritedCredentials` takes an optional second argument: values a caller already took out of the process environment and held. They are pinned to the profile exactly as values read from the environment are, and a held value wins over one still there. The desktop app's first module now takes `DOMOVOI_AUTH_TOKEN`, `DOMOVOI_CREDENTIAL_PATH` and `DOMOVOI_RELAY_CREDENTIAL_FILE` out of its environment with its own code, holds them, and hands them to the daemon it loads from its shipped runtime. Limit: the profile they are pinned to is read when the daemon loads, not when the app starts.
- df4716f: Bound pairing claims per source and listener without resetting on reconnect, and keep rejected pre-authentication traffic in a separate audit retention budget so it cannot evict operator decisions. Throttled claims do not consume a valid pairing code. Existing history remains readable.
- 5fea2c8: `system.emergencyStop` now broadcasts `system.emergencyStopped` before the idle workspace snapshot that reflects it, so a client holding a queued message sees the stop before the session goes idle and does not send the message that would restart the stopped work. While a stop is in progress, workspace snapshots and deltas that other changes would broadcast are held; the stop notice goes out first and one snapshot then carries every change. The client that made a change still gets the new state in its own reply.
- 91b1e15: Accept compatible patch versions in daemon snapshots without rewriting the reported
  version. Validate bounded canonical wire versions consistently and compare major
  and minor components exactly, including values above the safe integer limit.
- 0d60644: Expire every stored pending approval card when the daemon starts and when a project's saved state is opened again. A stored card's provider request id came from a provider process or thread that is gone, and a new provider process can issue the same id to a live request in another session, so allowing or archiving the stale card could decide that request. Startup archive recovery no longer sends a decision to the provider for stored cards. At startup, each session whose card expired and that had no active turn gets the thread line "Domovoi restarted, so this approval request expired. Send a message to continue." A session whose turn was interrupted gets only the existing "Daemon restart interrupted the active turn." line. When a project opens again, each session whose saved card expired gets the thread line "This approval request expired when the project closed. Send a message to continue." Each session gets one line however many cards it held. The agent asks again when the session continues.
- 65da87b: An emergency stop now fences two handlers that had already passed its checks. A queued message released at a turn boundary carries the stop's cancellation into its `session.send`, so a stop that lands while the provider starts the turn leaves the message held instead of delivered and the session without the new turn. An `approval.resolve` that is reading package scripts checks again after that read and refuses when the stop has already denied and removed the approval, so the agent is not told "allow" after the stop's "deny".
- 18f6543: Upgrade Zod to 4.5.2 while preserving UTF-16 string limits, persisted minute-precision timestamps, transfer manifest digests, and readable validation refusals.
- 5f104a3: Include optional daemon time in fleet snapshots, notifications, and mutation replies so clients can measure heartbeat ages against the daemon clock. Keep protocol version 0.8.0 and accept snapshots without the timestamp.
- 9db320a: Report fleet machines as unreachable when failed connection attempts outlast the existing offline heartbeat bound. Keep brief failures reconnecting and restore healthy status after authenticated contact resumes.
- ca22e9e: Reserve time for fallback routes inside one overall fleet dial deadline. Each eligible route gets
  a share of the remaining time for connection and authenticated hello, so a silent first endpoint
  cannot consume every later route's allowance. Cancel abandoned attempts, reject late results, and
  retain typed timeout refusals naming a sanitized address instead of arbitrary transport error text.
- 9e1e9c5: Keep healthy fleet machines readable when another stored machine row is malformed. Retain the damaged row in quarantine with an atomic, sanitized audit receipt, and exclude it from dialing and heartbeat updates.
  
  Add opt-in quarantine diagnostics to `fleet.list` with typed operator remedies. Existing list calls, lifecycle replies, and notifications retain their wire shape. UI rendering is unchanged. Forget or explicitly enroll a peer again when its identity is valid; invalid identities require offline registry repair.
- ccaa2be: The daemon's repository configuration reader now reads a repository's own Codex configuration
  without running any of it, for the tool inventory and repository trust. It reads
  `.codex/config.toml` as TOML data, `.codex/hooks.json`, and the skill folders `.codex/skills` and
  `.agents/skills`, and counts `.codex/rules` in the configuration digest. It lists MCP servers
  (a local server's command, redacted, and the names of the variables it receives; a remote
  server's host and the names of the variables whose values Codex sends it, never an inline token
  or header), each server's header helper by its program alone with every argument cut (a helper
  that opens with a shell comment is shown as `[REDACTED]` alone), tool
  approval modes, hooks from both files, the names of the variables set for the agent's commands
  (never their values), the approval and sandbox settings, each named permission profile's grants
  (the profile it extends, workspace roots, filesystem access, network settings, domains and unix
  sockets), the shell's variable filters, plugins, skills, and instruction overrides. An
  instruction override is listed as present, never by its text. The file `model_instructions_file`
  names is listed by its path and, when it is in the repository, hashed into the digest with the
  same caps and link handling as every other file. Its path, like every path a refusal names, is
  shown redacted and within the protocol's path cap, and each provider the reader returns is checked
  against the protocol's inventory schema. Keys Codex ignores in a project file, such as
  `notify` and model providers, are not listed, and like every byte of the file they are in the
  digest.
  
  Only the repository root's `.codex` folder is read, and a `.codex` folder that is Codex's own
  home is skipped, as Codex skips it: a `CODEX_HOME` that is set is compared by the canonical path
  of the value as written, as Codex canonicalizes it, and one that is relative, is not a
  directory, or has a `..` segment skips nothing, since platforms resolve a `..` after a link
  differently. A linked worktree's `.git`, `gitdir` and `commondir` files are trimmed
  of ASCII whitespace only, as Codex trims them, and one that is not UTF-8 leaves the main checkout
  unknown. The reader also returns trust refusal codes for Codex input
  the digest does not cover: `nested-config` for a `.codex` folder or `.agents/skills` below the
  root on a named session folder's way down, `main-checkout-hooks` when a linked worktree's main
  checkout holds Codex hooks, `main-checkout-unknown` when a link or a mismatch is on the way to
  that main checkout, and `instructions-outside` for an instruction file outside the repository or
  reached through a link. Domovoi starts every Codex thread at a worktree's root, so nothing below
  the root is checked unless a session folder is named.
  
  TOML whose inline arrays and tables nest more than 64 levels deep, or that does not parse, is
  reported unreadable with the reason `invalid-toml`. A parse that takes longer than 2 seconds is
  reported unreadable with the reason `too-slow`; the parse is synchronous, so this refuses the
  result and does not stop the parse. The TOML parser is smol-toml, which reads the document as
  data and runs nothing from it.
- 4359bcf: Fix provider usage accounting and persist dispatch attribution, deduplication and coverage across restart and transfer.
  
  Versioned transfers use contract v2 to carry portable accounting. Both endpoints must support v2; strict v1 receivers cannot parse the added evidence.
- 8871313: A `tool.inventory` git filter entry carries `commandInexact: true` exactly when its `command` is not the configured value byte for byte: redaction cut part of it, rewrote it, or the value holds the redaction marker text itself, which cannot be told apart from a cut. The protocol refuses an entry that shows the marker without the flag. A command the redaction would cut nothing from is shown exactly as configured, its patterns and braces unescaped, so it stays reviewable. Nobody can review a command shown other than as Git runs it, so the daemon records no git filter acknowledgement for a block that holds one, and its filters stay held back under any grant. The trust sheet offers no trust for such a block and says that Domovoi cannot show the command exactly as Git runs it. Any cut counts, a credential alone included.
- 3097d31: The daemon reads a repository's Git filter settings as strict UTF-8, as the isolated checkout already does. A scope, file name, key or value that is not valid UTF-8 makes the Git config unreadable (`git-failed`), so `tool.inventory` never lists a filter with replacement characters that a review could approve, and the gate refuses as it does for any config it cannot read.
- 4bf0e8e: Git for Windows' default `diff.astextplain.textconv = astextplain` no longer makes a Claude Code Git
  read ask or stop the Codex notice's history scan. Any other value for that key, and any other diff
  textconv, still does.
- a2fa107: Refuse `system.serviceHandoffFence` off the loopback owner connection with
  `localOwnerRequiredErrorCode` instead of the authentication code. The refusal
  conditions and message are unchanged. A paired device or relay client that asks
  for the fence no longer reads the refusal as a revoked credential, so its
  connection stays open.
- eb8040e: A cross-provider handoff now tells the next provider how many recognized test runs passed and failed in the session, from the same thread evidence `session.evidence` reports. Before, it always sent the session summary's counters, which are set to zero when a session is created and never updated, so the receiving agent was told no test had passed or failed. The counts cover the whole session, so the handoff also names whether the latest recognized run passed or failed (`last`). A session that failed three times and then went green is not handed off as tests currently failing.
- 357dfb6: `session.history` now gives a sent message's entry `annotationsOverLimit` when its recorded prompt
  delivery left open annotations out for the per-turn limit, with the count from
  `providerPromptDelivery.annotations.omitted.limit`. A message whose count is zero, or that has no
  recorded delivery, gets no field.
- 16ca29f: `session.history` with a `query` matches an approval entry by the label of the paired device that
  decided it, so searching History for `dana` finds what was decided on dana's phone. An entry
  without a device (the daemon credential, or a row written before the field) matches as before.
- 6b30c51: Reject overlapping bundle restores before repository inspection or fetch, including independent
  service instances sharing a worktree root. Keep later incremental restores and concurrent restores
  of different sessions working. Release owned filesystem claims on normal completion, failure and
  cancellation; report a claim left by a killed process for explicit recovery with Domovoi stopped.
- 12f0a90: Domovoi reads the repository instruction files it sends to Claude, Codex, OpenCode and Kilo by
  opening each file once and reading only from that open file. Before, it checked a path and then
  opened the path again, so a process writing in the worktree could swap the file for a link to a file
  outside it between the check and the read, and the outside file's contents were sent as project
  instructions. The file is now opened without following a link (`O_NOFOLLOW`, with `O_NONBLOCK` so a
  named pipe cannot hold the open), must be the same file, by device and inode, that the check found,
  must be a regular file of at most 128 KiB, and is read up to that limit. Each directory between the
  worktree root and the file must be a real directory, not a link, and the same one before and after
  the open; otherwise nothing is sent from that file.
  
  A hard link has no target to resolve, so a worktree name hard-linked to a file outside the worktree
  passed every path check and the outside file's contents were sent. The open file must now have
  exactly one name (a link count of 1); a file with more names, inside the worktree or not, sends
  nothing.
  
  Windows has no `O_NOFOLLOW`. There the check before the open refuses a link, and the device and
  inode comparison after the open refuses a link swapped in between. Node has no call that opens a file
  relative to an open directory, so a directory swapped for a link and back again between these checks
  is narrowed, not ruled out, on every platform.
- 4712ef9: The instruction files Domovoi reads for a session no longer follow an `@path` import found in
  Markdown code (double-backtick and multiline code spans, fences indented up to three spaces, fences
  left open, and indented code blocks), and never read a file inside Git metadata or inside a nested
  repository or submodule, including through a symlink at the worktree root.
- 972e6c7: An inline HTML code tag that opens inside emphasis and closes after it still hides the import it
  encloses, and a closing tag of a different element no longer ends it.
- 5da6a5a: The instruction files Domovoi reads for a session are now parsed as CommonMark
  (`mdast-util-from-markdown`), and `@path` imports are taken from text only, never from code blocks,
  code spans or raw HTML. Fences inside list items, code spans after an escaped backtick, and indented
  code right after a heading no longer load an import, and an import after such a fence is no longer
  lost.
- 96c757b: An inline HTML code tag is recognised only by its own tag name, so a tag written inside another
  tag's attribute or inside an HTML comment no longer hides or reveals an instruction-file import.
- d47bfc6: An `@path` import written between inline HTML `<code>`, `<pre>`, `<kbd>` or `<samp>` tags in an
  instruction file is no longer loaded.
- b8c55c2: The tool inventory no longer carries a credential in a remote tool server's host or in an
  environment key name. The reader shows `[REDACTED]` for a host with a label shaped like a known
  credential, read in the URL as written and as parsed, and for an environment key name that is
  itself shaped like one; the entry is still listed. The protocol refuses those shapes in both fields
  and takes the marker, so a reader that misses one drops the entry and counts it instead of sending
  it.
- 16c242a: The tool inventory no longer shows a secret path in a command. A flag that says where a token,
  key, secret, password or credential lives (`--token-file`, `--password-file`, `--ssh-key-path`,
  `--key-file` and the like, as `--flag value` or `--flag=value`) is a trigger: the reader cuts the
  text there, as it does at a sensitive flag. The protocol exports `isCredentialLocationKey` and the
  `locationSuffixes` rule, and its backstop refuses a value after such a flag. In a command line or
  argument vector, the reader also cuts at the first argument that names a known credential store
  or secret file, judged by the same classifier the hard gate uses. A rule such as `Read(./.env)` is
  not a command and keeps its path.
- 6b0e4fd: The daemon reads the web app a pairing code can be opened in from `DOMOVOI_WEB_APP_URL`, or `webAppUrl` in the service configuration file. It must be an absolute `http` or `https` URL without whitespace, control characters, credentials or a fragment, at most 2048 characters; the daemon refuses to start with anything else and does not echo the value. An invalid saved `webAppUrl`, including one that is not a string, fails as a `DaemonConfigurationError`, both when the configuration is parsed and when the service loads the file. When it is set, `device.issueCode` returns it as `webAppUrl` beside `pairingAddress`; when it is unset, the result has no `webAppUrl`. The protocol validates the field with `webAppUrlSchema`.
- 7815f0a: Pin a kept inherited bearer to its profile directory by device, inode and canonical path. A
  directory at another path that reports the same device and inode, as a new directory can when a
  filesystem such as ext4 gives it the inode number of one just deleted, no longer receives the
  bearer kept for the deleted profile. The directory's birth time is not part of the identity:
  where statx is unavailable, the reported birth time is the change time, which moves whenever a
  file is added to the directory.
  
  A profile directory that exists but whose canonical path cannot then be read, for any reason
  including ENOENT, now receives no kept bearer. It used to be read as a directory that did not
  exist yet and could match a bearer pinned by path.
  
  The canonical path must also lead to the directory the stat saw. A profile symlink retargeted
  between the stat and the canonical-path lookup, or a canonical path that names another directory,
  leaves the profile unnamed, so it keeps and receives no bearer.
- 4aa3ef7: Update @napi-rs/keyring to 2.0.0. A locked or inaccessible keychain now throws from every read and write, and a delete returns false only when nothing was there; every caller already reports that throw as unavailable and never as an absent credential.
- 161741e: Kilo is turned off. Kilo's embedded server can switch on a rule that allows every tool, and it sends
  Domovoi no event when that happens, so Domovoi cannot show an approval card before a tool runs.
  Provider discovery now reports Kilo as unable to start without running `kilo`, no Kilo server is
  started, and creating a Kilo session or switching a session onto Kilo is refused with "Kilo is
  turned off in Domovoi for now. Kilo's server can switch on a rule that allows every tool, and it
  sends Domovoi no event when that happens, so Domovoi cannot show an approval card before a tool
  runs." Continuing a stored Kilo session is refused with the same reason, and the refusal says the
  worktree and conversation are kept and that the session can be switched to another provider.
  Cursor and Grok stay turned off under their own switch.
- 1204d6c: Allow transfers to known eligible machines even when legacy fleet recovery rows exceed the display limit. Keep pending enrollment and forget operations masked, retain credential checks, and refuse transfers when pairing or the credential store is unavailable.
- ff9307a: With no saved service configuration, the launchd check reads the services block of `launchctl print gui/<uid>` line by line, label last, so an extra column no longer hides a `sh.domovoi.*` job. A listing it cannot read refuses the install or removal: `launchd listed the jobs in gui/<uid> in a form this app cannot read, so whether a login service is registered there is not known. Nothing was changed.`
- c5b68b2: The launchd check reads `launchctl print gui/<uid>` whole: the listing must open with that domain, close every block it opens and hold one services block, and a row that names Domovoi anywhere but as its one, last field is refused as unreadable, so a truncated listing or a label with a space cannot pass as having no Domovoi job.
- 5ae04b0: When every harness is missing, Start a session shows a search report instead of a status list: what the daemon looked for, the PATH it searched, and that finding nothing there is not proof nothing is installed. The daemon reports the searched PATH on the machine (machine.toolPath), and a missing harness reads Not found rather than Not installed everywhere.
- 21a161c: Opening a project now ends every turn saved with it, for Codex and Claude Code sessions as well as
  Cursor and Grok, the same way a daemon restart does. The session goes idle and its thread says
  "Daemon restart interrupted the active turn." Only one daemon owns a profile, and closing a project
  asks its providers to stop their turns. Pause and emergency stop then find an idle session and make
  no provider call. A Claude Code stop can return before its process has exited; that is tracked
  separately.
- aba51b2: Startup reads and migrates the stored workspace once instead of twice: the first `load()` takes the snapshot the store constructor already migrated. Opening a project no longer reads and migrates the whole current workspace just to learn this machine's record; the daemon passes the machine it already holds.
- 50510c7: Desktop no longer reports every in-app daemon startup failure as an invalid profile. `acquireLocalDaemon` names three causes the owner can act on: `port-in-use` when another program holds the daemon's port, `state-locked` when another process holds the profile's state database (SQLite busy or locked), and `identity-mismatch` when the stored workspace belongs to another machine identity. Other failures keep `profile-invalid`. Every startup failure is now written to the error sink with its redacted cause, so Desktop's log keeps it. A port already in use now refuses at once instead of waiting out the startup deadline, because the WebSocket server's copy of the listen error no longer throws before `start()` can reject, and stopping a daemon whose listener never started no longer fails, so the profile lease is released and the next attempt in the same process can start. A Desktop owner record left `stopping` by a Desktop that quit before its daemon finished stopping is retired when the next launch holds the profile lease, so that launch starts instead of being refused as unreachable. After the daemon is listening, a later error from its WebSocket server is written to the error sink instead of being dropped.
- 3e2c556: Report a machine that ran out of time as an unreachable owner rather than an invalid profile.
  Acquiring the local daemon recognised an expired budget only when the deadline error was the one
  thrown. A startup step that bounds itself reports its own expiry and carries the deadline as a
  cause, so credential initialization timing out was classified as `profile-invalid`, and the
  refusal told the person to inspect their owner record, private key and credential file. Nothing
  was wrong with any of them; the machine was slow.
  
  The classification now looks through the wrapper, including the aggregate a step raises when its
  cleanup also failed, and answers `owner-unreachable`, which says to wait for the daemon or start
  it explicitly. A genuinely damaged profile still reports `profile-invalid`.
- c60209d: Lock `fast-uri` 3.1.8 in place of 3.1.6. The daemon reaches it through the MCP SDK, which depends on
  `ajv`. Version 3.1.6 carries two high advisories: authority injection through an unvalidated port in
  `serialize` (GHSA-qw65-cvwx-89v3), and host confusion through an unclosed bracket in the URI
  authority. Only `fast-uri` moves in the lockfile; it has no dependencies of its own.
- ccc14a7: Report a locked or unavailable OS keychain separately from an absent machine, provider, or relay credential.
- c81939b: On macOS, removing the login service now waits for the stopped daemon to let the profile go before it removes the agent and its configuration.
- 7bc1d86: Release one-shot CLI connections after a complete reply as well as after a refusal.
  A peer that withholds its close acknowledgement can no longer keep an answered
  `domovoid pair` or `domovoid open` process waiting outside the command deadline.
  No configuration changes or re-pairing are required.
- f93880b: Stopping a Claude session now waits for the Claude process to exit. Domovoi starts that process
  itself, through the Claude Agent SDK's `spawnClaudeCodeProcess` option, with the settings the SDK's
  own spawn uses. The Claude process that lists models is started the same way.
  
  On POSIX a stop closes the input and the query, then waits up to 2 seconds for the process to
  exit, then kills what it started, and waits up to 5 seconds more for Claude to exit. Domovoi starts
  a small Node process, the keeper, in its own process group, and the keeper starts Claude in that
  group, which the commands its tools run join. The keeper hands Claude the command, arguments and
  environment the SDK built, and passes on the signals the SDK sends. It sends SIGKILL to the group
  when Claude exits, whether it exits on its own or after the grace, or when a stop asks it to, so no
  command a session started outlives it. Domovoi never signals the group by number, because once the
  group's last process has gone that number can name another group. After the keeper has gone,
  Domovoi checks the group with signal 0 until no process is left in it. A command that moves itself
  to a new session or process group is out of reach.
  
  Before Claude, the keeper starts a second member of the group, the sentinel: `/bin/sh` with no
  environment, which reads one line from its own pipe to Domovoi and then sends SIGKILL to its own
  group. If the keeper dies on its own, for example because something sent it SIGKILL, Domovoi does
  not treat Claude as exited, and a stop asks the sentinel to kill the group. The sentinel also kills
  the group when Domovoi goes away and its pipe closes. If the sentinel has died too, nothing is
  signalled and the stop fails. Claude then stays listed, and the profile lease stays held, until
  signal 0 finds no process left in the group. If the sentinel cannot start, the keeper does not start
  Claude.
  
  On Windows a stop first runs `taskkill /PID <pid> /T /F` on Claude's process tree, while Claude
  still runs, because once Claude has exited taskkill can no longer find the processes it started.
  Domovoi runs the system copy, `System32\taskkill.exe` under the `SystemRoot` directory, from that
  directory, and never looks the name up in the current directory or on PATH. If `SystemRoot` is not
  an absolute path on a drive, it uses `C:\Windows`. Claude gets no time to finish writing its
  transcript. Once taskkill has finished, Domovoi kills
  Claude through its own process handle if it still runs, closes the input and the query, and waits
  up to 5 seconds from the start of the stop for Claude to exit. If taskkill cannot start or reports a
  failure, the stop fails, and every later stop of that process fails too: once Claude has exited,
  nothing can say whether the processes it started have ended.
  
  A Windows Claude process that exits on its own, before any stop, gets no taskkill, because its pid
  can name another process by then. Its exit alone no longer counts as the end of what it started, and
  Domovoi does not look for what it left: a process found by a list is named only by its pid, which
  can name another process by the time it is killed. What that Claude started stays unconfirmed. The
  stop fails, and every later stop and daemon stop fails too, as after a failed taskkill. This
  includes a Claude that the Claude Agent SDK ends itself, outside a stop.
  
  If the process still runs after the kill, or a process it started is not known to have ended, for
  example because it refused the kill, the stop fails. Closing a project then leaves the session
  failed, and it refuses new messages until it is recovered. Recovery stops the failed process before
  it starts a replacement or takes a checkpoint, and fails while that process runs. An emergency stop
  tries every earlier failed stop again, and reports each one until its process has exited. Before, a
  stop returned at once. The session was saved idle, and a later message could start a second Claude
  query in the same worktree while the first still ran, even under a new daemon on the same profile.
  
  A daemon stop fails too, and keeps the profile lease. A start that was still preparing when the
  stop began starts no Claude, and a model list still starting or listing is stopped, and its Claude
  process waited for, like a session's. Once a daemon stop has succeeded, no later start runs Claude.
  When SIGINT or SIGTERM stops a foreground daemon and a Claude process, or a process it started, is
  not known to have ended, the daemon prints the pid and Claude session, keeps running and keeps the
  profile lock, and exits once the process has ended. The second SIGINT exits at once, after a warning
  that the lock is released while the process may still run, even when it came while the daemon was
  still stopping. SIGTERM does not, and does not count toward the second SIGINT.
  
  A stop asked for again while Claude is stopping waits for the same exit, and a Claude conversation is
  not reopened, or reported loaded, while an earlier process for it still runs.
- 0a7be6d: An IPv4-mapped IPv6 address counts as loopback only inside 127.0.0.0/8. The check matched any
  mapped address whose hex began with `7f`, so `::ffff:7.240.0.1` was treated as this machine when
  classifying routes, choosing which routes to dial and checking a tailnet host.
- e6fa2ec: The protocol package exports `notificationMethods`, the schema of the params of every notification
  the daemon sends, with the `NotificationMethod` and `NotificationParams` types. The daemon now sends
  a notification only if its payload parses against that schema and carries no field the schema does
  not describe. A refused notification is reported and not sent. A workspace resync that cannot be
  built closes the slow client, which reconnects, instead of sending an unchecked snapshot. The
  daemon's RPC writer sends a notification only as a frame built from `notificationMethods`, and a
  response only as a frame whose serialized envelope is a JSON-RPC 2.0 response, whose result parses
  against its method's result schema, whose error data is one of the protocol's declared error data
  kinds, and which carries no field those schemas do not describe. A result that fails the check is
  reported and the request gets an internal error instead.
- 9901dd5: Resuming an OpenCode or Kilo session is refused when its history pages repeat a cursor, since the
  pages then cannot be shown to cover the history, and a full page that comes back without a cursor
  is followed by one read of the whole history before the next message id is chosen.
- 9086190: OpenCode and Kilo sessions ask before every tool that is not one of the server's own. The embedded
  configuration now starts its permissions with a `"*": "ask"` rule and restates each server's own
  rules for its built-in tools after it, in the top-level block and in every agent block, so a call
  to a tool server's tool, the person's own included, raises an approval card, and every built-in
  tool keeps the action it had in each agent a session runs. A session is refused when a tool server
  or a tool that is not the server's own could take a name the server's own tools ask under. Kilo's
  explore subagent now sees tool server tools and asks before each call, where they were hidden
  before. A steer the server accepts after its turn has ended is aborted and reported as failed. A
  tool call started or an approval asked for by a run outside any turn, a subagent's included,
  aborts that run, and the approval is refused. A turn now ends only on an idle after its own reply
  has completed or failed, so an aborted run's idles no longer end a later turn; a stopped or
  interrupted turn ends when the abort is answered. Aborts to a session go out one at a time, an
  abort not answered within ten seconds counts as failed, and a new prompt waits for a pending abort.
  A finished tool's report no longer aborts a turn. A turn whose end the events do not show, such as
  one whose replies follow automatic compaction or whose setup failed, is settled from the server's
  session status and messages two seconds after an idle, error or failed abort; a busy session
  settles nothing, and reads that keep failing end the turn after thirty seconds.
- a38dbbb: Report OpenCode and Kilo reasoning effort as unset to reflect the model's own setting. Stored medium and none values read as unset, and runtime changes normalize these legacy labels without sending an effort override.
- da6d3a7: The tool inventory reports a repository's OpenCode and Kilo configuration as held back. Both servers
  start with their project configuration switched off, and Kilo's legacy files refuse the session, so
  every entry from their config files and folders is now marked held back. Skills under
  `.claude/skills` and `.agents/skills` stay marked as loading, because both servers still load them.
- ab357e9: The daemon starts only the OpenCode and Kilo releases that passed its live contract test:
  OpenCode 1.18.32 and 1.18.33, and Kilo 7.8.1. Its permission names, tool ids and rule shapes were
  read from them. It reads the executable's version before starting the server, and the output must
  be exactly one version line. Any other release, or an output it cannot read as one version line,
  refuses with a message naming the version found and the releases tested. A contract test run with
  `DOMOVOI_LIVE_PROVIDERS=1` fails when an installed server's tool ids or permission names drift.
- 2bad0b8: OpenCode and Kilo approval cards name the tool server a call belongs to. When a session's directory
  opens, the daemon reads the names of the tool servers that directory knows; a card for a tool whose
  name only one of those servers could have made carries that server as its tool server fact, which
  also takes Always off the card. A tool of the server's own, or one two servers could have made,
  names none.
- 95d5434: A failed subagent refusal is retried only against the same link of that subagent, never against a
  later subagent that reused the id, and a repeated deletion without a parent keeps the deletion's
  original thread, so unloading that thread still clears it.
- 966f5c3: OpenCode and Kilo sessions can send prompts again. OpenCode 1.18 and Kilo 7.7 refuse a message id
  that does not start with `msg` ("Expected a string starting with \"msg\""), and the adapter sent a
  random UUID with every prompt and steer, so every send failed with HTTP 400. The adapter now makes
  ids in the servers' own ascending scheme: `msg_`, the milliseconds times 4096 plus a counter as
  twelve hex digits, then fourteen random base62 characters, so they also sort with the ids the
  server makes.
  
  Each id also sorts after the last one the daemon made, when the clock steps back or a millisecond
  runs out of counter values, and after the newest message the session already holds: on resume the
  adapter reads the greatest id in the session's whole history, a page at a time, and it follows
  every message id the server reports.
  
  When a session already holds a message at the last order the servers' 48-bit field can hold, no
  id can sort after it, so the next prompt is refused with "OpenCode session has used the last
  message id the server can order, so it cannot take another message" (or the Kilo name) instead
  of sending an id that wraps to zero and sorts first. One such session does not stop ids for the
  others.
- a848818: A subagent refusal that fails after its OpenCode or Kilo thread was unloaded is dropped instead of
  being kept for the thread's next load, and a subagent deletion seen before its creation is
  remembered so the creation that follows adopts nothing.
- 4fb3d7c: A subagent refusal that fails after the subagent was deleted is dropped instead of kept for retry,
  and a subagent deleted again is remembered as the most recent deletion, so a burst of deletions
  cannot make it adoptable again.
- 263a67e: An OpenCode or Kilo subagent is now bound to the turn that started it. When that turn ends, any
  approval the subagent is still waiting on is refused on the provider and forgotten, so answering its
  card later does nothing and the subagent's work does not run. An approval the subagent asks for
  after its turn ended is refused at once, with no card, and anything else it sends then is dropped
  instead of being attached to the next turn. Approvals the thread's own agent asked for are
  unchanged.
- 36fc9d0: An OpenCode or Kilo subagent first seen while its thread has no active turn is now never linked to a
  later turn, so none of its requests become a card, and neither do those of anything it starts. A
  refusal the provider did not accept is kept and sent again when its card is answered or the
  thread's next turn starts or ends. A deleted subagent's record is dropped, with a bounded record of
  recent deletions so it is not adopted again.
- 69cbaee: OpenCode and Kilo subagents now run under Domovoi approvals, and current servers' approval
  requests reach Domovoi at all. A subagent the `task` tool starts keeps only its parent's deny
  rules, so the built-in `general` and `explore` agents ran shell commands and edits with no
  approval card, and the adapter dropped every event from a session it had not created.
  
  Every agent now asks before it edits, runs a command, fetches or leaves the project, through a
  top-level `permission` block in the inline OpenCode and Kilo configuration. The adapter follows a
  subagent session from its `session.created` event to the Domovoi thread that started it, raises
  its approval requests on that thread's turn, answers them on the subagent session, and shows its
  commands and file changes in the thread. A subagent finishing does not end the turn.
  
  OpenCode 1.18 and Kilo 7.7 send approval requests as `permission.asked`, which the adapter did not
  handle, so a Build turn that needed an approval waited forever. Both `permission.asked` and the
  older `permission.updated` are handled. A Kilo event that carries no properties, such as `sync`, no
  longer ends the event stream and fails the turn.
- 767c388: When an OpenCode or Kilo thread is stopped or its provider session is deleted, every approval still
  pending for it or its subagents is refused on the provider and forgotten, so a later answer to its
  card sends nothing. A provider-deleted session fails the active turn ("OpenCode deleted the
  session") and unloads the thread. A deleted subagent's pending and failed refusals are dropped, and
  an unknown session is adopted only from its creation event.
- 35a0cc6: Run the person's own installed `claude` for Claude Code sessions. The daemon finds `claude` on the
  tool PATH, the executable provider readiness already reports, and passes that path to the Claude
  Agent SDK instead of letting the SDK start its own bundled agent binary. Without `claude`
  installed, model discovery and new or resumed Claude Code sessions fail with "Claude Code is not
  installed" and the SDK is never called.
  
  The desktop app no longer packages the SDK's per-platform `@anthropic-ai/claude-agent-sdk-*`
  packages, so it carries no copy of the agent binary and packaging never re-signs one. It still
  bundles the SDK's JavaScript library, which the daemon imports.
- c204537: The "Paused by <client>." row that `session.pause` and `system.pauseAll` write now carries the
  `connectionId` of the authenticated client connection that asked, and its `clientId` when the
  connection has one. The body is unchanged, and a pause asked by no client connection writes neither
  field.
- 973430f: Phone and tablet credentials may now call `tool.inventory`, so the phone can show what the open
  repository holds back, entry by entry. The method stays observe-tier and read-only: it reports
  environment key names, never values, and commands the daemon has already redacted. Repository
  trust is still granted and taken back from desktop or web only: `repository.trust` and
  `repository.revokeTrust` remain outside the phone and tablet scope, and the daemon refuses them to
  those credentials before reading their parameters.
- 1fadaa1: Retain exact reviewed skill text by digest with bounded on-demand retrieval, report missing revisions as unavailable, and validate versioned declared scopes before approval or prompt delivery.
- 6de27ad: Windows task scripts pass the task name, and WSL task scripts pass the task name, registration source, `wsl.exe` path and action arguments (the distribution, Linux user and guest paths), as UTF-8 base64 data. PowerShell ends a single-quoted string at the smart quotes ’ ‘ ‚ ‛ as well as at the ASCII apostrophe, so doubling the apostrophe alone let such a value end its string.
- 71efbdd: Recover a profile after verified service removal using an owner-only receipt bound to the exact
  stopped instance and installation registration. New service installations carry that registration;
  older saved configurations remain readable but need reinstalling to gain automatic removal proof.
  
  For legacy or custom supervisors, `domovoid profile recover --confirm-no-supervisor` records the
  operator's explicit assertion that no supervisor will restart the daemon. It refuses a live owner,
  does not start a daemon, and does not treat missing configuration or elapsed time as shutdown proof.
- ea4a201: A provider disconnect no longer marks a frozen transfer source or an unfinished archive as failed. Those sessions keep their lifecycle and provider thread, so the workspace snapshot stays valid and saves, `system.hello` and `workspace.get` keep working. Any turn or approval they still held on the exited process is cleared, as for other sessions of that provider. The disconnect result is also validated on a copy before it reaches the live workspace. Queued sends it holds are written in one store transaction before anything else changes; if the store refuses one, that send stays as it was and the rest of the disconnect still applies.
- adc3f35: Provider exit reasons read the child's stderr once its streams have closed. The Codex app-server
  transport and the ACP agents built the "exited with code 1: <stderr>" reason in the process `exit`
  handler, and Node documents that stdio may still be open when `exit` fires, so the last line a
  crashing CLI printed ("401", "Not logged in") could miss the reason and the failure be classified
  as unknown. The reason is now built on `close`. A grandchild that inherited the pipes can hold
  `close` off indefinitely, so the end is reported 500 ms after `exit` if `close` has not come by then.
- 706d626: Claude and Codex sessions produce a working plan again. Claude Code 2.1.292 offers no plan tool to
  current models unless `CLAUDE_CODE_ENABLE_TODO_TOOLS` is set, and its plan tools are now TaskCreate,
  TaskUpdate and TaskList rather than TodoWrite. The daemon starts Claude with that variable set and
  builds the working plan from those calls, keeping TodoWrite for older Claude Code. A resumed Claude
  session reads its task list from Claude's own task storage, read only, so updates after a daemon
  restart keep the whole plan. In Plan mode the task checklist is not reported as the plan, so the
  proposal in Claude's reply still becomes the plan. Codex 0.160.1 registers `update_plan` only when
  `tools.update_plan.enabled` is true, so every thread the daemon starts or resumes now sets it,
  overriding a person's own `false` for Domovoi threads.
- ed11c45: `project.open` on a folder that is not a Git repository, a path that does not exist, or a repository with no commits now answers "That folder is not a Git repository with at least one commit" instead of "Internal daemon error", and `domovoid open` prints that sentence. The git error stays in the daemon log. Git missing from PATH answers "Git was not found on this machine's PATH. Install Git, then restart Domovoi so it can find it." and a safe.directory ownership refusal answers "Git refused this folder because a different user owns it. Add it to Git's safe.directory list, then open it again."; `domovoid open` repeats both. Other inspection failures, such as a permission error, keep the internal error. When `session.send` cannot connect to the provider, resume its thread, or start a turn, the session records the classified provider failure, so clients show the sign-in, quota or change-model guidance, and the call answers with that failure's fixed message. A failed steer of a running turn answers the same way but does not mark the session, because its turn is still running. Timeouts and cancellations keep their existing handling.
- ce5444a: The staged runtime goes into place only after every step that can refuse with nothing changed: on install after the handoff, its profile check and the caller's fence, and the claim of the profile for the service; on update right before the new launch agent or user unit is written (after the bootout and the profile claim on launchd), or first in the swap for WSL. A unit write that fails after it no longer reports that nothing was changed; the previous unit is written back and started.
- 9387a5d: Make the protocol package installable from a registry tarball. The manifest now carries top level
  `main` and `types` so consumers on the `node10` module resolution can find the declarations, a
  `default` export condition so CommonJS and non `import` resolvers reach the same entry, a
  `./package.json` subpath, `sideEffects: false`, and the `keywords` and `bugs` metadata a registry
  listing needs. A `prepack` script builds `dist` before packing, so a tarball can no longer be
  produced without the files its manifest points at.
- f9955d6: A queued message the running build cannot read no longer stops the daemon from starting. The row moves to a `queued_session_send_quarantine` table with its bytes and the reason, a `queued-send.quarantine` audit receipt names it, the daemon error log reports it, and the other queued messages still load. Reasons written when a queued message changes state are trimmed and bounded to the 1,024 UTF-16 units the loader accepts. If the database is locked or the move fails, the row is skipped for that load, stays where it is, and the error log says it was not moved; the next load tries again. A new queued message for the same session moves an unreadable row aside before replacing it, and refuses to replace it if the move fails. A row with no session id is moved aside once. The daemon keeps the same bounded reason in memory that it writes to disk.
- 28efb31: Give audit queries and exports their own finite 30-second read deadline, independent of agent operations. A short agent timeout no longer cancels valid audit reads. Preserve audit cancellation and rejection of results that arrive after the audit deadline.
- 80c8318: Add a guest crash supervisor with three bounded restarts, private atomic evidence and explicit exhaustion status. Stop and retire one supervisor registration, proving its loop and recorded children dead before task removal. Service status returns failure for exhausted, failed or unbound supervision while preserving its diagnostics. WSL installer selection remains pending.
- 2a0d03a: Move machine credentials and their index behind a bounded serialized worker so a slow OS
  keychain cannot stop unrelated RPC, provider or terminal delivery. Keep caller deadlines
  across queueing, construction and native steps, without allowing timed-out work to be overtaken.
  Recheck fleet eligibility after reads and preserve journal digest checks during index repair
  and deletion. The local fleet-keychain recovery CLI uses the same worker.
  
  No wire or pairing migration is required. Native work already entered can finish after the
  caller expires; pending operations stay visible until reconciliation verifies the result.
  A failed worker requires a daemon restart. Shutdown reports failure if its exit is unconfirmed.
- 130500f: Stop and verify the Windows logon task before removing its registration and saved configuration.
  Previously removal could report success while the daemon kept running. Windows removal now uses
  the built-in PowerShell Task Scheduler API, disables new starts, and shares one 30-second deadline
  across all phases. An unavailable manager, unknown state, or timeout refuses with an actionable
  task-specific error instead of falling back to deletion. Credentials, identity, session state, and
  worktrees are not removed.
- 4f3c3b5: Quitting the desktop while a service handoff is stopping its own daemon now waits for that stop,
  so an emergency stop's state save is not cut off. On SIGINT or SIGTERM the daemon is stopped even
  when its endpoint file cannot be removed, and each failure is written to stderr.
- 946f8ee: Wait for a killed process to exit before treating what it held as free.
  
  Session archive killed the session's terminals and then removed the worktree without waiting. A
  pty shell keeps that worktree as its working directory until it actually exits, so the removal
  raced a dying shell, which Windows refuses outright while a handle is still open. Archive now
  observes each closed terminal's exit before removing the worktree, under the existing agent
  timeout, and reports a terminal whose exit it could not confirm.
  
  The Codex stdio transport reported its close as soon as it sent SIGKILL rather than when the
  app-server exited, so a shutdown could claim a stopped provider and a reconnect could start a
  replacement alongside a process that still held the workspace. The close now waits for the real
  exit after the kill, bounded by the same shutdown grace, which is the pattern the ACP transport
  already uses.
- d34d0a0: The Windows job helper no longer loads PowerShell modules, which shortens each helper start for service status and supervision.
- 7cd200e: Preserve non-default daemon settings when installing systemd, launchd, and Windows logon services. Each launch reads the same validated non-secret configuration, including TLS paths, listener settings, allowed origins, and identity paths. Installation refuses an environment-only bearer instead of silently changing credentials; use a private credential file before installing. Service manager operations share a bounded deadline.
- 997661b: Recover interrupted session creation and checkpoint forks from durable intent.
  Preserve unfinished work without replaying provider setup. Expose a recovered
  worktree only after its completion receipt, repository, branch, and HEAD verify;
  otherwise retain its location for inspection. Keep intent through failed or late
  cleanup until worktree removal settles or a session snapshot commits.
- bf44657: Redact only the thread items a stream changed when saving the workspace. Every save used to run
  every redaction rule over the project's whole thread, which was about 90% of a save's time and grew
  with history: 17 ms at 1,000 thread items and 174 ms at 10,000. The persistence worker now keeps
  the redacted copy of each item and reuses it while the item is unchanged, compared by value, so a
  save redacts the approvals, the rules and the items that changed. The whole snapshot is still
  validated and written on every save. A worker save now takes 9 ms at 1,000 items and 89 ms at
  10,000, down from 25 ms and 258 ms.
- 7a069eb: Secret redaction now catches prefixed variable names such as `DOMOVOI_AUTH_TOKEN`, `NPM_TOKEN`,
  `HF_TOKEN`, `DATABASE_PASSWORD`, `POSTGRES_PASSWORD` and `CLOUDFLARE_API_TOKEN`. The name patterns
  required a word boundary right before the sensitive word, and `_` is a word character, so
  `NPM_TOKEN=value` was stored, broadcast and shown on approval cards in clear, and a command
  carrying one was not treated as containing a secret. A sensitive name may now carry an identifier
  prefix in assignments, `export`, PowerShell `$env:`, `set "..."`, JSON-style keys, `--prefix-token`
  flags and `-Dprefix.password=` properties, including npm's `//registry.npmjs.org/:_authToken=` and
  `npm_config__authToken=`. `SECRET_KEY`, `DJANGO_SECRET_KEY` and `STRIPE_SECRET_KEY` are caught too.
  A suffix still does not count, so `TOKEN_BUDGET=4096`, `TOKENIZERS_PARALLELISM=false` and
  `SECRET_KEY_BASE` are left alone, and a negated flag such as `psql --no-password mydb`,
  `mysql --skip-password mydb` or `tool --db-no-password mydb` is not taken as a secret. After a
  prefixed name, a plain number or `true`/`false` stays visible when the word right before the
  sensitive name is `total`, `has`, `max`, `min`, `count`, `is` or `enable`, so `total_token=5` and
  `has_secret=false` read as written. Every other value stays hidden, including
  `DB_PASSWORD=123456` and `limit_token=5`. One-dash flags such as `-db-password value`
  and `-token value` are read as flags too. The terminal holds a prefixed name whole across reads,
  with a `set "` or `$env:` before it, drops the rest of a value that outgrows what it carries up to
  the value's end, and does not show a counting value whose line began before an idle flush. A
  quoted value it drops ends only at an unescaped closing quote, even when a backslash and the quote
  arrive in different reads. When a name alone outgrows what it carries, the value that follows is
  still dropped whole, quoted or not, and the fields after it are kept. A quoted flag or `-D`
  property value now honours backslash escapes, so `--token "a\"b"` is hidden whole instead of
  leaving `b` in clear. A quoted value, including `$'...'`, now stays hidden up to its unescaped
  closing quote across spaces, tabs, `;`, CR, LF and terminal reads, so `NPM_TOKEN="a b"` read in
  two pieces and `--npm-token="a\rb"` no longer show `b`, in terminal output, stored command output,
  approval cards and thread copies. A quote that never closes hides the rest of the record, and the
  terminal and the command output stream keep hiding into the following output until it closes,
  across an idle flush too. A command substitution, `$(...)` or a backtick pair, now stays hidden up to
  its matching closing delimiter, nested or inside double quotes, across spaces, line breaks and
  terminal reads, so `TOKEN=$(get secret value)` and ``--token `get secret` `` no longer show what
  follows the first space. A substitution that never closes is handled as an unclosed quote is.
  Process substitutions, `<(...)` and `>(...)`, parameter expansions, `${...}`, arithmetic,
  `$((...))`, and array assignments, `NAME=(...)`, now stay hidden up to their closers the same way,
  so `NPM_TOKEN=<(printf a b)`, `NPM_TOKEN=${VAR:-a b}` and `NPM_TOKEN=(a b)` no longer show what
  follows the first space. A value is now read as one shell word: a quote in the middle of it opens
  (`TOKEN=ab"c d"`, `TOKEN=ab'c d'`, `TOKEN=ab$'c d'`), and a quoted value goes on to its delimiter
  after its closing quote. A quote opened right before a name, as in `set "NAME=value"` or
  `echo "NAME=a b"`, holds the value up to that quote's closer, honouring backslash escapes as any
  quoted value does, so `set "TOKEN=a\"b"` no longer shows `b`, and the value goes on to its delimiter
  after the closer, as `echo "TOKEN=a"b` is one word. Where the terminal has lost what came
  before a name (an idle flush in the middle of it, or a name longer than it carries), a quote in the
  value still opens, so a `set "NAME=value"` split there may hide the output that follows until
  another quote arrives. A deeply nested value read one
  character at a time now costs each read only what that read holds, rather than a copy of the whole
  nesting. A `-D` property may have spaces after its `=`, so `java -DPassword= value` is hidden. A
  name and separator inside a value, as in `-DGITHUB_TOKEN ==Password: value`, hide the value that
  follows them too, even past the end of the value they sit in. A name and separator at the end of a
  line, as in `X_TOKEN:` or `{"x-token":`, hide the first value on the next line in the command
  output stream as they already did in stored output and the terminal, so that stream holds such a
  line until the next one arrives. A name inside another name's quoted value, as in
  `java -Dpassword="a API_KEY=b" -jar app.jar`, is part of that value: it is hidden with it, and what
  follows the value is kept. A doubled separator or terminal formatting where a value starts, as in
  `TOKEN==(a b)` or a colour code before the value, still lets an array's `(` open there. The
  terminal no longer shows a value that ends in or holds a sensitive word when a read ends inside it,
  as in `TOKEN=abctoken` followed by more, or a flag typed one character at a time: it holds from the
  name that value belongs to. A sensitive word glued to the end of a value, with a separator after it
  (`TOKEN=abctoken: value`), hides the value after it. At an idle beat the terminal keeps dropping a
  word it was reading, a closed quote's word included, up to its delimiter, and a name and separator
  at the end of what it shows drop the value typed after the beat. A name after the closing quote of
  `set "NAME=value"` hides its own value in every copy. A long chain of glued names
  (`API_KEY=a_token=a_token=…`) is read in linear time.
- 9c12124: `device.redeemCode` validates `protocolVersion` with the shared protocol version schema, like every other version reader. A noncanonical or overlong version (such as `01.8.0`) is now refused as invalid params with the request's id, instead of passing validation and failing inside the compatibility check as an internal error with `id: null`.
- bbdfa6b: Removing the login service reads the profile owner, takes the profile lease and writes any recovery receipt under the profile the saved configuration names under its own home, as the service runs it, including for a configuration saved before it named its profile directory.
- 1a246bd: The desktop now removes daemon runtime copies no login service uses. Each install or update publishes the runtime into a fresh `<profile>/runtime/<version>/<id>`, about 150 MB, and until now nothing removed the earlier ones or the copy a failed change left. Once an install or update has confirmed its new service, the desktop asks the daemon (`removeUnusedDaemonRuntimes`) to remove the copies under that profile that neither the service definition nor the one before the change names.
  
  The removal runs under the service-operation lease and reads the definition again there. It removes nothing when the lease is busy, when the definition no longer names the copy this change published, when the previous definition named something other than a published copy, or when a definition or the saved configuration cannot be read. Only `<version>/<id>` directories reached through real directories are candidates; links are never followed or removed. Paths are compared by file identity, and each candidate is renamed to a private name and removed only if it is still the directory that was checked. `readDaemonServiceRuntimeCopy` reads which copy the service runs, and throws rather than read a failed query as no service. A copy a failed change leaves stays until the next confirmed one. Nothing new is shown in the app.
- 8e18a9b: Creating a session no longer runs code the repository brings. Claude Code sessions loaded the
  worktree's project and local settings, so a tracked `.claude/settings.json` hook, `env` block or
  helper command and every `.mcp.json` server ran with no approval card, in every mode including
  Ask. OpenCode and Kilo loaded project configuration, plugins and MCP entries for the worktree and
  ran a package install in its `.opencode` directories.
  
  Until a repository trust step exists, Claude Code sessions start with only user settings, and the
  OpenCode and Kilo servers start with project configuration switched off. Instruction files still
  reach the agent: the daemon reads `CLAUDE.md` (with its `@path` imports inside the worktree),
  `.claude/CLAUDE.md` and `CLAUDE.local.md` for Claude Code, and the first of `AGENTS.md`,
  `CLAUDE.md` and `CONTEXT.md` for OpenCode and Kilo, and passes them as system prompt text. Project
  skills, subagents and commands under `.claude/` are not loaded for Claude Code sessions.
  
  Kilo reads `.kilo/mcp.json`, `.kilocode/mcp.json` and `.kilocodemodes` from the session directory
  even with project configuration switched off, and starts the MCP servers they name. The daemon now
  refuses to open, resume or send a turn to a Kilo session in a worktree that contains one of them,
  and names the file.
- 3ccf0f3: The daemon can read a repository's own Claude Code, OpenCode and Kilo configuration without running
  any of it, for the tool inventory and repository trust. It lists the tool servers, hooks, environment
  key names, permission rules, helper commands, plugins and skills those files declare, and computes
  the configuration digest a trust grant pins to. The scope includes Kilo's `config.json` and the
  `tui.json` and `tui.jsonc` plugin files OpenCode and Kilo load. A repository root that is itself a link
  is refused like any other link. Every command, rule and name is redacted before it leaves the reader,
  and environment values are never read. Each text is cut before its first trigger and ends in
  `[REDACTED]`: an authorization scheme word, a sensitive key or flag, an assignment, a header flag
  (`-H`, `--header`, `--proxy-header`), URL user info, or any credential shape the protocol's check
  knows. The reader looks for a trigger in every form that check reads: as written, quoted strings
  included; after one layer of percent encoding; after backslash and `\u` escapes; as the shell's
  words; and among a JSON argument vector's strings. Each of those readings is taken again of every
  form another makes, until no new form appears. Text whose forms still change after six readings or
  64 forms is cut after its program name, or reads `[REDACTED]` alone. A command given as an argument
  vector is cut at whole arguments. Before the cut, a URL keeps its scheme and host, and its path and every query and
  fragment value read `[REDACTED]`. The protocol's check then judges each text once; one it would still
  refuse is cut after its program name, or reads `[REDACTED]` alone. Nothing calls the reader yet; the
  `tool.inventory` handler and the trust store come later.
  
  The protocol exports the cap on each tool inventory entry text field
  (`maximumToolInventoryCommandLength`, `maximumToolInventoryDetailLength`,
  `maximumToolInventoryMatcherLength`, `maximumToolInventoryNameLength`,
  `maximumToolInventoryHelperNameLength`, `maximumToolInventoryRuleLength` and
  `maximumToolInventoryEventLength`), and the inventory schema holds each field to them. The daemon's
  reader fits every redacted text to the same constants. It also exports its credential check
  (`holdsCredential`), the rules that check reads (`credentialRules`: scheme words, sensitive key
  parts, whole-name keys, pointer suffixes and token prefixes, frozen), `isCredentialKey` and
  `credentialShapeAt`, which finds the first credential shape in work that grows linearly with the
  text. The daemon's reader takes its rules from these rather than a copy.
- c5767cd: The daemon now checks the connection's credential before it takes `repository.trust` or
  `repository.revokeTrust`, never the client the connection declares. It admits the owner's bearer
  credential when the connection declared desktop or web, which means any process running as the
  owner can call them, and a paired desktop or web credential with full access. It refuses a relay
  channel with "This method requires a direct connection", and every other connection (a paired
  command-line, phone, tablet or watching credential, a machine credential, and a bearer that
  declared another client or none) with "Repository trust requires the daemon credential or a paired
  desktop or web credential with full access". The methods have no handler yet.
  
  `device.pair` now refuses to mint a desktop credential for a connection that declared web, phone or
  tablet, and `device.issueCode` refuses such a connection a desktop pairing code, both with "A web,
  phone or tablet connection cannot pair a desktop credential", so a browser that holds a pasted
  bearer cannot pair itself as a desktop. Phone, tablet and web codes are issued as before.
- cec544b: The daemon now decides repository trust per session worktree, in one module. A worktree is
  trusted only when it holds nothing that refuses trust and its configuration digest is the one this
  machine's grant names. Otherwise it is held back, with a reason code: `not-trusted` with no grant,
  `cannot-trust` when the worktree holds input the digest does not cover, `config-changed` when its
  configuration is not the one trusted, and `unreadable` when it cannot be read. A trusted verdict
  gives the worktree's `.claude/settings.json`, `.mcp.json` and `.codex/config.toml` parsed from the
  same bytes the digest covers. The reader returns those documents only when asked, so an inventory
  read still holds no configuration text. What each adapter loads under a trusted verdict is in its
  own entry below.
  
  Every call that opens a provider thread or starts a turn now carries the grant, looked up in the
  trust store at that call: session creation, fork, provider restart, provider handoff, resume and
  each turn. Resuming a thread only to archive it carries none. A trust store that fails is reported
  and gives no grant. Claude Code and Codex apply the grant; OpenCode, Kilo and the ACP agents
  ignore it.
  
  `tool.inventory` now marks an entry held back where its adapter provably keeps it from the agent:
  every entry from `.claude/settings.json` and `.mcp.json` for Claude Code, which starts with the
  person's own settings only, and every entry from `.codex/config.toml` and `.codex/hooks.json` for
  Codex, which refuses a worktree holding them. Skills, OpenCode, Kilo and the ACP agents stay
  unmarked. `tool.inventory` and `repository.trust` read the repository root as a session's linked
  worktree reads it, so hooks in the root's own `.codex` folder, which Codex would take into every
  session, refuse trust there with `main-checkout-hooks`.
- c9855a1: Taking repository trust back now stops the agent threads that loaded the repository's trusted
  configuration. An adapter reports that through the optional `repositoryTrustApplied`, which the
  daemon asks after each call that carried a grant; a grant that was passed and not applied leaves
  the thread alone. The Claude adapter reports it, and the Codex adapter reports it when repository
  tool servers loaded.
  
  `repository.revokeTrust` deletes the grant first, then, for every such thread of the project,
  interrupts its active turn and stops the thread, each within the agent timeout, and lists the
  session in `threads`. It is `restarted` when the stop resolved and `unconfirmed` when the stop timed
  out or failed. A Codex thread is `unconfirmed` either way, since Codex runs every thread in one
  app-server and cannot confirm that the tool servers a thread started have exited. An unconfirmed
  session is marked failed and fenced as an emergency stop fences a thread it could not stop. The number
  of threads never refuses a revoke: every thread stops, the result lists the first 1,024, and
  `omittedThreads` counts the rest.
  
  A thread is tracked from the moment the provider call returns, before anything is saved, and
  stays tracked until its exit is confirmed. An unconfirmed thread stays tracked and fenced, and
  every later revoke tries to stop it again. So is a thread that a failed session start, fork,
  restart or handoff could not stop, and one that quarantine, a transfer or an ownership conflict
  dropped without confirming its exit. A revoke attempts every stop even when holding a queued send
  or clearing approvals fails, and reports those failures afterwards. Cleanup of a failed handoff
  thread is now bounded by the agent timeout. A start that lands after its call timed out is
  tracked before its late cleanup stops it. A resume or turn start that carried a grant and then
  timed out or failed is tracked as if it applied the grant before its thread is quarantined, and
  one that lands after its timeout is stopped as a late start is. Until such a call settles, its
  thread stays tracked whatever stops it meanwhile, and a revoke stops it; when it settles, resolved
  or rejected, a thread whose adapter reports the grant applied is stopped again. A thread leaves
  tracking only when no grant-carrying call and no late or abandoned stop on it is in flight, and a
  stop that began after the last point a grant may have been applied has resolved. A revoke that stops a session
  waiting on an approval leaves it idle, as it does a session with an active turn.
  
  A stopped Codex thread that loaded trusted configuration is never counted as exited, since
  archiving it cannot confirm that the tool servers it started exited. While the grant holds, those
  run under consent: a Codex thread stopped on any other path (archive, project switch, emergency
  stop, quarantine, a provider switch, a failed start) is remembered and fences nothing. A revoke of
  the project reports each remembered thread `unconfirmed` and fences its session until the daemon
  restarts; a new grant does not lift that.
  
  While a session has a thread that loaded trusted configuration and that it no longer names, or one
  that is fenced, a message, a restart, a provider switch or a fork of that session is refused with
  "Provider thread requires recovery after emergency stop". Each attempt first tries to stop the
  thread again, and a confirmed stop lifts the fence. A thread a revoke is stopping fences its
  session from the moment it is claimed, and a stop on another path that finishes meanwhile does not
  release it. When a revoke or such a retry confirms a stop that an earlier revoke or emergency stop
  could not, that thread's fence is lifted, and a failed session that names a thread is usable again
  once no other thread holds it. A Codex stop never lifts a fence this way, and a Codex thread whose
  earlier stop failed stays fenced after a later stop resolves. A fork of a session whose own thread
  an emergency stop could not stop is refused until the session is recovered, as a message is.
  Recovering such a session by switching its provider is refused when that thread is a Codex thread
  that loaded trusted configuration, since no stop can confirm its tool servers exited; it stays
  fenced until the daemon restarts. Recovery of any other thread is unchanged.
  
  Nothing resumes a stopped thread: the next message resumes it, and that resume carries no grant. A
  queued send is held with "Repository trust was taken back before the queued send could release."
  Each stopped session gets a notice: "Repository trust was taken back, so the agent was stopped."
  with "The next message resumes it without this repository's configuration.", or, when unconfirmed,
  "Repository trust was taken back, and Domovoi could not confirm that the agent stopped." with "It
  may still be running with this repository's configuration, so Domovoi will not start another agent
  here. Restart Domovoi to clear it, or archive the session."
  
  A revoke that arrives during an emergency stop takes the grant back at once and stops what the
  emergency stop left once it finishes. An emergency stop that begins during a revoke does not
  interrupt the turns the revoke is stopping, and the revoke still answers with its result. Threads
  that loaded nothing under a grant, and other projects' grants, are not touched.
- 9f1ce54: The daemon now records repository trust and answers `repository.trust` and
  `repository.revokeTrust`. It keeps one grant per repository on this machine in its state database,
  with the configuration digest the grant covers, when it was granted, and which client granted it.
  The client comes from the connection's credential: the owner's bearer credential is recorded as
  desktop with no client id, and a paired desktop or web credential as its own client with its device
  id. At most 512 grants are kept; the oldest beyond that are dropped, which leaves those
  repositories not trusted. A stored grant the protocol would refuse reads as no grant. A grant, the
  trim to the cap and a read back of the grant commit together or not at all. A table under the
  store's name that is not the one it creates, or that has a trigger on it, yields no grant and
  takes none; that includes a table named in another case, a trigger naming the table in another
  case, a generated or hidden column, and an index that compares project ids other than byte for
  byte. A grant is read and revoked only for the exact project id. When a failed grant cannot be rolled back, the store reads
  and records no grant for the rest of the daemon's run, and rolls back the transaction it opened. A revocation that leaves the grant stored fails with the internal error rather than
  reporting the repository not trusted. An emergency stop during a trust request's configuration
  read cancels it: nothing is recorded, and it is answered like any cancelled operation.
  
  `repository.trust` reads the open repository's configuration now. When the digest the client sent
  is not the current one it records nothing and answers `config-changed` with the current digest and
  state. When the repository holds input the digest does not cover, it records nothing and answers
  `cannot-trust` with the reader's refusals. Otherwise it records the grant and answers `trusted`.
  `repository.revokeTrust` removes the grant and reports the repository not trusted, with no threads
  listed, since nothing loads under trust yet. Both refuse a project other than the open one with
  "Repository trust applies only to the open project". A reader failure is answered with the daemon's
  internal error, which names no path or value.
  
  `tool.inventory` now reports the repository's real trust: trusted when the grant's digest is the
  current one, not trusted because the configuration changed (with the earlier grant) when it is
  not, not trusted with no grant, and cannot be trusted, with its refusals, when the reader refuses
  it. Trust is recorded, not applied: sessions still start with the repository's configuration kept
  back as before, and no inventory entry is marked held back.
- 9cac913: The restore lease record is no longer flushed to disk on every write, and the writes no longer
  block the daemon's event loop. A restore wrote the record three times per Git command, each with a
  synchronous flush; on Windows runners a flush measured up to 0.85 s, so one restore could stall the
  daemon for seconds. The record is still written to a new file and renamed over the old one, so a
  reader sees a whole record, and a crash of the daemon process keeps the last completed rename.
  After an OS crash or power loss an unflushed record can be lost or torn; no Git child survives a
  reboot, and recovery already refuses to reclaim a claim whose record lists children or cannot be
  read, so the claim is kept for inspection as before.
- 8e3a45f: Recover abandoned transfer restore claims only after the owner has exited and
  every Git command has a recorded, uninterrupted settlement. Preserve claims when
  descendant liveness is unknown, including after command cancellation or a missing
  exit record. Keep exclusion through command close and delayed claim cleanup;
  refuse legacy or incomplete ownership records explicitly.
- 1dd9ee7: A standing approval rule now covers only what the approved request could reach. A file-tool
  rule matched the tool anywhere in the worktree, so one "Always in this project" on an Edit approved
  later edits to `package.json`, test files and runner configuration; and a rule for any other
  provider tool matched on its bare name, so one WebFetch rule approved every later fetch, including
  one that carries data out, and one MCP rule approved every call to that tool.
  
  File-tool requests now resolve to a record scoped to the target file (`coverage: "tool-and-file"`,
  `scope: "file"`, `path`), so a rule covers that tool on that file. Rules made for the whole
  worktree stay listed and no longer match; Settings says so. Requests for provider tools that are
  neither a shell command nor a file tool, such as WebFetch, WebSearch and MCP tools, stay unresolved,
  so no standing rule can be made for them and each one asks.
  
  A file-tool request aimed at the worktree root itself names no file and now stays unresolved. It
  used to fail validation while resolving, so the request got no card and the provider waited for an
  answer that never came. Resolving a request no longer throws at all: one it cannot fingerprint is
  unresolved, which still raises a card and makes no standing rule. Claude's Read, Glob, Grep and Task
  requests stay unresolved inside and outside the worktree, so each one asks and none can become a
  standing rule.
  
  A file-tool target is read the way the filesystem reads it: each link is followed before the `..`
  after it applies, a dangling link leads where it points, and a relative path starts at the request's
  directory. A rule for an inside file no longer matches a path that a link carries outside. The
  Claude adapter passes the file name exactly as the provider will use it, untrimmed and with `..`
  kept. A `package.json` that is not a regular file, or that is too large or too slow to read, leaves
  a script run unresolved instead of holding the request.
  
  A provider tool is identified by the tool that runs, not by fields in its input: an MCP request
  whose input carries `command: "Edit"` and a `file_path` stays unresolved instead of taking the
  Edit rule's digest, a Claude file tool is always named by its tool, and a Bash request never
  sends a file path. Approving a file-tool card reads its target again first, the way a changed
  package script already was: if the file the edit reaches changed while the card waited, for
  example because a directory on its path became a link out of the worktree, the edit is not
  released and the card is updated for review. A card updated this way keeps its hard gate. The
  refusal for a file-tool card reads "The file target changed; review the updated approval before
  allowing it"; a shell or script card keeps "The resolved command changed". The check runs when the
  card is answered, not when the provider writes, so a target swapped in between still reaches the
  provider. The path each waiting file-tool card was raised for is held in memory and dropped once
  the card leaves, whether it was answered, archived, cleared by a provider disconnect, session close
  or emergency stop, or expired.
  
  A file-tool target that is a file with more than one hard link stays unresolved: its other names
  share its bytes and may lie outside the worktree, so no standing rule applies to it and its card
  offers no Always. Domovoi never releases an edit to such a file: moving one of its other names
  changes nothing Domovoi reads at the file, so Allow once is refused with "This file has other names
  Domovoi cannot check, so Domovoi will not release the edit.", both for a file that had another name
  when its card was raised and for one that gained a name while the card waited (that card is also
  rewritten under its next revision). A file that does not exist yet is unaffected. An
  existing target that is not a regular file (a directory, FIFO, socket or device) stays unresolved
  the same way, read with lstat only, so a FIFO is never opened; a regular file replaced by one while
  its card waits is refused when the card is answered.
- ae04086: `updateDaemonService` reports the new outcome `runtime-copied` when, on systemd or for a WSL guest, the staged runtime was published and then failed its check before anything about the service changed: "Domovoi could not update the service: <detail>. The new runtime was copied to <copy>, but the service was left as it was, set to run the previous runtime." On systemd and for a WSL guest the update waits for the publish rather than cutting it short at its deadline, and answers by what happened to the copy: a copy published while the deadline expired is `runtime-copied` too, and a publish that fails, or that never started because the deadline had expired, reports `nothing-changed` with no restore. launchd and the Windows task publish after the previous service was stopped, and a WSL guest update that resumes an interrupted one may find no task running, so there a failure is a failed swap and the previous service is put back and must report ready. When the deadline has expired by the time the check fails, the deadline is named as the detail.
- 404ea5e: `installDaemonService` and `updateDaemonService` take a `staged` runtime with a `publish` step, run once under the service-operation lease after every refusal. The desktop publishes into a fresh directory, so a failure after it leaves the runtime the previous service runs as it was and nothing is put back. An update holds the lease until a publish its deadline gave up on has settled. `readDaemonServiceRuntimeVersion` reads the version from `<profile>/runtime/<version>/<id>/node/bin/node`.
- 584e7d9: Derive runtime build versions from release metadata. Fleet facts, daemon and client greetings,
  and provider initialization report the running release instead of a fixed development version.
  Production startup refreshes the persisted local version without changing machine identity.
  Wire protocol compatibility and existing pairings are unchanged.
- e08eda3: Whole-snapshot writes no longer discard concurrent changes. An arriving `transfer.commit` imports only its session into the live workspace at the save point, so two overlapping commits keep both sessions. `session.fork` merges only the new session into the live workspace, so text another session streams during the save is kept. The transfer commit, the provider thread restart and the ownership-conflict write now join the persistence serializer, so a worker write posted earlier can no longer land after them and put an older snapshot back on disk.
- 2cdba11: Refuse overlapping service install, status and removal commands using a separate per-OS-user
  operation lease held across file and manager steps. Changing the shell's home cannot bypass it.
  The daemon can still take its own profile lease while installation waits for startup. A refused
  command names the lease and asks the operator to retry after the active command finishes.
  
  The existing deadline remains shared across the whole operation. After a timeout the lease stays
  held until the CLI exits. A killed or timed-out CLI does not prove a native manager cancelled its
  job; inspect the manager and saved configuration before retrying. No credentials are changed.
- 74d9782: The service handoff fence now refuses while an emergency stop runs, with `An emergency stop is
  still running.`, until the stop has finished, its state save included. The stop clears turns and
  gates before that save, so the fence used to find nothing in flight and could let a service
  handoff stop the daemon in the middle of the stop. A stop whose save fails still finishes and
  reports the persistence failure; the fence is granted after it. A fence taken before a stop began
  stays held through it, as before.
  
  Daemon shutdown now waits for an emergency stop that is still running, its state save included,
  before it closes the store. A handoff that stops the daemon under a fence taken before the stop
  no longer loses the stop's record.
  
  An emergency stop now writes a durable intent to the daemon's store before it acts, and clears it
  once its state is saved. If the process ends before that save (a crash, a kill, a quit deadline),
  the next start on the same store records `Emergency stop requested by <client>.` on each session
  the stop touched before it accepts any connection. Startup recovery already ends the interrupted
  turns and expires the waiting gates. A start whose save of that record fails does not open.
  
  A stop finished at restart now leaves each session as a completed stop leaves it: a dispatch the
  stop caught in flight has its provider thread reset and its session marked failed. A journal row
  that does not read back no longer keeps the daemon from starting: it is moved whole to a separate
  table, reported once, and the readable stops are still finished.
  
  A journal row goes to that table only when no stop can be read from it. A row that holds a stop
  beside fields it does not know is finished from the fields it can read, and a copy of it is kept.
  A dispatch's provider thread id is kept whole in the intent, so a thread id with any character in
  it is reset at restart as a completed stop resets it.
  
  A row that repeats a field is finished for every value it gives (each stop id, every listed
  session) and a copy of it is kept. Every entry of a row is read, however many before it do not
  read. A row with more readable entries than a stop keeps is finished as far as it goes, reported
  on each start, and left in the journal.
  
  Reading a damaged journal row now finishes in bounded time and memory: nothing is built past the
  kept number of entries, the work one row asks of a restart is capped (what fits is finished, and
  the row is kept and reported), and each session is named once.
- 7e84a65: The daemon exports `serviceProfileMismatch`, which compares the profile a caller's environment names with the one the saved login service configuration names (or the default profile an install writes). The desktop refuses to install, remove or update the login service when the two differ, because its turn check and fence reach only its own daemon; it says which profiles they are. Update the service now takes the daemon's fence before it copies the runtime under the profile, so no turn starts on a copy that is being replaced.
- a352dde: The service calls name and compare the caller's and the saved service's profile by the path rules of the platform the service is for, not the host's: a macOS or Linux service's default profile shows with `/` on any host, and Windows profiles compare without regard to case.
- 2b8c93f: `installDaemonService`, `updateDaemonService` and `removeDaemonService` take the caller's daemon environment. Given it, each checks the saved service's profile against the profile it names under the service-operation lease, before the handoff or any manager action, and throws `ServiceProfileMismatchError` when they differ. `serviceProfileMismatch` now reads only a missing `service.json` as none saved; one that cannot be reached throws. With none saved, any profile matches, since an install writes the caller's profile.
- 19b1892: Given the caller's environment, install and removal refuse a registered launch agent or user unit whose saved configuration is missing, unreadable or malformed, with `ServiceProfileUnknownError`, before the handoff or any manager action: the profile it runs is not known. The command line, which passes no environment, is unchanged. Removal checks the caller's profile against the same read of service.json it then acts on.
- 4b6afef: With no saved service configuration, a caller's install or removal asks the service manager for a Domovoi registration, not only the definition file: a launchd job loaded under Domovoi's label or any `sh.domovoi.*` label, or a loaded `domovoi*` systemd user unit, refuses it as a service whose profile is not known. Removal compares the caller's profile with the one the saved configuration names under its own home. A saved configuration an install cannot read or parse refuses with the specific refusal.
- 55ecb69: `installDaemonService` and `updateDaemonService` take a `staged` runtime: its files are checked first, and its `publish` step runs only under the service-operation lease, after every profile check and before the handoff or any manager action. The desktop prepares an inert copy in a hidden directory under the profile, hands it over, and discards any copy the service call did not publish, so a refused change leaves every file as it was. While it copies and publishes, the desktop requires the profile's runtime directory to stay the directory it checked, by device, inode and real path, and writes nothing more when it changed.
- 900eadd: The daemon reads which runtime version the login service runs, from the service's own definition. When the desktop cannot talk to the daemon that owns the profile and a login service is installed, the refusal names that version, or says the service is older when the definition does not name one.
- 24e0aa5: `readDaemonServiceRuntimeVersion` reports a version only when the service definition is exactly what an install writes for a published copy, `<profile>/runtime/<version>/<id>`, under the profile the saved configuration names: the whole launchd plist or systemd unit as Domovoi renders it, or a Windows task with one action whose command and arguments are the install's. `<version>` must pass the check the desktop publishes under. Anything else, a `Program` key, a later `ExecStart` line, a second task action, another profile's runtime or an entry from another copy included, reports installed with no version.
- 788f63d: Prevent concurrent transfer chunk retries from removing a directory while another receive
  still holds a chunk open, which can fail with EPERM on Windows. Reserve the complete member
  receive through cleanup within the daemon process, refuse overlapping receives without a
  queue wait, and release the reservation after errors so later retries can proceed.
- 6ab8dad: Workspace snapshot writes that arrive while one is still waiting to start now share that write, since each write carries the whole live snapshot as it stands when it starts. The backlog is at most one running and one pending write, so a burst of provider events or RPCs no longer queues one whole-snapshot write each and delays tool rows and approval cards behind them.
- 90a3111: Report service runtime state on macOS and Windows. Distinguish a loaded launch agent from a running process, and read numeric Task Scheduler state instead of localized status text.
- 6b30c51: Attempt restore-claim close and removal independently, always clearing the process-local reservation. Verify a unique ownership token before removing a claim, preserving an observed replacement and naming its ownership change. Report cleanup failures with the claim path while preserving the original restore failure. If restoration already completed, explicitly warn against retrying it. Manual claim removal still requires stopped daemons because token verification and unlink are not atomic.
- f15b01b: Build node-pty from source during verified bootstrap installation on musl or unknown Linux libc instead of choosing its libc-unqualified prebuild. Check native module loading before publishing an installation and on receipt reuse, within the existing five-minute deadline. An unusable existing runtime is refused with a path and remedy, never replaced automatically.
  
  The pinned Node 22 Alpine smoke installs the real archive, opens a PTY, and authenticates against the production daemon. Python, make, a C++ compiler, platform headers, and registry access remain required. Manual package-manager installs do not apply the bootstrap policy; native compilation and the external toolchain are not frozen by the runtime lock.
- 2c9ffc1: Accept a WebSocket whose Origin names this daemon, so a phone that sends the address it dialled can pair.
- c250637: The desktop copies the shipped runtime under the selected profile, `<profile>/runtime/<version>` (`~/.domovoi/runtime/<version>` for the default profile), so a service change that is then refused replaces at most its own profile's copy. A refused install or removal of a login service whose profile is not known reads as a refusal. `readDaemonServiceRuntimeVersion` reads the version from that layout under any profile.
- 6e252b0: When the only staging place on the profile's volume fails the check that no
  other account can change it, the app's refusal says so instead of saying the
  profile is on a different volume. It names the directory and the check: group
  or others can write it, another account owns it, a macOS access control entry
  lets another account change it, or who can change it could not be confirmed.
  On Windows, where access rules are not read, it says the directory could not be
  confirmed inside the user profile. It lists any directories made before the
  refusal. Every other staging refusal keeps the different-volume sentence.
- ee3fe90: Add separate, kind-bound remote client grants and Fleet client admission. A machine pairing remains daemon-to-daemon authority, not permission for a desktop or browser to control the target.
  
  Authorize this client in Fleet takes a separate client credential for the target, one a device.pair request made with the target daemon's own credential returns. No Domovoi command or screen hands out that raw credential yet: `domovoid pair` prints a one-time pairing code, which the dialog does not take. Use, Terminal and inventory reads require the target identity and client receipt to verify. Desktop main verifies each enrolled route through the home daemon and grants only that exact socket origin. Update both daemons and the client before using these additive calls. The wire remains 0.5.0, existing pairings remain valid and no re-pair is required.
  
  Client credentials stay only in app memory. Closing the app or removing local access does not revoke the remote grant; revoke the device in the target's Devices list. Remote Desktop preview frames remain unavailable until they have a separate verified path. This does not enable a hosted relay or expose the daemon's machine keychain to the client.
  
  Desktop serves its bundle from an explicit app origin so response CSP is enforced. Existing development profiles may need appearance, layout and first-run preferences selected again because old file-origin browser storage is not migrated. The daemon profile and its canonical sessions are unchanged.
  
  If `DOMOVOI_ALLOWED_ORIGINS` is explicitly configured, add the exact `domovoi-app://desktop` origin and restart that daemon. The default configuration already includes it; custom lists are not silently widened.
- 7e30caa: Stored state that cannot be read is no longer moved aside silently. The daemon records a `state.quarantine` audit receipt naming the kept file, logs it, and returns an optional `stateRecovery` field on every client `system.hello` result until it restarts. A database moved aside whole, including one where `PRAGMA quick_check` finds damage in a table other than the workspace, keeps its workspace snapshot and paired devices when they still read and validate. Paired devices receive only whether a recovery happened and what was kept, not the path or the failure text. State written by a newer protocol minor is read through a read-only connection, left byte for byte in place, and startup fails with a message naming the file and both versions, so going back to an older build no longer resets the newer build's workspace.
- 5bdac19: Startup now reads the emergency stop journal 16 rows at a time. A group of rows holds only its own
  rows and the stops they name. The rows it read, the stops it acted on and the lines it will write go
  to the store, in new `emergency_stop_recovery_rows` and `emergency_stop_recovery_lines` tables,
  not into a copy of the workspace. The workspace is copied and saved once, after the last group,
  with every line, and only then are the finished rows cleared. So what a group holds, and the work
  it does, does not grow with the number of stops earlier groups recovered. After the save the
  workspace holds the lines, as it holds every line on the thread. Every stop is still finished before
  the daemon accepts connections.
  
  A startup that ends before that save leaves in the journal every row it read a stop from, and the
  next one reads those rows again. A row from which no stop could be read may already have moved to
  `emergency_stop_intent_quarantine`. The store lists the stops a recovery has acted on, in a new
  `emergency_stop_recovery` table, until the recovery is done, and a line such a recovery wrote does
  not count as the stop's record.
  
  A row can reach the journal behind the groups, or take the place of a row recovery cleared (from
  another writer on the store, or a trigger in it). After each save, another round reads every row no
  round has read, known by its rowid and content rather than by how many rows are left, and recovery
  ends only when a round finds none and emptying the stop list adds none. Past 16 rounds, startup fails
  instead of accepting connections;
  the rounds so far stay saved, and the next start continues. The error says that if this happens
  again, something outside Domovoi is writing to the store, and it needs repair. A row is cleared only
  while it is still the row that was read, and each row once. The rows left to clear are found through
  a partial index, `emergency_stop_recovery_rows_due`, created on first use, so rows that stay listed
  are not read again for each batch.
  
  Going back to a build without emergency stop journal recovery while a stop is pending is not
  protected. The desktop 0.0.1 release is such a build: it does not read the journal, so it starts and
  accepts connections without applying the pending stop.
  
  Looking up whether a damaged row already has a copy in `emergency_stop_intent_quarantine` now uses
  an index on that table, created on first use in a store that lacks it, instead of reading the whole
  table for each row. Moving an unreadable row aside, and clearing a finished one, now removes that
  row alone. Before, a row stored under a null key took every other row under a null key with it.
- 191f4fe: Stop an OpenCode or Kilo session when its server reports an approval reply the daemon did
  not send. Both servers read their password only from their startup environment, which every
  program they start can read as the same user. A reply counts as the daemon's only once the
  server has accepted the daemon's answer. Any other reply refuses every request still waiting,
  aborts the session's runs and waits for the server to confirm, fails the session with
  `approval-answered-elsewhere`, holds a queued send, and records
  `provider.approval-answered-elsewhere` in the audit log. The audit entry and the session's
  notice name the answered card and its facts as the card showed them (operation, command,
  directory, affected files, tool server, hard gate), read when the report arrives, or say the
  answer matched no card. The audit entry says the match was made against the cards shown then
  (`match=currently-shown`); when none matched, the notice adds that a Domovoi decision may
  already have been saved or sent and that its acceptance was not confirmed. They are recorded even when an archive, a transfer or an emergency
  stop took the session before the report was handled; only a session still running is
  stopped. Until then the answered card gets no deny from an archive or an emergency stop, which
  note instead that it was answered outside Domovoi, and a person's answer to it is refused,
  including one already being saved, so neither its receipt nor a standing rule is kept. A
  standing rule is now saved only after the decision that makes it is committed, and first as a
  rule pending delivery, which never answers a request. It is made active only after delivery:
  the adapter's `resolveApproval` returned for a request it was tracking as waiting, which is
  not an acknowledgement from the provider. Every provider adapter now throws
  `ApprovalRequestNotPendingError` for an answer to a request it is not waiting on, instead of
  dropping it silently. An emergency stop that begins while the pending rule is saved cancels the
  decision: it is never sent, its receipt and rule are taken back, and what the stop removed
  stays removed. A daemon that loads a rule still pending delivery drops it and records
  `approval-rule.undelivered` in the audit log. A refused or failed decision whose undo cannot
  be saved leaves at most its receipt, checkpoint row and a pending rule in the state file, never
  an active rule, and the next save that lands removes them. That holds for a decision that was
  never sent. When the save that makes a delivered rule active reports failure, the Allow was
  sent once and the rule stays pending in memory, but a rejected save is not proof that no
  active rule reached the state file: a save can fail after writing, and a restart then loads
  the rule active. A later whole save that lands rewrites it as pending, which the next load
  drops. The answer is `-32014` with "Domovoi sent this Allow once, but could not confirm the
  standing rule was saved. It may or may not be in force after Domovoi restarts. Check Standing
  approval rules in Settings, Permissions and rules." The
  daemon then stops the server,
  so no approval it kept in memory stays in place, and every other session on it reconnects to a
  new server on its next message. An abort the server does not confirm also stops the server.
  The stopped session's provider session is never resumed: it continues only after the person
  restarts its provider thread, which starts a new one. The daemon now starts the OpenCode and
  Kilo servers itself, on POSIX under a keeper that holds their process group, and starts no
  other server for that provider until a stop has confirmed the old one's processes are gone; a
  server it cannot confirm gone is stopped again on each new message, which is refused with
  plain recovery steps until the processes are confirmed gone or the person restarts Domovoi. On
  Windows a stop is confirmed only by the first `taskkill /T` succeeding while the server's first
  process runs, followed by its exit; a first process that exits before any `taskkill`, or any
  `taskkill` that fails, leaves the stop unconfirmed until Domovoi restarts. A permission
  answer with no outcome within 10 seconds counts as unknown. The session view tells
  the person to review the session's changes, because the server lets the approved call run
  before the daemon hears of the reply. The desktop setup steps show the same incident for that
  provider and do not offer to finish setup, instead of reporting the provider ready.
- 67e712e: State written by a newer protocol minor is refused with `NewerWorkspaceStateError`, which names the
  path and both versions: "Domovoi state at <path> was written by a newer daemon (protocol <stored>),
  and this daemon speaks protocol <daemon>. It was left as it is and this daemon did not start. Run
  the newer Domovoi again, or update this one to protocol <stored major.minor> or later." `domovoid`
  prints that message and exits 1 instead of a stack, and the desktop's acquisition carries it as the
  refusal message instead of the generic profile one.
- 41a8edf: When SQLite ends a store transaction on its own, as it does when the database is full, saving a transferred session and holding queued sends now report the error that ended it. Before, the rollback that followed failed with "no transaction is active", and that message replaced the real cause. If that happens while phone pairings are being copied out of a database moved aside at startup, the daemon now starts and its recovery notice says the pairings were not kept, instead of failing to start.
- 77481e5: Save a streaming session at least once a second. The daemon waits for a 32 ms pause in streamed
  text before it saves the workspace, so a stream that never paused stayed only in memory until it
  ended. A save now also runs 1 s after the first unsaved delta, however fast deltas keep arriving.
  Each save still redacts, validates and writes the whole snapshot as before.
- bdb1d89: Install the verified daemon archive through its reviewed production dependency lock. Package the
  integrity-bearing lock under a non-special name, bind the same-release protocol archive, and use
  private staging with bundled npm 10.0.0 or newer. Materialise the lock as package-lock.json, run
  npm ci without dependency scripts, verify the physical graph and fetched-integrity records, run
  only the reviewed node-pty build, and publish a runnable receipt after verification.
  
  The bootstrap keeps one five-minute total deadline including installation, native build,
  verification, and cleanup. Existing or concurrent matching installs are verified and reused,
  never overwritten. Failure can retain a verified archive or private staging but is not reported
  as a completed installation. No provider SDK is bundled, no service starts, and PATH is unchanged.
  
  Manual npm, pnpm, or Bun adds of the daemon are not frozen. Native compilation, Node, the OS, and
  the external toolchain remain reproducibility limits. The protocol library still supports all
  three package managers independently.
- e4d278b: `DOMOVOI_TAILNET_HOST` is checked as the URL parser reads it: a name the parser
  rewrites into another host, such as `1.0x0` (1.0.0.0) or `127.0x1`
  (127.0.0.1), is refused, as is any name that parses to a loopback or wildcard
  address. The tailnet certificate and key are not read when either is larger
  than 64 KiB; the tailnet listener alone is refused.
- 7afb1e2: Update the Anthropic SDK to preserve native abort and timeout errors across JavaScript realms.
- 84d90d5: Persist turn ordinals and exact message links across steering, restart and transfer.
- 52f75d0: Remove the temporary transfer root a daemon created for itself. A daemon on in-memory state has no
  directory beside its state file to keep transfer packages in, so it makes one under the operating
  system temporary directory. Nothing removed it, so every such daemon left a
  `domovoi-transfer-transactions-` tree behind for the life of the machine.
  
  The daemon now records the root it created and removes it as the last step of shutdown, after the
  store and the usage ledger are closed and nothing is still writing packages into it. Removal
  retries a refusal from a transfer that just released a file, and a removal that still fails is
  reported with the rest of the shutdown failures instead of being dropped.
- eef6cea: Terminal redaction no longer leaks a value typed after an idle beat released its name. The daemon
  holds back a tail that might become a secret and releases it on a short idle beat so a prompt
  shows; a value typed after the released name went out in clear, live and in the replay a
  rejoining client is handed. The terminal redactor is still main's held-tail redactor. After an
  idle release, the line as shown stays as context until it ends: a name and separator in it, even
  one split around the beat, make what follows that name's value, and the value is shown as the
  replacement. Durable redaction is unchanged.
- 3fdab3d: Terminal output no longer reaches phones and tablets. The daemon sent every terminal's
  `terminal.output`, `terminal.ownership` and `terminal.closed` notifications to every connected
  client, so a paired phone or tablet credential, including a watching-only one, received the live
  bytes of any terminal the owner opened, although the pairing card says terminal output is not on a
  phone. Those notifications now go only to the connections that opened the terminal with
  `terminal.create` or took it with `terminal.claim`, and never to a phone, tablet or watching-only
  credential. A connection that closes leaves the terminal's audience.
- 06e19f1: A terminal's owner keeps it across a reconnect. Ownership now follows the client a direct connection authenticated as (its hello identity, or its paired device), not only the socket: when the owner reconnects, the daemon hands the terminal back at the hello and announces it with `terminal.ownership`, so it is not reaped after 30 seconds just because the terminal pane was not open, and a new connection that attaches before the old one has closed can type instead of being refused as another client. Another client is still refused, an abandoned terminal is still reaped, and relay channels stay bound to the channel that admitted them. Every move of the terminal to another connection of the same client, whether by typing, resizing, closing or reopening the pane, by the reattach at hello, or by the handoff when the holding connection closes, is announced to the terminal's audience with `terminal.ownership`, the same notice a claim sends.
- a0bf7a0: Terminal redaction adds a second stage after the existing one, which runs
  unchanged first. The second stage reads the terminal output as it reads on
  screen: control sequences and control characters, OSC strings among them, are
  not part of the line, a carriage return after a name and separator that are
  still waiting for their value does not end the wait, and idle beats do not
  matter. It hides the values those names take and the rest of a bare token
  after its prefix, however long, and it only ever removes characters from what
  the first stage shows. Formatting between a sensitive name and its separator,
  a value written after a redraw, a bare token longer than the 256 characters
  the terminal carries, and a bare token cut by an idle beat no longer show.
- bdac41e: A connection that watches a terminal gets output still waiting in the batch either in its record or
  live, not both, including when it was already watching. Closed terminal records share one budget
  of 1,048,576 characters and at most 16 records, and the oldest are dropped first when a new one
  would not fit.
- 87b573b: Publish file-backed root credentials and local owner challenge keys only after their private
  staging bytes are synced and closed. A killed first initializer no longer leaves an empty
  authoritative file, and concurrent initializers reuse the winning credential without replacement.
  Initialization is bounded by the remaining startup deadline and requires hard-link support.
  Existing malformed files remain untouched; startup names an explicit offline quarantine remedy.
- 7fa4caf: Export a daemon command module that shares service installation, status, and removal with the daemon worker and resolves the packaged worker entry independently of the invoking CLI.
  
  The domovoid service install command now registers the daemon's own dist/index.js, resolved from the module's real location, instead of the path used to start the invoking process in process.argv[1].
- 678e172: The daemon now answers `tool.inventory`. It reads the open repository's own Claude Code, Codex,
  OpenCode and Kilo configuration with the repository configuration reader, which runs nothing, and
  answers with each agent's files and entries, the configuration digest a trust decision will pin
  to, and the repository's trust on this machine. There is no trust store yet, so every repository
  is reported as not trusted. No entry is marked held back yet, and every agent reports its tool
  servers as read from its files, since Domovoi starts none of them with tool servers removed. With
  no project open the answer lists no agents. An answer larger than the protocol's byte budget
  leaves out entries from the agent listing the most and counts them in that agent's
  `omittedEntries`. A reader failure, or an answer the protocol would refuse, is answered with the
  daemon's internal error, which names no path or value. Phone and tablet credentials are refused,
  as for `skill.inventory`.
- cb8b27a: An approval card names the tool server behind a call to a tool server's tool, and the daemon
  refuses Always for any such card before it reads the card's execution record. Claude MCP tools are
  named from `mcp__<server>__<tool>`. Codex MCP tool calls, which Codex asks about with an MCP
  elicitation, now raise an approval card when the request is tied to exactly one running call of that
  server on the same thread and turn; any other request marked as a tool call approval is declined.
  The card states the call's tool, server and arguments first, and the request's own message only as
  unchecked text. The answer never asks Codex to remember it. An ACP tool call is a shell command
  only when its kind is `execute`. An OpenCode or Kilo permission is a shell command only for `bash`
  with its command; an edit of one file is the Edit file tool on that file, so Always still makes a
  file rule; any other permission, one with no name included, is the provider's tool, which cannot
  become a standing rule.
  
  The protocol's `toolServer` fact can name a server without the file that declared it: the daemon
  names a server as the agent names it when it did not read that server's configuration, so
  `transport`, `source` and `file` are optional, and a file still needs its source.
- b5b1aa9: Harden session transfers against interference and interrupted work.
  
  Promoted artifact sources are opened without following symlinks and read through
  the handle that was validated, so a file swapped after its check cannot be read
  in its place. Non-final transfer chunks must be exactly one chunk long, which
  bounds what a sender can make the journal hold.
  
  Transfers no longer block unrelated sessions, concurrent transfers no longer
  overwrite each other's state, and a move interrupted by a failed terminal
  shutdown, a crash between commit and save, or a failed journal write leaves the
  source recoverable rather than frozen or silently thawed.
- b5b1aa9: Preserve managed worktrees and durable checkpoint refs across session transfers,
  and expose sanitized target-contact evidence before an operator can recover a
  frozen source.
- 7cf6870: Validate direct transport kinds as a discriminated contract before selecting an endpoint.
  Local, WSL and SSH routes require loopback; LAN and tailnet require non-loopback TLS endpoints.
  Only SSH accepts a configuration flag, and it must be explicit. Reserved relay records cannot
  be enabled through the legacy availability flag. Endpoint bounds and credential-protection
  rules are shared with enrollment. A loopback advertise host is now classified as local.
  The client dialer uses the same eligibility rule and returns safe typed refusals for invalid
  descriptors, without copying endpoint contents or schema diagnostics into the error.
  
  Previously accepted contradictory cached descriptors fail closed. Ship this change with the
  damaged fleet-row quarantine so those records remain visible and recoverable through fresh
  enrollment rather than being silently relabelled.
- 1c4e9b6: A failure while the daemon records a provider stop or a grant-carrying call, after trust was
  taken back, is now reported through the daemon's error log instead of an unobserved promise
  rejection. The thread's pending-work count still ends, so a later revoke can release it. A failure
  before the stop's timeout fails the stop and fences the thread, as any failed stop does.
- 82ab538: The repository trust store now accepts its table only when the table's indexes are exactly the two it
  creates: the primary key's index and `repository_trust_trusted_at` on `trusted_at`, each comparing
  its key as bytes, and each belonging to the table. Any other index refuses the table, even one that
  compares bytes. Before, the store looked each listed index up by name. An unqualified name found a
  temporary index of the same name first; a table or virtual table named `pragma_index_xinfo`, in any
  schema, answered for the lookup function; and an index name stored as invalid UTF-8 read back as
  U+FFFD, and looking that text up found a different index. Each let an index that compares project
  ids without regard to case pass. The store now reads keys only for its two fixed index names, from
  the main schema, with the `PRAGMA main.index_xinfo` statement, and an index with no key column
  refuses the table.
- b2e5888: Generate release SBOMs from the daemon's packed runtime lock, including non-host optional
  packages and the embedded protocol. Component SHA-512 hashes and the separate protocol
  artifact are bound to the locked archive bytes. Validate CycloneDX 1.6 offline before
  publishing checksums. Missing local license observations remain empty rather than hiding
  components; external toolchains and unfrozen manual installs remain outside this inventory.
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
- 3e773b4: Refuse `update.status`, `update.check` and `update.activate` off the loopback
  owner connection with `localOwnerRequiredErrorCode` instead of the authentication
  code. The refusal conditions and message are unchanged. A client no longer reads
  the refusal as a revoked credential, so a paired tab that opens Settings keeps
  its connection.
- b30b27e: Preserve absent provider effort defaults and start those models with unset effort. Claude offers Model's own first when effort is supported, omits the initial effort override, and clears an existing override when unset is selected. Normalize legacy medium effort to unset when a model reports neither levels nor a default, so stored sessions can restart and change runtime.
- d828526: A plan file the artifact watcher found in the worktree is no longer removed when the working plan
  changes, and comments on it stay on it. Before, every plan edit, provider plan update, turn boundary
  edit, streamed plan text and finished Plan mode plan read the file's artifact as an old turn-scoped
  working plan, folded it into the working plan and moved its comments there; the file came back only
  after it changed on disk. Turn-scoped working plans from older profiles are still folded into the
  working plan. A saved working plan that kept a plan file's path from that fold is taken over as the
  working plan and loses the path, so a session never holds two working plans with the same id.
  Streamed plan text now reaches clients as appends while a watched plan file exists, instead of a full
  workspace snapshot for every chunk. An append carries only content and revision, so the chunk that
  takes over such a saved working plan still sends the full snapshot, and clients drop its path,
  variant and file title as the daemon did.
- d46672f: Add an HTTP handler for a loaded Domovoi web bundle, with validated listener authorities, explicit security headers, cache revalidation and fixed unavailable-state pages. The handler serves only loaded files and does not read from disk per request. Listener integration follows separately, so the daemon serves no new routes yet.
- 8a205cf: The daemon gains a loader for the web app bundle. It reads a bundle into memory once and refuses the whole bundle, with a typed reason, when the manifest is missing, malformed or for another protocol minor, a path is not plain or names a daemon route, an extension is outside the table, a file is a link, a FIFO or another non-regular file, a file has a second hard link, the root overlaps the profile directory, a file or directory is owned by another account than the daemon's or root or is writable by group or others, a directory above the root is owned by another account or is writable by others without the sticky bit, a size or digest differs, or two listed paths open one file. Nothing calls the loader yet, so the daemon serves nothing new.
- 4ddf93f: Add authenticated daemon update discovery and staging; defer activation with a policy refusal.
- 12524c9: Supervise the Windows logon daemon in a job object with bounded crash restart and recorded exhaustion. Require job-empty evidence before restarting or removing a supervised tree, and refuse ambiguous same-boot recovery until Windows restarts.
  
  Allow removal, reinstall, and update of a supervised registration that never launched after Task Scheduler confirms it is disabled with no instances and the startup lease protects the empty launch history.
  
  Recover after helper death using recorded kill-on-close confirmation, absence of the exact Global job name, and death of the recorded daemon identity. This establishes termination started, completion not observed; the profile lease guards a second owner.
  
  Keep Windows retirement active and hold the startup lease until Task Scheduler confirms the old task is disabled with no instances before allowing an update or reinstall to restart it.
  
  Preserve Task Scheduler removal for recognized legacy Windows tasks and migrate them to job supervision on install or update. Scheduler retirement does not prove every legacy descendant dead; profile changes still require the free profile lease.
  
  Retire and stop an existing supervised Windows registration before reinstall writes new configuration, including when its last supervisor stopped or exhausted its retries.
  
  Bound Windows process and job observations by the remaining service-operation deadline, reject expired observations, and retain the 20-second per-query ceiling.
  
  Report Windows status from boot and terminal tree evidence without opening stale recorded PIDs that may have been reused by protected processes.
  
  Restore the prior supervised Windows task action and enabled state when reinstall cannot publish its runtime, write its configuration, or register the replacement. Recreate a deleted registration without issuing a demand start; retain the disabled task if configuration restoration fails.
- 107912f: Domovoi retries its initial Windows supervisor process identity query once if the helper reaches its 20 s cap at logon, keeping the same cap for the retry. If the retry fails, startup reports that this start launched no daemon and the logon task starts the supervisor again at the next logon.
- 91ed6c1: A Windows daemon no longer exits at startup when another process has its local owner record open.
  Windows refuses to replace a file that another reader holds open, such as the desktop, a CLI status
  check or an antivirus scan, and the daemon's `local-owner.json` publish failed with EPERM and an
  uncaught error. Under the login service that counted as a crash, and enough of them exhausted
  supervision. The replace now retries an EPERM, EACCES or EBUSY refusal on Windows for up to five
  seconds, the same bound the Windows supervisor record uses, and blocks the daemon for at most that
  long. A file still held after five seconds fails with an error that names the file and the sharing
  refusal. Other platforms and other errors fail at once as before.
- 1080704: A status read or scan that briefly holds the record open no longer ends Windows supervision. The supervisor retries sharing failures for up to five seconds, then fails closed as before. Stop request and shutdown record writes also retry within the stop operation deadline.
- 08d39f0: Windows replaces more of its metadata files when another process has the old one open. Windows
  refuses to replace a file that a reader holds open, such as the supervisor, a status check, the
  desktop or an antivirus scan, and these replaces failed at once with EPERM, EACCES or EBUSY: a
  workspace restore's owner record, the service configuration `service.json` written during install
  or update, and the owner removal receipt. Each now retries that refusal on Windows for up to five
  seconds, waiting 5 ms and doubling to 250 ms, the bound the local owner record already uses. The
  service and removal writes still stop at their operation deadline. A file still held after five
  seconds fails with an error that names the file and the sharing refusal. Other platforms and other
  errors fail at once as before.
- 90bb877: Windows install and update register the logon task through the Task Scheduler COM API, so commands over 261 characters from Node version managers can install. The quoted program is limited to 260 characters, and the encoded PowerShell registration command line to 32,766 characters. Refusals name the length and path part before service files change.
  
  Encode user, program and argument values as UTF-8 base64 data so PowerShell cannot interpret apostrophes or smart quotes as script delimiters.
  
  Restore only the action rebuilt from validated runtime, entry and configuration paths after an install or update failure.
- 6011264: Windows install now refuses a command over 261 characters, the limit schtasks applies,
  instead of letting a 262-character command through to fail at schtasks after service.json was written.
  The refusal names the command's length and its longest path.
- 308e63d: Updating a Windows logon task publishes the staged runtime under the profile lease, after the task is stopped and before service.json names the new runtime and the task is registered to run it, as on the other platforms.
- d0a58b7: Make the fleet machine id contract authoritative for canonical workspace identity. `machineSchema.id` and `projectSchema.machineId` accepted any nonempty string while the fleet, credential, and pairing contracts require `machine-[0-9a-f]{32}`, so a workspace could be schema-valid while its machine could not be recorded in the fleet or used for pairing. Both fields now reuse `machineIdSchema`, and the existing snapshot refinement continues to require the project to name the workspace machine.
  
  A workspace saved with a non-canonical machine id is migrated on load rather than quarantined: the daemon replaces the legacy id with a deterministic canonical id derived from it, aligns the stored project reference, and records a system thread receipt naming both values. Sessions, approvals, artifacts, and annotations are preserved. A daemon started with a machine identity file still refuses state that names a different machine, which is unchanged behavior.
- 6832713: Refuse WSL facts on any platform but linux. A heartbeat or enrollment
  descriptor that claims a distribution for a `win32` or `darwin` daemon is
  refused as an invalid descriptor instead of being shown as a WSL machine.
- 12ca8d6: Say what `wsl.exe` could not do instead of calling it absence. `domovoid wsl
  list` and `domovoid open` now report whether WSL is not installed, the call was
  denied, it timed out, the service or distribution failed, or the answer could
  not be read, each with its remedy, instead of reporting a missing distribution
  or a missing daemon. An endpoint file that is not one a daemon published is
  refused as unreadable and nothing in it is repeated.
- 12ca8d6: Ask the distribution where a repository is before running `git` there. The
  runner that starts `git` inside a WSL distribution asks the distribution's
  own `wslpath` which Windows path the repository reads back as, so a Windows
  drive is refused wherever the distribution mounts it, not only under `/mnt`.
- 232ffe8: Bound bundle restore claim release with a quarantined cleanup lifecycle and exclude concurrent transfer member receives across daemon processes.
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
