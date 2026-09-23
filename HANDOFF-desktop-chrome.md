# Handoff: Domovoi desktop chrome rebuild (v2)

Written for the next agent taking over. This work is committed on `feat/v2-client-parity`
(first commit `33c937f3`, 2026-09-20). On 2026-09-22 fetzy approved pushing the branch and
opening one PR for it as part of the audit fix program.

## 1. Standing rules you inherit

These come from fetzy and from the design author. They are not suggestions.

- Never commit, push, branch, or open a PR unless asked.
- Never add AI or session attribution to commits or PRs.
- Never edit the signed design files under `design/` by hand. Correct upstream, read back,
  re-vendor, regenerate, in that order.
- Never delete, skip, weaken, or expectation-flip a test to get green. Changing an expectation
  is allowed only when the design defines the new string or shape, and you must say so out loud.
- Enumerate before deleting. Diff before overwriting. If you cannot list the target exactly, stop.
- Never kill or restart a process you did not start. Inspect first.
- Build each region from the design, not from the current component. Open the design first.
  Use existing code only for wiring: which RPC a control calls, which prop carries its state.
- Where the design is silent, bring the gap rather than invent.
- Where something cannot be built, leave it absent and record the reason.
- Where the app draws something the design does not, ask before keeping it.
- Where design and protocol contradict a third time, stop and ask.
- Delivery is one branch fetzy watches, then one PR. Not eight slices.

## 2. The design is the source of truth

Vendored file, 312,200 bytes:

```
design/design_handoff_domovoi_v2/designs/Domovoi Desktop V2.dc.html
```

Read it directly. The composer region is around lines 820 to 1100; its string table is around
lines 3500 to 3650.

The live project is `a3b4404e-4d0c-451e-8dd2-203116a76c06` in DesignSync. `get_file` caps at
256 KiB, so the live root cannot be fetched in one call. fetzy's design agent exports it as two
parts (`part1-template.html` 168,886 bytes, `part2-logic.html` 143,314 bytes) which are rejoined
before writing. Do not vendor a truncated file. A short read reports nothing about completeness.

### Conformance gate

`docs/design-conformance/desktop-v2.json` is tied to the design file's sha256. Re-vendoring turns
it red until entries are re-derived. Run it with:

```
cd /Users/fetzy/projects/domovoi && node scripts/design-conformance.mjs
```

Current state: 30 built, 41 partial, 9 missing, 2 blocked.

The gate holds digests, literal strings, and per-element evidence, including "absent from this
file". It cannot hold arrangement, state appearance, behaviour, or intent. Do not try to make it.

## 3. The dev loop (already built, use it)

The source was re-checked on 2026-09-19. Runtime output was not re-run because the existing loop
belongs to fetzy, so runtime state is unverified in this documentation pass. Quoted loop lines below
come from the source and its tests. One entry-point bug was found and left unfixed: the root package
does not define `dev:fixture`. Running the requested command from the repository root produced:

```
[ERR_PNPM_NO_SCRIPT] Missing script: dev:fixture

Command "dev:fixture" not found. Did you mean "pnpm run dev:desktop:fixture"?
```

### 1. Start it

From the repository root, the working command defined by `package.json` is:

```
pnpm dev:desktop:fixture
```

It builds the protocol and daemon packages, starts the fixture daemon in the wrapper process, then
spawns `npx electron-vite dev --watch`. Electron opens the real desktop window against that fixture.
Do not use `pnpm dev:fixture` from the root unless the missing root alias is fixed first.

### 2. Reload and relaunch behavior

The reporter watches non-test files in `packages/ui/src`, `apps/desktop/src/renderer`, and
`apps/desktop/src/dev` as renderer changes. A renderer update normally keeps the window and prints:

```
[loop] renderer updated: <repo-relative-path>. Fixture state kept.
```

If Vite cannot apply Fast Refresh, the same save prints that line and then this second line:

```
[loop] Fast Refresh could not apply <repo-relative-path>, so the renderer reloaded and the window state is gone. Fixture state kept.
```

The reporter watches non-test files in `apps/desktop/src/main` and `apps/desktop/src/preload` as
main-side changes. A save prints:

```
[loop] main or preload edit: <repo-relative-path>. The window relaunches now; watch for the boot line below.
```

After Electron relaunches, the main process prints:

```
[loop] window relaunched (main or preload edit, boot <n>). Fixture state kept.
```

The initial window instead prints:

```
[loop] window started against the fixture daemon. Renderer edits apply in place; main and preload edits relaunch this window.
```

Correction: the previous claim that every watched save prints exactly one line was wrong. A renderer
full reload prints two lines, and a main or preload save prints the change line followed by the boot
line from the relaunched process.

### 3. Fake daemon and RPC methods

`apps/desktop/scripts/dev-fixture-daemon.mjs` is an in-memory fixture server running in the dev-loop
wrapper, separate from the Electron child process. It listens on a real loopback WebSocket at `/rpc`
and exchanges the real JSON-RPC request and response shapes. It looks up each method in
`rpcMethods`, validates that method's params and result with the protocol schemas, rejects unknown
methods, and rejects methods that have no fixture handler.

Correction: the previous claim that it validates every frame with `rpcRequestSchema` was wrong. The
source parses JSON, checks the request fields itself, then validates method params and results through
`rpcMethods`; it does not import or call `rpcRequestSchema`.

Current handlers, named directly from `dev-fixture-daemon.mjs`:

- `system.hello`
- `workspace.get`
- `fleet.list`
- `session.activate`
- `session.send`
- `project.open`
- `usage.window`
- `session.usage`
- `skill.list`
- `runtime.models`

`session.send` does not mutate the fixture snapshot. It returns the current snapshot and prints:

```
[fixture] accepted session.send for ${params.sessionId}. No agent runs here, so no reply streams back.
```

### 4. State lifetime

The fixture process owns one in-memory clone of `demoWorkspace` and one connection ID. That state
survives renderer Fast Refresh, a full renderer reload, and an Electron main or preload relaunch
because those events do not stop the wrapper process. Of the current handlers, `session.activate`
is the one that mutates the snapshot, by changing `activeSessionId`; that selection survives those
reloads and relaunches. `session.send` only prints the prompt and returns acceptance.

Renderer-local state can survive an in-place Fast Refresh, but it is gone after Vite performs a full
renderer reload and after the Electron window relaunches. The boot counter also survives Electron
relaunches in the wrapper's temporary directory. Stopping the wrapper closes the fixture and removes
that directory, so fixture state, connection ID, and boot count do not survive a complete loop
restart. The loop does not read or write `~/.domovoi`.

### 5. Dev-only seam

`apps/desktop/src/main/dev-fixture-seam.ts` refuses the fixture path item by item:

- a packaged build, before reading the environment variable;
- a missing `DOMOVOI_DEV_FIXTURE_URL`, by declining the fixture path;
- a malformed URL;
- every protocol except exact `ws:`, including `http:`, `https:`, and `wss:`;
- any URL with a username or password;
- every hostname except exact `127.0.0.1` or `localhost`, including other loopback spellings and
  remote hosts.

When the fixture seam is accepted, the window skips the single-instance lock. All other paths use the
real daemon acquisition and still require the lock.

### 6. Restart a wedged loop

The reported current location is herdr pane `w13:p8` on this machine; it was not rechecked in this
pass. In that pane, interrupt the foreground command rather than killing only the wrapper process.
The wrapper forwards `SIGINT` or `SIGTERM` to the Electron process group, closes the fixture after
Electron exits, and removes its temporary state directory. Killing only the wrapper can leave an
Electron window holding the single-instance lock. After the old process group exits, restart from the
repository root with:

```
pnpm dev:desktop:fixture
```

The requested root command `pnpm dev:fixture` cannot restart it in the current source because the
root alias is missing. That is the unfixed entry-point bug reported above.

### 7. What terminal output and screenshots cannot prove

The loop cannot show whether a control inherited `-webkit-app-region: drag` and silently stopped
responding, or whether a popover opened underneath the composer's fade at `z-index: 1`. Both require
a click in the real Electron window. A screenshot is not sufficient.

## 4. What is done

Titlebar, dock, sheet and prompt editor are built and verified by fetzy clicking them.

- Titlebar drags from anywhere. `electron-no-drag` sits on each control, not on the wrapper.
  `packages/ui/src/app-bar-drag.dom.test.tsx` walks every control on darwin, win32 and linux.
- Dock tab row rebuilt from the design: 28px icon squares, `gap-[5px]`, `px-[13px] py-[11px]`,
  `flex-none` on triggers. Labels and counts are not drawn; they appear in a 210px tooltip 7px
  below. Definitions live in `packages/ui/src/dock-tabs.ts` so the rail and the row cannot drift.
- `DockRail` and `workspace-rail.tsx` deleted, per an explicit ruling. Recorded in the conformance
  file as drawn-but-undesigned.
- The sheet's pin moved into the dock tab row. X closes the sheet. Sheet defaults to closed.
- Prompt editor rebuilt in place in `packages/ui/src/prompt-editor.tsx`: 980x660, header with
  title, `project · worktree` in mono faint, segmented `Aa`/`MD`, close. Field on `--code` with a
  primary border and ring. Insert chips left, draft state right. Footer band with three
  display-only chips that read the composer's own values. No think chip. `⌘⇧E` opens it.
- `packages/ui/src/session-composer.tsx` and its test deleted: 408 lines of dead code.

### Composer, this session

Verified by fetzy clicking in the dev loop: Enter sends, Shift+Enter makes a new line, the hint
renders, `⌘⇧E` opens the editor, `MD`/`Aa` swaps both chips and placeholder, Escape and the scrim
both close, and the model, mode and usage popovers all open above the composer and are clickable.

- Card: 760px, `--card`, 1px border, 16px radius, padding `13px 15px 11px`, gap 11px, overlapping
  the scroller by 20px with the design's fade.
- Field: 13.5px at 1.6, grows to a 172px cap then scrolls. **Trap:** shadcn's `Textarea` carries
  `dark:bg-input/30`, and a dark variant beats a plain `bg-transparent`. It must be turned off by
  name or the field paints a panel the design never draws.
- Placeholders: `Steer it while it works` mid-turn, `Reply, or steer the plan` at rest,
  `Cannot send, the daemon is not answering` offline.
- Send hint: `↵ to send · ⇧↵ for a new line`, Windows and Linux wording in `composer-keys.ts`.
  The design defines this string in data and renders it nowhere. That is a drawing bug, and a
  changed send key with no on-screen hint is a trap, so it is rendered on purpose.
- Queued row uses the design's strings: `queued, sends when this turn ends`, or `queued` at rest,
  with an x to unqueue.
- Stop is a 28px round bordered icon control beside send, as the design draws it at line 1043.
  Clicking it during a waiting gate is the design's approval-jump.
- `Archive session` removed from the composer. The sessions drawer archives on its own
  (`workspace-shell.tsx:523`).
- Watching-only notice copy now matches the design (`session-recovery.ts:114`).
- Slash panel is built in `thread.tsx` from the design at lines 835 to 854 and 3345 to 3399.
  The 28px round `/` control and typed `/` both open it; the visible input becomes the query plus
  blinking caret; all six rows stay present while prefix matches take primary colour and the rest
  dim to 50%. It closes offline, on Escape, on an outside click, and when another menu opens.
  Choosing a row inserts its command name plus a trailing space into the existing message field.
  `composer-slash.dom.test.tsx` covers both entry paths, the six rows, matching, selection, menu
  closure and offline closure. fetzy selected and sent `/replan` in the real window; the fixture log
  printed its accepted `session.send`. No command action or reply appears in this loop because the
  fixture deliberately runs no agent. Panel stacking and dimming still need explicit visual confirmation.

### Already correct, do not rebuild

Three items the brief asked for were already built. Verified, not assumed:

- Usage chip renders once, in the composer (`thread.tsx:1312`). The app bar holds only the data
  hook. There is no duplication left to remove.
- Model chip already reads `claude-code · sonnet 4.6` with the vendor prefix stripped by
  `modelDisplayName` (`packages/protocol/src/model-display.test.ts:10`). Search, harness filters
  and a 268px capped list are present. A harness that did not report is filtered out at
  `model-popover.tsx:84`, not greyed.

## 5. What is left

In rough order.

1. **Undesigned controls: mostly done, two gaps left.** fetzy ruled that the re-vendored design
   decides, so each was settled by searching the design file, not by opinion.
   - `ThinkChip`: **removed.** The design file contains no `think` string anywhere. Its catalog
     fetch, `reasoningCatalog`, `catalogAttempt` and the `ReasoningCatalog` import went with it,
     since nothing else read them. **Capability lost:** there is now no way to set reasoning
     effort. The design draws none, so this is the design's answer, not an oversight.
   - `Checkpoint` button: **removed.** The design draws no checkpoint control in the composer.
     The `/revert` picker now inserts that command and the Checkpoints sheet tab lists existing
     checkpoints, but there is still no manual checkpoint creation. `onCheckpoint` stays on
     Thread's prop type so callers still compile; nothing reads it.
   - `MachineSwitcher`: **kept, trigger hidden.** The design draws no machine chip in the
     composer, but the sessions drawer's `move` opens this exact menu through `openRequest`
     (`workspace-shell.tsx:536`), and `machine-switcher.tsx:122` captures that value in a ref
     **on mount**. Mounting it conditionally therefore breaks `move` silently. It is wrapped in
     `sr-only` so the menu still anchors and opens. Giving `move` its own dialog is the real fix.
   - `ComposerSkillChip`: **still kept.** The `/skill` picker now inserts `/skill ` into the
     message field, but it does not populate the protocol's `TurnSkillSelection`. Removing the chip
     still drops the five tested behaviours: a per-turn skill choice surviving a remount, a held
     choice for a skill no longer enabled, an explicit empty choice, and waiting for a pending
     catalog. Do not remove it until that protocol wiring has a design-defined replacement.
   - The `<provider> not ready` badge: **kept.** The design is silent on it, and it reports a
     real blocked state. Recorded as a gap rather than invented away.
2. **Watching-only arrangement.** The copy matches, the arrangement does not. The design insets
   the notice *inside* the composer card with the controls locked at 45% opacity. The app instead
   replaces the whole composer with `SessionReadOnlyNotice` (`thread.tsx:403`, rendered at
   `thread.tsx:1052`) and offers a release action the design never draws. Reconciling these is a real
   refactor with tests pinned to current behaviour.
3. **Provider failure alerts** (`thread.tsx:959`) are drawn but not designed. Ask
   before keeping or removing.

### Known gaps, already recorded

- The desktop composer has no attachment control yet. `session.send` already accepts up to two
  attachments: images, text files and worktree file paths (`docs/session-image-attachments.md`).
- The design's second watching reason, `Free plan: this route carries reads only.`, names a plan,
  and plans are Phase 5. `33c937f3` rendered it for watching-only credentials; on 2026-09-22 it was
  replaced with "This device was paired to watch only." and `composer.watching-note` is blocked
  on the design.
- The design has no drawing for the release action the app offers on an archived session.

## 6. Traps that already cost time

- An unregistered Tailwind utility silently emits nothing. Verify colour utilities resolve against
  the real sheet; there is a test for this from commit `6d568375`.
- `--shadow-lg` and `--shadow-xl` mean a colour in the design and a complete shadow in the repo.
  Copying the design's declaration emits invalid CSS and renders nothing.
- shadcn's `TabsTrigger` ships `flex-1`. That was the dock tab stretch.
- `TooltipContent` hardcodes `bg-foreground` and always renders an arrow. There is now a
  `showArrow` opt-out rather than a rewritten primitive.
- A dark variant beats a plain utility. See the `Textarea` note above.
- Electron sometimes fails with `Error: Electron uninstall` on a warm cache. The cause is a missing
  unpack, not a cold CDN.
- herdr's `wait-output` searches the existing snapshot first, so a match can be stale. Always pass
  `--timeout`.

## 7. Checks before you hand anything back

```
cd /Users/fetzy/projects/domovoi
pnpm typecheck
pnpm lint
cd packages/ui && npx vitest run --reporter=dot
```

Last observed, after the slash-panel edit: UI 167 files, 1183 pass, 1 skipped, 0 fail.
`pnpm typecheck` 0 errors. `pnpm lint` 0 errors.

Verify in the dev loop by clicking, not by reading the diff and not by screenshot alone. Two
failure modes a screenshot cannot show: a control that inherited `-webkit-app-region: drag`
silently stops responding, and a popover that opens under the fade's `z-index: 1` looks fine
until you try to use it.

## 8. One thing you cannot do

Clicking the live window through the computer-use tools does not work on this machine. Both
macOS Accessibility and Screen Recording are granted to Claude and the tool still reports them
missing. Six attempts failed. fetzy clicks and reports back; that path works and is faster than
debugging it.

## 9. Open questions for fetzy

Answered on 2026-09-19: the re-vendored design handoffs decide, so questions about what the
composer draws are settled by reading the design rather than by asking. See section 5, item 2.

Still open, because the design cannot answer them:

1. Reasoning effort now has no control at all. **Answered 2026-09-22:** give it a home, as a
   group in the v2 model menu (audit J33). It waits for the design; keep `ThinkChip` and
   `ReasoningCatalog` until then.
2. Manual checkpoint creation is gone until `/revert` exists. **Answered 2026-09-22:** the
   daemon will take a checkpoint before each approved write (audit J34), and the command palette
   now has "Take a checkpoint" for a manual one.
3. Provider failure alerts in the thread (`thread.tsx` around line 900) are drawn but not
   designed. Keep or remove?
