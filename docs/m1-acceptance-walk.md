# M1 acceptance walk

A checklist for the parts of the [M1 definition of done](../SHIP-PLAN.md#m1-definition-of-done)
that only a person on real machines can prove. Tests and CI cannot close these rows. Each row
stays open until a run is recorded against it.

It covers four of the definition's bullets, plus two runs the definition leans on:

| Section | Proves |
| --- | --- |
| [1. Packaged desktop and its service](#1-packaged-desktop-and-its-service) | The packaged build installs, starts and removes its supervised daemon. Unsigned, updated by hand, and the product says so. |
| [2. New user path](#2-new-user-path) | Open a repository, start an agent, review tool activity, annotate a plan, approve and deny, restore a checkpoint, reopen after restart. |
| [3. Provider failures](#3-provider-failures) | Every supported provider failure produces an actionable state without losing the worktree. |
| [4. Install and recovery docs](#4-install-and-recovery-docs) | The installation and recovery documentation has been tested on Linux, macOS and Windows. |
| [5. Phone over the tailnet](#5-phone-over-the-tailnet) | Pairing, watching a terminal and answering a gate from a phone. `S3.0` already answered yes on 2026-09-16; this re-walks it on the build under test. |
| [6. Service lifecycle on hardware](#6-service-lifecycle-on-hardware) | Logon, logout and reboot behaviour of the login service. |

Written on 2026-10-07 from `main` at `017307b5`. Every label below was read from the code at that
commit, and checked again at `640ac4e7`, which changed the build line in section 1 and the pairing
command in section 5. If a label on screen differs, record what the screen says; the difference is
a finding, not a reason to skip the row.

## Before you start

**This walk changes the Domovoi profile of the OS account that runs it.** The app starts a daemon
that writes `~/.domovoi` (on Windows, `.domovoi` in the user profile directory), and installing
the login service writes `~/.domovoi/service.json` and a service definition for that OS user even
when `DOMOVOI_PROFILE_DIR` names another directory. There is one login service per OS user. Use a
clean machine or a separate OS account whose `~/.domovoi` holds nothing you need. Steps that
change the profile or the OS say so.

On each machine:

- Git, and a small throwaway Git repository with at least one commit. Domovoi refuses a folder
  that is not a Git repository with a commit.
- The provider CLIs you will test, installed and signed in with their own commands: `claude`,
  `codex` and `opencode`. The daemon runs OpenCode only at the versions it was tested against
  (1.18.32 and 1.18.33 at this commit). Kilo, Cursor and Grok are turned off in Domovoi and are
  not part of M1.
- For section 5: Tailscale on the computer and the phone, signed in to the same tailnet.

Record the build. For a package you built, that is `git rev-parse HEAD` in the checkout you
packaged from. Settings, "About this build", shows `domovoid <version> · <commit>`: the first seven
characters of the commit the running daemon was built from. A daemon built from a checkout whose
tracked files differ from that commit, or without Git, shows no commit, so package from a clean
checkout. Untracked files do not count.

### Run record

Add one line per run. A section passes only when every row in it says what the step expects.

| Run | Date | Machine, OS and version | Build sha | Sections walked | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | | | | | | |

Use pass, fail or blocked in every result cell (a cell printed "not applicable" stays as printed), and say in the notes what the screen showed.
Keep credentials, tokens and pairing codes out of every note.

## 1. Packaged desktop and its service

### Build the package

Package on the operating system you will install on. The packaging configuration refuses to
build for another platform. From a checkout:

```bash
pnpm install
pnpm package:desktop
```

`pnpm package:desktop` builds for the current platform and then runs the packaged-app smoke test
against the built artifact under a temporary profile. The per-platform variants,
`pnpm package:desktop:mac`, `pnpm package:desktop:linux` and `pnpm package:desktop:win`, skip that
smoke test; run `pnpm test:desktop:package` after them.

The artifacts land in `apps/desktop/dist/`, named `domovoi-desktop-<version>-<arch>.<ext>`:

| OS | Artifacts |
| --- | --- |
| macOS | `.dmg` and `.zip` |
| Linux | `.AppImage` and `.deb` (package name `domovoi-desktop`) |
| Windows | NSIS installer `.exe`, per user, with a choice of directory |

Without signing credentials, which is the M1 case, macOS builds are ad-hoc signed and not
notarized, and Windows builds are unsigned ([desktop signing](desktop-signing.md)). No document in
this repository yet tells a person how to open an app macOS has not notarized, or what Windows
SmartScreen shows for an unsigned installer. Record what each OS showed and what you did.

### Steps

1. **Install the app.** **Changes the OS.**
   - macOS: open the `.dmg` and drag Domovoi to Applications, then open it from Applications.
   - Linux: either `chmod +x domovoi-desktop-<version>-<arch>.AppImage` and run it, or
     `sudo apt install ./domovoi-desktop-<version>-<arch>.deb` and run `domovoi-desktop`.
   - Windows: run the installer `.exe`, then open Domovoi from the Start menu.
2. **First launch.** **Changes the profile.** The app starts its own daemon. Setup opens by
   itself, headed "Domovoi" and "Setup". While the daemon runs inside the app, its first step is
   "Keep Domovoi running after you quit", with the line "This build is not signed and does not
   update itself." under the buttons.
3. **Install the login service.** **Changes the profile and the OS.** Choose "Install the
   service" in setup, or later in Settings (the gear in the title bar, "Settings") under "Daemon
   on this machine", choose "Install". Setup ends with "Domovoi is running as a login service. It
   starts when you log in. It answers on loopback only." (Windows says "sign in"); Settings says
   "Installed. Quitting this app now leaves the daemon and its sessions running." Either way the
   Settings row "Keep Domovoi running after I quit" then reads "Running", and the card lists what
   it wrote under "WHAT IT WROTE". Check the OS manager:
   - macOS: `launchctl print gui/$(id -u)/sh.domovoi.domovoid` shows `state = running`.
   - Linux: `systemctl --user status domovoid.service` is active, and
     `loginctl show-user $(id -u) --property=Linger --value` prints `yes`. The install turns on
     lingering when it was off and says so ([Linux lingering](daemon-services.md#linux-lingering)).
   - Windows: Task Scheduler lists the task "Domovoi daemon"
     (`schtasks /query /tn "Domovoi daemon"`).
   - Optional, macOS with the app in Applications and Linux from the `.deb`: Settings, "Terminal
     commands", "Link the commands" puts `domovoid` and `domovoi` in `~/.local/bin`, after which
     `~/.local/bin/domovoi daemon status` answers, as does the daemon's own
     `~/.local/bin/domovoid service status`. Linking does not add `~/.local/bin` to your
     shell's PATH; until it is there, give the full path, as this walk does. Domovoi links no
     commands on Windows, from an AppImage, or from an app still running inside the disk image;
     there, use the entry point from
     [clean-machine setup, Step 2](clean-machine-setup.md#step-2-fix-the-commands-you-will-keep-using).
4. **The service keeps running.** Quit the app (macOS: Domovoi, Quit Domovoi, or ⌘Q; Windows and
   Linux: the window's Close button). The manager check from step 3 still shows the daemon
   running. Open the app again: Settings shows "Running" and "Quitting this app leaves the daemon
   and its sessions running."
5. **The product says it is unsigned and updated by hand.** Settings, "About this build": the chip
   reads "Not signed" and the line reads "This build is not signed and does not update itself.
   Get new versions from the release page." "Release page" opens
   `https://github.com/getdomovoi/domovoi/releases` in the browser. Record the
   `domovoid <version> · <commit>` label. The commit is the running daemon's, here the login
   service's, so it matches the start of the commit recorded for this build. If no commit shows,
   record that in the notes.
6. **Update by hand.** **Changes the OS. "Update the service" also changes the profile's runtime
   copy and service configuration.** Build a package from a later commit, record that commit, and
   install it over the first, as in step 1. Open the app; it attaches to the running service.
   Settings shows "The login service runs Domovoi X. This app is Y." and "Update the service" only
   when the service's version is older than the app's. Both are `0.0.1` at this commit, so two
   builds at the same version show neither; record which you saw. If the button shows, choose it
   and record the result. Then compare the commit in "About this build" with the one recorded in
   step 5. It names the build the running daemon came from, which with the login service on is
   the service's runtime copy. Record pass when it shows the later commit, and fail when it still
   shows the step 5 commit, with both commits in the notes. Read from the code, not run: at the
   same version nothing in this step replaces the service's copy, so expect the step 5 commit.
   Record blocked, with "no build identity shown" in the notes, only when no commit shows.
7. **Remove the login service.** **Changes the profile and the OS.** Settings, "Daemon on this
   machine", "Remove", then "Remove the service" in the dialog "Remove the login service?". Expect
   "Removed. Quitting Domovoi now stops the daemon and every session on it." The manager check
   from step 3 no longer finds the job. On Linux, check lingering again: it is off only if this
   install turned it on. Desktop does not show the lingering outcome of a removal yet. Removal
   keeps the credential, machine identity, workspace database and worktrees.
8. **Uninstall the app.** **Changes the OS.** Remove the service first, in step 7.
   - macOS: move Domovoi from Applications to the Bin.
   - Linux: `sudo apt remove domovoi-desktop`, or delete the AppImage.
   - Windows: Settings, Apps, Domovoi, Uninstall.

   Record what remains under `~/.domovoi`. Nothing in the app removes it.

| Step | macOS | Linux | Windows |
| --- | --- | --- | --- |
| 1 Install the app | | | |
| 2 First launch | | | |
| 3 Install the login service | | | |
| 4 The service keeps running | | | |
| 5 Says unsigned and updated by hand | | | |
| 6 Update by hand | | | |
| 7 Remove the login service | | | |
| 8 Uninstall the app | | | |

## 2. New user path

Use the packaged app from section 1, with or without the login service. Walk it once with Claude
Code and once with Codex; add OpenCode if it is installed at a tested version. Record the provider
and its CLI version (`claude --version`, `codex --version`, `opencode --version`) in the notes.

**Every step here changes the profile.** Projects, sessions, worktrees, comments, approval
receipts and checkpoints are written to it. Use the throwaway repository, not one with work you
need.

1. **Open a repository.** With no project open the thread reads "No project is open". Choose "Open
   project", pick the throwaway repository in the folder dialog "Open a project", and confirm with
   "Open project". Repository hooks, tool servers and Git filters stay held back until trusted. If
   the repository has any, Settings, "Elsewhere", "Skills", the "Tools" tab shows the repository as
   held back, with "Review and trust", then "Trust for this machine". A session refused over a Git
   filter shows "Domovoi did not start this session" with the same "Review and trust".
2. **Start an agent.** Choose "+" in the title bar ("New session") to open "Start a session". Type
   a "Session goal", pick the provider and model under "Provider and model", then "Create
   session". The thread shows "Worktree ready" and "Nothing has run yet". The mode chip in the
   composer opens "MODE FOR THE NEXT TURN" with "Plan", "Ask" and "Build"; "Auto" is a separate
   switch and works only with Build. Type a request and send it.
3. **Review tool activity.** Each turn shows a pill: "Working" while it runs, then "N tool calls".
   Choose it to list the calls, and "Output" on a call to read its output. When files changed,
   "Review all N changed files" opens the "Changes" tab of the sheet with the diff. The sheet's
   tabs are icons; their names show on hover. The "History" tab filters by "Tools". The machine's
   audit log is in Settings, "Elsewhere", "Audit log".
4. **Annotate a plan.** Set the mode chip to "Plan" and ask for a plan for a small change. Open
   the sheet ("Open the sheet" in the composer) and its "Plan preview" tab. A plan arrives either
   from the provider's own plan mechanism or, in Plan mode when the provider sent none, from the
   final reply of the turn. Select words in the plan, or choose "Comment on a step", type a
   comment and choose "Post". Comments are not sent when posted: every open comment goes with the
   next message you send. Send one, and check that the agent's reply addresses the comment.
   "Looks right, carry on" sends that sentence as the next message.

   **Known gap.** Recorded in #746 (merged 2026-10-07): in a Domovoi session, Claude Code 2.1.292
   reported no `TodoWrite` tool and Codex reported `update_plan` unavailable, so neither produced a
   working plan during a turn. The Plan-mode fallback above is the path this step relies on. If
   "Plan preview" still reads "No plan content yet" after a Plan turn ends, record a fail with the
   provider, its CLI version, the mode, and what the thread showed instead.
5. **Approve and deny consequential work.** Ask the agent to run a shell command that writes a
   file, for example `touch walk-gate.txt`. What raises a gate depends on the provider:
   - Claude Code and OpenCode: "Build" with "Auto" off.
   - Codex: "Ask". Codex runs Ask in its read-only sandbox, so a write asks to run outside it. In
     "Build" Codex runs writes inside the worktree in its sandbox without asking.

   The card reads "Waiting on your decision" and lists what the command touches. Choose "Allow
   once"; the receipt reads "Allowed once". Ask for a second command and choose "Deny" (or "Deny
   with a note", then "Deny with this note"); the receipt reads "Denied" or "Denied with a note".
   If no card appears, record the provider, mode and what ran.
6. **Restore a checkpoint.** Open the sheet's "Checkpoints" tab and choose "Take a checkpoint",
   then "Take checkpoint". Let the agent change a file, or change one yourself in the worktree.
   Choose "Revert" on the checkpoint row (the thread's checkpoint row says "Restore worktree"),
   then "Restore worktree" in the dialog "Restore this checkpoint?". The file is back to its
   checkpointed content, and a recovery checkpoint of the state before the restore is listed.
   Restore is refused while a turn runs.
7. **Reopen the session after restart.** Two cases:
   - Quit and reopen the app. With the login service installed, the session is still listed in
     the sessions drawer (the panel icon in the title bar). Without it, quitting stopped the
     daemon; reopening starts it again. Open the session and send a message; the session's
     worktree and history are as they were.
   - Restart the daemon during a turn, with the login service installed. macOS:
     `launchctl kickstart -k gui/$(id -u)/sh.domovoi.domovoid`. Linux:
     `systemctl --user restart domovoid.service`. Do not do this during a checkpoint, restore or
     session creation. The thread shows "Daemon restart interrupted the active turn." and that the
     worktree and session history were preserved. Pending gates expire. Send a message to continue
     ([crash recovery](crash-recovery.md#interrupted-turns)). On Windows, use the sign-out row in
     section 6 instead.

| Step | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| 1 Open a repository | | | |
| 2 Start an agent | | | |
| 3 Review tool activity | | | |
| 4 Annotate a plan | | | |
| 5 Approve and deny | | | |
| 6 Restore a checkpoint | | | |
| 7 Reopen after restart | | | |

## 3. Provider failures

### What to expect

The daemon sorts a provider failure into one of the classes below
(`apps/daemon/src/provider-failures.ts`). All but the last are read from the provider's error
text. The session stays, and the thread shows the class as an alert with an action line and no
button: the action is resending a message, or what the line names.

| Failure | Thread alert | Action line |
| --- | --- | --- |
| Authentication expired | "Provider authentication expired" | "Open Provider settings and sign in again." |
| Rate limit | "Provider rate limit reached" | "Retry the message after the provider cooldown." |
| Quota exhausted | "Provider quota is exhausted" | "Check the provider quota or billing plan, then retry." |
| Context window exceeded | "Turn exceeded the model context window" | "Shorten the turn, or start a new session from a checkpoint." |
| Model unavailable | "Selected model is unavailable" | "Choose another model in the runtime controls, then retry." |
| Connection failed | "Provider connection failed" | "Retry the message after the provider reconnects." |
| Text that matches no class | "Provider request failed" | "Retry the message, or review Provider settings if the failure continues." |
| Approval answered elsewhere (OpenCode only) | "An approval was answered outside Domovoi" | Starts "A program on this machine used the provider server's password to answer an approval". |

When a session has failed and the daemon has let go of its provider thread, the thread shows
"Could not read this session" instead, with the action line, "The worktree and complete session
history remain on this machine." and a "Try again" button that starts the provider again for the
same session.

A provider that is not signed in before a session starts shows "Sign in required" in the
launcher and in Settings, "Providers and tokens", and new sessions on it are refused. An alert
of the wrong class, for example "Provider request failed" for an authentication case, is a fail
of that row: record the provider's own text from the thread.

### Provoke each failure safely

Never sign out of, or edit, the provider sign-in you use for real work. The methods below act on a
copy or on a local stand-in for the provider's server. They were not run while writing this
walk; record what actually happened. **This section changes the profile**: sessions, failed turns
and the removal in step 1 below are written to it.

Providers inherit the environment of the daemon that starts them. The login service reads its
saved configuration, not your shell, so these variables reach a provider only through a daemon
started from the shell that sets them. So:

1. Remove the login service (section 1, step 7) and quit the app.
2. Start the daemon in a terminal with the variables for the case, as below. `domovoid` there
   stands for `~/.local/bin/domovoid`, linked in section 1, step 3, or for the entry point from
   [clean-machine setup](clean-machine-setup.md#step-2-fix-the-commands-you-will-keep-using).
3. Open the app. It attaches to that daemon (Settings reads "Not started here").
4. Before sending, record the worktree: `git -C <repository> worktree list`, then
   `git -C <worktree> status --short` and the content of one changed file.
5. Send a message in a session on that provider, read the alert, and check the worktree again.
6. Stop the daemon with Ctrl-C, start it again without the variables, send another message in the
   same session, and record whether it continues. Delete any scratch copy you made.

The stand-in server answers every request with one HTTP status and an error message, both given
as arguments. Run it in a separate terminal (pick another port if
`lsof -nP -iTCP:48400 -sTCP:LISTEN` shows one in use):

```bash
node -e 'const status=Number(process.argv[1]);const message=process.argv[2];const type={400:"invalid_request_error",401:"authentication_error",404:"not_found_error",429:"rate_limit_error"}[status]??"api_error";require("node:http").createServer((req,res)=>{res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify({type:"error",error:{type,message}}))}).listen(48400,"127.0.0.1",()=>console.log("answering "+status+" on http://127.0.0.1:48400"))' 429 "This request would exceed your rate limit."
```

| Failure | Stand-in arguments |
| --- | --- |
| Authentication expired | `401 "invalid x-api-key"` |
| Rate limit | `429 "This request would exceed your rate limit."` |
| Quota exhausted | `429 "insufficient_quota: You exceeded your current quota."` |
| Context window exceeded | `400 "prompt is too long: 300000 tokens > 200000 maximum"` |
| Model unavailable | `404 "model: not-a-model not found"` |
| Text that matches no class | `500 "Internal server error"` |
| Connection failed | No stand-in: leave the port with nothing listening. |

A CLI may retry several times before it gives up, and it decides what text it passes on, which
may not include the stand-in's message. Record the alert you got.

Point each provider at the stand-in through a daemon started like this:

| Provider | Daemon command |
| --- | --- |
| Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:48400 ANTHROPIC_API_KEY=not-a-key domovoid` |
| Codex | First `cp -R ~/.codex <scratch>/codex-home`, then `printf %s not-a-key \| CODEX_HOME=<scratch>/codex-home codex login --with-api-key`, which changes only the copy. Then `CODEX_HOME=<scratch>/codex-home OPENAI_BASE_URL=http://127.0.0.1:48400/v1 domovoid` |
| OpenCode | First copy `~/.local/share/opencode` to `<scratch>/data/opencode` and `~/.config/opencode` to `<scratch>/config/opencode`, and in the copied config point the provider of the model you use at the stand-in, for example `"provider": {"anthropic": {"options": {"baseURL": "http://127.0.0.1:48400/v1"}}}`. Then `XDG_DATA_HOME=<scratch>/data XDG_CONFIG_HOME=<scratch>/config domovoid` |

`XDG_CONFIG_HOME` also moves where other tools the daemon starts, Git among them, look for
configuration under `~/.config`. A changed `CODEX_HOME` can change what Domovoi's repository trust
reads for Codex; if the repository is held back again, record it.

The approval-answered-elsewhere failure is OpenCode only and cannot be provoked by hand: it needs
a program holding the password Domovoi gives the OpenCode server it starts, so its row stays
blocked. The nearest automated evidence is `apps/daemon/src/opencode.test.ts` ("ends a turn stopped
twice with the approval answered elsewhere"): it simulates the outside answer arriving during a
stop and checks that the turn ends failed. It does not assert the failure kind, show the desktop
alert, or check the worktree.

The stand-in proves Domovoi's handling of a provider's error answers. A real expired sign-in or a
real usage limit can arrive with different text. When one happens in normal use, record the
provider's text and the alert in the notes.

Authentication expired and rate limit are the minimum for each provider. The other rows complete
"every supported provider failure". In each cell record the alert shown, whether the worktree was
intact, and whether the session continued after the restart in step 6.

| Failure | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| Authentication expired | | | |
| Rate limit | | | |
| Quota exhausted | | | |
| Context window exceeded | | | |
| Model unavailable | | | |
| Connection failed | | | |
| Text that matches no class | | | |
| Approval answered elsewhere | not applicable | not applicable | blocked: cannot be provoked by hand |

## 4. Install and recovery docs

Walk each document on a clean machine, as written, and record where the text and the machine
disagree. The documents, not this checklist, hold the commands:

- [Clean-machine setup](clean-machine-setup.md), from Step 1 to Step 8 and its Recovery section.
- [Daemon service configuration](daemon-services.md).
- [Local daemon ownership](local-daemon-ownership.md).
- [Crash recovery](crash-recovery.md). Its interrupted-turn case is section 2, step 7 here.

Route A of Step 1 needs a published release, and none exists yet; walk route B and record route A
as blocked. Step 7 needs a second machine. **Steps 3 to 8 and the Recovery section change the
profile**: Steps 3 and 4 start a daemon, which writes its credential, leases, owner record and
logs, Step 7 stores the peer's credential in the source machine's keychain and
adds a device on the target, and Step 8 creates a separate profile inside the WSL distribution.
Step 5 also changes the OS.

### macOS

| Document and section | Date | Build sha | Result | Notes |
| --- | --- | --- | --- | --- |
| Clean-machine setup, Steps 1 to 3 | | | | |
| Clean-machine setup, Step 4 | | | | |
| Clean-machine setup, Step 5 | | | | |
| Clean-machine setup, Step 6 | | | | |
| Clean-machine setup, Step 7 | | | | |
| Clean-machine setup, Recovery | | | | |
| Daemon service configuration | | | | |
| Local daemon ownership | | | | |

### Linux

| Document and section | Date | Build sha | Result | Notes |
| --- | --- | --- | --- | --- |
| Clean-machine setup, Steps 1 to 3 | | | | |
| Clean-machine setup, Step 4 | | | | |
| Clean-machine setup, Step 5, including lingering | | | | |
| Clean-machine setup, Step 6 | | | | |
| Clean-machine setup, Step 7 | | | | |
| Clean-machine setup, Recovery | | | | |
| Daemon service configuration | | | | |
| Local daemon ownership | | | | |

### Windows

| Document and section | Date | Build sha | Result | Notes |
| --- | --- | --- | --- | --- |
| Clean-machine setup, Steps 1 to 3 | | | | |
| Clean-machine setup, Step 4 | | | | |
| Clean-machine setup, Step 5 | | | | |
| Clean-machine setup, Step 6 | | | | |
| Clean-machine setup, Step 7 | | | | |
| Clean-machine setup, Step 8, Windows and WSL | | | | |
| Clean-machine setup, Recovery | | | | |
| Daemon service configuration, Windows logon task and removal | | | | |
| Local daemon ownership | | | | |

## 5. Phone over the tailnet

`S3.0` answered yes on 2026-09-16 against a daemon built from `4ddf93f5`. This section repeats it
on the build under test. Nothing is pushed to a phone yet: gates reach it only while Domovoi is
open on it, and the phone says so.

1. **Install the phone app.** **Changes the phone.** There is no store or hosted build. Build a
   development build from this repository on a computer with Xcode or the Android SDK, as
   [the mobile README](../apps/mobile/README.md) describes (`npx expo run:ios --device` or
   `npx expo run:android`). A real iPhone needs Developer Mode and a signing team.
2. **Let the phone reach the daemon.** **Changes the profile.** In the desktop app, Settings, turn
   on "Reach this machine from my tailnet". It asks Tailscale for a certificate for this machine's
   tailnet name, stores it in the Domovoi profile and restarts the daemon once, the login service
   or the daemon inside the app, so it answers on the tailnet. A daemon started by
   hand uses the variables in
   [clean-machine setup, Step 4](clean-machine-setup.md#step-4-reach-the-daemon-from-another-machine)
   instead.
3. **Pair.** **Changes the profile.** In Settings, "Phone and tablet", choose "Phone", then "Show a
   pairing code". From a terminal, `domovoid pair --client phone` prints the same kind of code, as
   a symbol to scan and a line to paste; issuing it ends any code still open, including the one
   Settings shows. `--label "<name>"` is optional and is kept only as a suggested name; the
   phone's own name is the one used. On the phone,
   under "Pair this phone", choose "Scan a code" (or "Type it" and paste the line), name the
   phone, and choose "Pair with this machine". Expect "Paired with <machine>", then "Open
   Sessions". The code lasts three minutes and works once.
4. **Watch a terminal (design frame 04).** Not built on the phone at `640ac4e7`: the phone lists a
   terminal with a note that it is watched on the desktop, and the pairing grant says "Terminal
   output is not on a phone yet." Record this row as blocked, with "not built" in the notes, unless
   the build under test includes a phone terminal view; then record pass or fail and what it
   showed.
5. **Answer a gate.** **Changes the profile**: each answer is an approval receipt. Start a turn
   on the desktop that raises a gate (section 2, step 5). On the phone, Sessions lists it under
   "NEEDS YOU"; open it to "Waiting on you" and choose "Allow once".
   The desktop receipt reads "decided from" followed by the phone's name and client. Raise a
   second gate and choose "Deny" on the phone, then "Deny without explanation", or type a reason
   and choose "Send denial". Check the desktop receipt and that the agent was told it was denied.

| Step | Date | Build sha | Phone, OS and network | Result | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 Install the phone app | | | | | |
| 2 Reach over the tailnet | | | | | |
| 3 Pair | | | | | |
| 4 Watch a terminal | | | | | |
| 5 Answer a gate | | | | | |

## 6. Service lifecycle on hardware

The Windows sign-out, Windows reboot, Linux logout and Linux reboot runs are listed, with their
own record table, in the
[service lifecycle assessment](service-lifecycle-assessment.md#real-hardware-acceptance-checklist-2026-10-06).
Record them there, not here.

## Not covered here

The other M1 bullets are proven elsewhere: Phase 1 completion by the ticks in
[SHIP-PLAN.md](../SHIP-PLAN.md), and the rule that no surface claims a hosted relay, push
notifications or accounts by review of the product copy. This walk does not test signing,
notarization or self-update, which are M2 preconditions.
