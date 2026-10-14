import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useLayoutEffect, useRef, useState } from "react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { demoWorkspace } from "@getdomovoi/protocol"

import { AppBar } from "./app-bar"
import { DaemonLostBanner } from "./connection-status"
import { SessionsDrawerColumn } from "./sessions-drawer"
import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake,
  installFakeWebSocket,
  notify,
  pendingRequest,
  respond,
  sentRequests,
  workspaceSnapshot,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

// A tab narrower than 640 px (Tailwind's sm, 40rem), such as a phone at 390
// or 360 px. jsdom lays nothing out, so the width rules are read from the
// classes that carry them; the browser check in the pull request measures the
// boxes. The sessions drawer follows the same breakpoint through matchMedia,
// stubbed below.

let harness: FakeWebSocketHarness

beforeEach(() => {
  try {
    localStorage.removeItem(workspaceUiStorageKey)
  } catch {
    // A browser without storage starts from the default layout anyway.
  }
  harness = installFakeWebSocket()
})

afterEach(() => {
  cleanup()
  harness.uninstall()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

const classes = (element: Element | null | undefined) => (element?.getAttribute("class") ?? "").split(/\s+/)

async function openShell() {
  const snapshot = workspaceSnapshot()
  render(<WorkspaceShell />)
  const socket = harness.socket(0)
  await act(async () => { completeHandshake(socket, snapshot) })
  await settle()
  return { snapshot, socket }
}

function appBar({ connected, clientAccess }: { connected: boolean; clientAccess?: "watching" }) {
  return render(
    <AppBar
      snapshot={demoWorkspace}
      connected={connected}
      {...(clientAccess ? { clientAccess } : {})}
      emergencyStopPending={false}
      emergencyStopOutcome={null}
      emergencyStopError={null}
      onNewSession={vi.fn()}
      onOpenMachines={vi.fn()}
      onOpenSettings={vi.fn()}
      onPauseAll={vi.fn()}
      onEmergencyStop={vi.fn()}
      onOpenCommands={vi.fn()}
      onToggleTheme={vi.fn()}
      commandShortcut="⌘K"
    />,
  )
}

it("lets the thread and dock row, and Machines, shrink to the tab instead of their content's width", async () => {
  const user = userEvent.setup()
  await openShell()
  // A row flex item defaults to min-width auto, so without min-w-0 the thread
  // column took its content's width (562 px at 390) and the shell clipped it,
  // the approval card with it.
  const group = document.querySelector("[data-slot=resizable-panel-group]")
  expect(classes(group?.parentElement)).toContain("min-w-0")

  await user.click(screen.getByRole("button", { name: /^Machines:/ }))
  // Machines loads on demand.
  const machines = await screen.findByRole("heading", { name: "Machines", level: 1 }, { timeout: 5000 })
  await settle()
  expect(classes(machines.closest("[data-slot=scroll-area]")?.parentElement)).toContain("min-w-0")
  // The devices table may be wider than a phone; it scrolls in its own box,
  // which adds nothing to the page's width.
  const tables = screen.getAllByRole("table")
  expect(tables.length).toBeGreaterThan(0)
  for (const table of tables) {
    expect(classes(table.parentElement)).toEqual(expect.arrayContaining(["w-0", "min-w-full", "overflow-x-auto"]))
  }
})

it("collapses the app bar below 640 px: tighter spacing, the route word and theme toggle fold away", async () => {
  await openShell()
  const header = document.querySelector("header")
  expect(classes(header)).toEqual(expect.arrayContaining(["max-sm:gap-1", "max-sm:px-2"]))
  // The theme stays one tap away in Settings, Appearance.
  expect(classes(screen.getByRole("button", { name: /^Use (dark|light) theme$/ }))).toContain("max-sm:hidden")
  // The machine chip may shrink; its name truncates, and the route word folds
  // while connected (Machines names it).
  const chip = screen.getByRole("button", { name: /^Machines:/ })
  expect(classes(chip)).toContain("max-sm:shrink")
  const search = screen.getByRole("button", { name: "Open command palette" })
  expect(classes(search.querySelector("kbd"))).toContain("max-sm:hidden")
})

// At 360 px a watching tab whose daemon is unreachable ran the machine chip
// under Stop. Below 640 px a watching bar drops the two controls a watching tab
// cannot use, so watching only and unreachable both keep room.
it("below 640 px a watching bar folds New session and Stop, and keeps watching only and unreachable", () => {
  appBar({ connected: false, clientAccess: "watching" })
  expect(classes(screen.getByRole("button", { name: "New session" }))).toContain("max-sm:hidden")
  expect(classes(screen.getByRole("button", { name: "Stop everything" }).parentElement)).toContain("max-sm:hidden")
  expect(classes(screen.getByText("watching only"))).not.toContain("max-sm:hidden")
  expect(classes(screen.getByText("unreachable"))).not.toContain("max-sm:hidden")
})

it("below 640 px a full-access bar keeps New session and Stop", () => {
  appBar({ connected: true })
  expect(classes(screen.getByRole("button", { name: "New session" }))).not.toContain("max-sm:hidden")
  expect(classes(screen.getByRole("button", { name: "Stop everything" }).parentElement)).not.toContain("max-sm:hidden")
})

// At 390 px the lost banner's words wrapped one per line beside its buttons,
// 327 px tall. Below 640 px the words keep most of the line.
it("below 640 px the lost banner keeps its words on most of the line", () => {
  render(
    <DaemonLostBanner
      connected={false}
      reconnecting
      authenticationRequired={null}
      protocolError={null}
      connectionError=""
      machineName="macbook-pro-m3"
      onReconnect={vi.fn()}
    />,
  )
  const words = screen.getByText("Lost the daemon on macbook-pro-m3").closest("span.flex")
  expect(classes(words)).toContain("max-sm:min-w-[60%]")
  // A copy covered by the narrow sessions drawer (inert) hides; the shell
  // draws the banner above the row then.
  expect(classes(screen.getByRole("status"))).toContain("inert:hidden")
})

// The sessions drawer below 640 px. Beside the 268 px column a phone's thread
// kept about 120 px, so there the open column covers the thread instead of
// pushing it. Whatever it covers is inert, so no focus, Tab, key press or tap
// reaches a covered approval card while the column hides its facts.

const narrowQuery = "(width < 40rem)"

// Returns a resize: it changes the answer and tells the listeners, as a
// browser does when the tab crosses the breakpoint. With tell false it only
// changes the answer: a browser applies a new viewport at once but reports
// the media change at its next rendering step, and an input event can come
// between the two.
function stubWidth(narrow: boolean) {
  const listeners = new Set<() => void>()
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    get matches() { return query === narrowQuery ? narrow : false },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: () => void) => { if (query === narrowQuery) listeners.add(listener) },
    removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener) },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })))
  return (next: boolean, tell = true) => {
    narrow = next
    if (tell) for (const listener of listeners) listener()
  }
}

// The rest of the drawer's row: the surface it covers in a narrow tab.
function besideDrawer(): Element[] {
  const drawer = document.getElementById("sessions-drawer")
  const row = drawer?.parentElement
  if (!drawer || !row) return []
  return [...row.children].filter((child) => child !== drawer && !child.hasAttribute("data-sessions-backdrop"))
}

const sessionsButton = () => screen.getByRole("button", { name: /^(Sessions|Hide sessions) \d/ })
const allowOnce = () => screen.getByRole("button", { name: /^Allow once/ })

// Runs a step outside act, as a browser runs it: act would flush every
// pending effect first and hide a window a key press can hit.
async function outsideAct(step: () => Promise<void>) {
  const reactGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined }
  const actEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = false
  try {
    await step()
  } finally {
    reactGlobal.IS_REACT_ACT_ENVIRONMENT = actEnvironment
  }
  await settle()
}

it("below 640 px the open drawer covers the thread, and the covered thread is inert", async () => {
  stubWidth(true)
  const user = userEvent.setup()
  await openShell()
  expect(allowOnce().closest("[inert]")).toBeNull()
  await user.click(sessionsButton())
  const drawer = screen.getByRole("complementary", { name: "Sessions" })
  expect(classes(drawer)).toEqual(expect.arrayContaining(["absolute", "inset-y-0", "left-0"]))
  // The row is the overlay's anchor, below the app bar.
  expect(classes(drawer.parentElement)).toContain("max-sm:relative")
  const covered = besideDrawer()
  expect(covered.length).toBeGreaterThan(0)
  for (const element of covered) expect(element.hasAttribute("inert")).toBe(true)
  expect(allowOnce().closest("[inert]")).not.toBeNull()
  expect(drawer.closest("[inert]")).toBeNull()
  // The waiting approval stays in view: its session heads the drawer's NEEDS
  // YOU group.
  expect(screen.getByRole("region", { name: "NEEDS YOU" })).toBeTruthy()
})

it("below 640 px Escape, a tap on the uncovered strip, or choosing a session closes the drawer and returns focus to Sessions", async () => {
  stubWidth(true)
  const user = userEvent.setup()
  const { snapshot, socket } = await openShell()

  await user.click(sessionsButton())
  screen.getByRole("complementary", { name: "Sessions" }).querySelector("button")!.focus()
  await user.keyboard("{Escape}")
  expect(document.getElementById("sessions-drawer")).toBeNull()
  expect(document.activeElement).toBe(sessionsButton())
  expect(sessionsButton().getAttribute("aria-expanded")).toBe("false")
  expect(allowOnce().closest("[inert]")).toBeNull()

  await user.click(sessionsButton())
  const backdrop = document.querySelector("[data-sessions-backdrop]")
  expect(backdrop).toBeTruthy()
  // Above the thread's own raised controls (z-10, such as its follow button)
  // and the unpinned dock sheet (z-40); the column, drawn after it at the same
  // level, stays on top.
  expect(classes(backdrop)).toContain("z-50")
  expect(classes(screen.getByRole("complementary", { name: "Sessions" }))).toContain("z-50")
  expect(backdrop?.closest("[inert]")).toBeNull()
  await user.click(backdrop as HTMLElement)
  expect(document.getElementById("sessions-drawer")).toBeNull()
  expect(document.activeElement).toBe(sessionsButton())

  await user.click(sessionsButton())
  const other = snapshot.sessions.find((session) => session.id !== snapshot.activeSessionId)!
  await user.click(screen.getByRole("button", { name: new RegExp(`^${other.title.slice(0, 24)}`) }))
  expect(document.getElementById("sessions-drawer")).toBeNull()
  expect(document.activeElement).toBe(sessionsButton())
  expect(pendingRequest(socket, "session.activate").params).toMatchObject({ sessionId: other.id })
  await act(async () => { respond(socket, "session.activate", workspaceSnapshot({ activeSessionId: other.id })) })
  await settle()
})

// The path that beat close-on-event three times: Allow once focused in a wide
// tab with the drawer open, then the tab narrows. The commit that turns the
// column into a cover also makes the thread inert and moves focus out of it,
// so the first key press after the resize cannot approve.
it("narrowing past 640 px with Allow once focused makes the thread inert and moves focus out in the same commit", async () => {
  const resize = stubWidth(false)
  const user = userEvent.setup()
  const { socket } = await openShell()
  await user.click(sessionsButton())
  const allow = allowOnce()
  act(() => { allow.focus() })
  expect(document.activeElement).toBe(allow)

  await outsideAct(async () => {
    resize(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(document.getElementById("sessions-drawer")).not.toBeNull()
    expect(allow.closest("[inert]")).not.toBeNull()
    expect(document.activeElement).toBe(sessionsButton())
    await user.keyboard(" ")
    await user.keyboard("{Enter}")
  })
  expect(sentRequests(socket, "approval.resolve")).toHaveLength(0)
})

// Found in Chromium: Playwright narrowed the viewport and pressed Space at
// once, and the key reached Allow once before the browser reported the media
// change, so before React drew the cover. Below the breakpoint the open
// column refuses input aimed behind it even before the change arrives.
it("a key or click aimed behind the open drawer after the tab narrows, before the media change arrives, does nothing", async () => {
  const resize = stubWidth(false)
  const user = userEvent.setup()
  const { socket } = await openShell()
  await user.click(sessionsButton())
  const allow = allowOnce()
  act(() => { allow.focus() })

  resize(true, false)
  await user.keyboard(" ")
  expect(sentRequests(socket, "approval.resolve")).toHaveLength(0)
  // The refused key also takes focus out from behind the column.
  expect(document.activeElement).toBe(sessionsButton())
  act(() => { allow.focus() })
  await user.keyboard("{Enter}")
  await user.click(allow)
  expect(sentRequests(socket, "approval.resolve")).toHaveLength(0)
  expect(document.getElementById("sessions-drawer")).not.toBeNull()

  act(() => { resize(true) })
  expect(allow.closest("[inert]")).not.toBeNull()
  expect(document.activeElement).toBe(sessionsButton())
})

// Pull request review: in the same gap, Escape aimed behind the drawer was
// refused with the rest and the drawer stayed open. It closes the drawer.
it("Escape aimed behind the open drawer after the tab narrows, before the media change arrives, closes the drawer", async () => {
  const resize = stubWidth(false)
  const user = userEvent.setup()
  const { socket } = await openShell()
  await user.click(sessionsButton())
  act(() => { allowOnce().focus() })

  resize(true, false)
  await user.keyboard("{Escape}")
  expect(document.getElementById("sessions-drawer")).toBeNull()
  expect(document.activeElement).toBe(sessionsButton())
  expect(sentRequests(socket, "approval.resolve")).toHaveLength(0)
  act(() => { resize(true) })
  expect(document.getElementById("sessions-drawer")).toBeNull()
  expect(allowOnce().closest("[inert]")).toBeNull()
})

// Pull request review: the same gap with focus inside the drawer. Escape
// there was ignored until React drew the cover; it closes the drawer too.
it("Escape from inside the drawer after the tab narrows, before the media change arrives, closes it", async () => {
  const resize = stubWidth(false)
  const user = userEvent.setup()
  await openShell()
  await user.click(sessionsButton())
  act(() => { document.getElementById("sessions-drawer")!.querySelector("button")!.focus() })

  resize(true, false)
  await user.keyboard("{Escape}")
  expect(document.getElementById("sessions-drawer")).toBeNull()
  expect(document.activeElement).toBe(sessionsButton())
  act(() => { resize(true) })
})

// Pull request review: the drawer's machine count opens Machines, which the
// drawer then covered. Below 640 px it closes the drawer on the way.
it("below 640 px the drawer's machine count opens Machines uncovered", async () => {
  stubWidth(true)
  const user = userEvent.setup()
  await openShell()
  await user.click(sessionsButton())
  await user.click(screen.getByRole("button", { name: /machine · \d+ unreachable/ }))
  expect(document.getElementById("sessions-drawer")).toBeNull()
  const machines = await screen.findByRole("heading", { name: "Machines", level: 1 }, { timeout: 5000 })
  expect(machines.closest("[inert]")).toBeNull()
  await settle()
})

it("the drawer refuses nothing at 640 px and wider: Allow once beside the open column still approves", async () => {
  stubWidth(false)
  const user = userEvent.setup()
  const { socket } = await openShell()
  await user.click(sessionsButton())
  await user.click(allowOnce())
  expect(sentRequests(socket, "approval.resolve")).toHaveLength(1)
})

// The lost banner sits at the top of the thread column. In Chromium at 390 px,
// painted above a covering drawer, it hid the drawer's NEEDS YOU group, and
// inert with the thread its buttons did nothing. While the drawer covers the
// thread the shell draws it across the window above the row instead, as on
// surfaces without a thread column, and the thread's copy hides while inert.
const lostBanners = () => screen.queryAllByRole("status", { hidden: true }).filter((region) => region.textContent?.includes("Lost the daemon on"))
const shownLostBanners = () => lostBanners().filter((banner) => !banner.closest("[inert]"))

async function loseDaemon(onChangeCredential: () => void) {
  render(<WorkspaceShell onChangeCredential={onChangeCredential} />)
  await act(async () => { completeHandshake(harness.socket(0)) })
  await settle()
  await act(async () => { harness.socket(0).drop() })
  await settle()
}

it("below 640 px the drawer covering the thread moves the lost banner above the row, where its buttons work", async () => {
  stubWidth(true)
  const user = userEvent.setup()
  const onChangeCredential = vi.fn()
  await loseDaemon(onChangeCredential)
  expect(lostBanners()).toHaveLength(1)
  expect(lostBanners()[0]!.closest("main")).not.toBeNull()

  await user.click(sessionsButton())
  const drawer = document.getElementById("sessions-drawer")!
  expect(shownLostBanners()).toHaveLength(1)
  const banner = shownLostBanners()[0]!
  expect(drawer.parentElement!.contains(banner)).toBe(false)
  // Drawn before the row, so the drawer starts below it.
  expect(banner.compareDocumentPosition(drawer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  // The thread's own copy is still in the document but inert, and hidden.
  for (const covered of lostBanners().filter((region) => region.closest("[inert]"))) {
    expect(classes(covered)).toContain("inert:hidden")
  }

  await user.click(within(banner).getByRole("button", { name: "Change credential" }))
  expect(onChangeCredential).toHaveBeenCalledTimes(1)
  const sockets = harness.sockets.length
  await user.click(within(banner).getByRole("button", { name: "Retry now" }))
  await settle()
  expect(harness.sockets.length).toBeGreaterThan(sockets)
  expect(document.getElementById("sessions-drawer")).not.toBeNull()

  await user.keyboard("{Escape}")
  expect(lostBanners()).toHaveLength(1)
  expect(lostBanners()[0]!.closest("main")).not.toBeNull()
})

it("at 640 px and wider the lost banner stays at the top of the thread with the drawer open", async () => {
  stubWidth(false)
  const user = userEvent.setup()
  await loseDaemon(vi.fn())
  await user.click(sessionsButton())
  expect(document.getElementById("sessions-drawer")).not.toBeNull()
  expect(lostBanners()).toHaveLength(1)
  expect(shownLostBanners()).toHaveLength(1)
  expect(lostBanners()[0]!.closest("main")).not.toBeNull()
})

// A resize commits on React's sync lane, whose passive effects also run before
// the browser takes the next input, so the test above cannot tell a layout
// effect from a passive one. Other commits defer passive effects to a later
// task. This probe sits beside the column, as the thread does, and reads its
// own state from its layout effect, which runs after the column's in the same
// commit and before any passive effect: the cover and the inert thread arrive
// together, whatever lane drew them.
it("the covered thread is inert and has lost focus by the layout phase of the commit that draws the cover", async () => {
  stubWidth(true)
  const seen: { inert: boolean; focused: boolean }[] = []
  function Beside() {
    const ref = useRef<HTMLButtonElement | null>(null)
    useLayoutEffect(() => {
      const button = ref.current
      if (button) seen.push({ inert: button.closest("[inert]") !== null, focused: document.activeElement === button })
    })
    return <div><button ref={ref} type="button" autoFocus={false}>Allow once</button></div>
  }
  function Row({ open }: { open: boolean }) {
    return (
      <div className="flex max-sm:relative">
        <SessionsDrawerColumn snapshot={workspaceSnapshot()} open={open} onOpenChange={vi.fn()} onActivate={vi.fn()} />
        <Beside />
      </div>
    )
  }
  const view = render(<Row open={false} />)
  act(() => { screen.getByRole("button", { name: "Allow once" }).focus() })
  seen.length = 0
  view.rerender(<Row open />)
  expect(seen).toEqual([{ inert: true, focused: false }])
})

// Review round 1: a surface can replace its own element in the row in a
// commit the column takes no part in (a lazy surface's error boundary, for
// one). That element is covered too, and inert before anything can focus it.
it("a surface that swaps its own element beside the covering drawer is inert as soon as it lands", async () => {
  stubWidth(true)
  let fail: () => void = () => {}
  function Surface() {
    const [failed, setFailed] = useState(false)
    fail = () => setFailed(true)
    return failed
      ? <section><button type="button" autoFocus>Try again</button></section>
      : <div><button type="button">Allow once</button></div>
  }
  const onOpenChange = vi.fn()
  render(
    <div className="flex max-sm:relative">
      <SessionsDrawerColumn snapshot={workspaceSnapshot()} open onOpenChange={onOpenChange} onActivate={vi.fn()} />
      <Surface />
    </div>,
  )
  expect(screen.getByRole("button", { name: "Allow once", hidden: true }).closest("[inert]")).not.toBeNull()
  act(() => { fail() })
  await act(async () => { await Promise.resolve() })
  const retry = screen.getByRole("button", { name: "Try again", hidden: true })
  expect(retry.closest("[inert]")).not.toBeNull()
  expect(document.activeElement).not.toBe(retry)
  // A new surface beside a cover already drawn is somewhere the person went,
  // so the drawer also gets out of its way (next test).
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

// Pull request review: the app bar stays live above the cover, and its
// Machines chip and Settings button changed the surface behind the drawer,
// which then covered it. A surface landing beside a drawn cover closes it.
it("below 640 px the app bar's Machines and Settings open uncovered", async () => {
  stubWidth(true)
  const user = userEvent.setup()
  await openShell()
  await user.click(sessionsButton())
  await user.click(screen.getByRole("button", { name: /^Machines:/ }))
  expect(document.getElementById("sessions-drawer")).toBeNull()
  const machines = await screen.findByRole("heading", { name: "Machines", level: 1 }, { timeout: 5000 })
  expect(machines.closest("[inert]")).toBeNull()
  await settle()

  await user.click(sessionsButton())
  expect(document.getElementById("sessions-drawer")).not.toBeNull()
  await user.click(screen.getByRole("button", { name: "Settings" }))
  await settle()
  expect(document.getElementById("sessions-drawer")).toBeNull()
  for (const element of document.querySelectorAll("[inert]")) expect(element.classList.contains("sr-only")).toBe(true)
})

// Review round 1: with the floating dock sheet open under the covering drawer,
// Escape closed both, and the sheet's own focus return sent focus into the
// thread. Escape closes the top layer only: the drawer.
it("below 640 px Escape closes the drawer and leaves a floating sheet under it open", async () => {
  stubWidth(true)
  const user = userEvent.setup()
  await openShell()
  await user.click(screen.getByRole("button", { name: "Open the sheet" }))
  await settle()
  expect(screen.getByRole("region", { name: "Machine surfaces" })).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Pin" })).not.toBeNull()
  await user.click(sessionsButton())
  await user.keyboard("{Escape}")
  await settle()
  expect(document.getElementById("sessions-drawer")).toBeNull()
  expect(screen.getByRole("region", { name: "Machine surfaces" })).toBeTruthy()
  expect(document.activeElement).toBe(sessionsButton())
})

// Review round 2: Escape from a control in a floating surface (drawn in a
// portal, root role group) or with a tooltip showing closed the drawer
// instead of that layer. Escape belongs to the layer above the drawer.
it("below 640 px Escape aimed at a portal layer or with a tooltip showing leaves the drawer open", async () => {
  stubWidth(true)
  const user = userEvent.setup()
  await openShell()
  await user.click(sessionsButton())

  const portal = document.createElement("div")
  portal.setAttribute("role", "group")
  const field = document.createElement("input")
  portal.append(field)
  document.body.append(portal)
  act(() => { field.focus() })
  await user.keyboard("{Escape}")
  expect(document.getElementById("sessions-drawer")).not.toBeNull()
  portal.remove()

  const tip = document.createElement("div")
  tip.setAttribute("data-slot", "tooltip-content")
  tip.setAttribute("data-state", "delayed-open")
  document.body.append(tip)
  act(() => { sessionsButton().focus() })
  await user.keyboard("{Escape}")
  expect(document.getElementById("sessions-drawer")).not.toBeNull()
  tip.remove()

  await user.keyboard("{Escape}")
  expect(document.getElementById("sessions-drawer")).toBeNull()
})

// Pull request review: a row action that opens something behind the cover
// (the resumed thread, its checkpoints, its machine menu) left the cover over
// it. Those close the drawer; Archive asks in a dialog above it and keeps it.
it("below 640 px row actions that open the thread close the drawer, and Archive keeps it", async () => {
  stubWidth(true)
  const user = userEvent.setup()
  const { snapshot, socket } = await openShell()
  const quiet = snapshot.sessions.find((session) => session.id !== snapshot.activeSessionId)!
  const rowMenu = async (title: string) => {
    await user.click(screen.getByRole("button", { name: `Actions for ${title}` }))
    return screen.getByRole("menu")
  }

  await user.click(sessionsButton())
  await user.click(within(await rowMenu(quiet.title)).getByRole("menuitem", { name: /Archive session/ }))
  expect(document.getElementById("sessions-drawer")).not.toBeNull()
  await user.click(await screen.findByRole("button", { name: "Keep the session" }))
  await settle()

  if (!document.getElementById("sessions-drawer")) await user.click(sessionsButton())
  await user.click(within(await rowMenu(quiet.title)).getByRole("menuitem", { name: /Fork from a checkpoint/ }))
  await settle()
  expect(document.getElementById("sessions-drawer")).toBeNull()
  expect(pendingRequest(socket, "session.activate").params).toMatchObject({ sessionId: quiet.id })
  // The menu's trigger left with the drawer; focus does not fall to the body.
  expect(document.activeElement).not.toBe(document.body)
  expect(document.activeElement?.closest("[inert]") ?? null).toBeNull()
  // Once the session is active its checkpoints open, uncovered.
  await act(async () => { respond(socket, "session.activate", workspaceSnapshot({ activeSessionId: quiet.id })) })
  await settle()
  const sheet = screen.getByRole("region", { name: "Machine surfaces" })
  expect(within(sheet).getByRole("tab", { name: "Checkpoints" }).getAttribute("aria-selected")).toBe("true")
  expect(sheet.closest("[inert]")).toBeNull()
})

it("below 640 px an approval that arrives under the open drawer takes no focus and cannot be acted on until it closes", async () => {
  stubWidth(true)
  const user = userEvent.setup()
  render(<WorkspaceShell />)
  const socket = harness.socket(0)
  await act(async () => { completeHandshake(socket, workspaceSnapshot({ approvals: [] })) })
  await settle()
  expect(screen.queryByRole("button", { name: /^Allow once/ })).toBeNull()
  await user.click(sessionsButton())
  const opener = document.activeElement

  await act(async () => { notify(socket, "workspace.changed", workspaceSnapshot()) })
  await settle()
  const allow = allowOnce()
  expect(allow.closest("[inert]")).not.toBeNull()
  expect(document.activeElement).toBe(opener)
  expect(screen.getByRole("region", { name: "NEEDS YOU" })).toBeTruthy()

  await user.keyboard("{Escape}")
  expect(allow.closest("[inert]")).toBeNull()
  await user.click(allow)
  expect(sentRequests(socket, "approval.resolve")).toHaveLength(1)
})

it("below 640 px a row menu and the command palette open over the drawer, outside what it covers", async () => {
  stubWidth(true)
  const user = userEvent.setup()
  const { snapshot } = await openShell()
  await user.click(sessionsButton())
  await user.click(screen.getByRole("button", { name: `Actions for ${snapshot.sessions[0]!.title}` }))
  const menu = screen.getByRole("menu")
  expect(menu.closest("[inert]")).toBeNull()
  // The open menu hides the rest of the page from the accessibility tree, so
  // the column is found by its id here. The menu takes its own Escape.
  await user.keyboard("{Escape}")
  expect(screen.queryByRole("menu")).toBeNull()
  expect(document.getElementById("sessions-drawer")).not.toBeNull()

  await user.click(screen.getByRole("button", { name: "Open command palette" }))
  const palette = await screen.findByRole("dialog")
  expect(palette.closest("[inert]")).toBeNull()
  expect(palette.contains(document.activeElement)).toBe(true)
  await user.keyboard("{Escape}")
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(document.getElementById("sessions-drawer")).not.toBeNull()
  expect(allowOnce().closest("[inert]")).not.toBeNull()
})

it("widening past 640 px with the drawer open turns it back into a column and frees the thread", async () => {
  const resize = stubWidth(true)
  const user = userEvent.setup()
  await openShell()
  await user.click(sessionsButton())
  expect(allowOnce().closest("[inert]")).not.toBeNull()
  act(() => { resize(false) })
  const drawer = screen.getByRole("complementary", { name: "Sessions" })
  expect(classes(drawer)).not.toContain("absolute")
  expect(document.querySelector("[data-sessions-backdrop]")).toBeNull()
  for (const element of besideDrawer()) expect(element.hasAttribute("inert")).toBe(false)
})

it("at 640 px and wider the drawer stays a column: nothing is inert, and Escape or choosing a session leave it open", async () => {
  stubWidth(false)
  const user = userEvent.setup()
  const { snapshot, socket } = await openShell()
  await user.click(sessionsButton())
  expect(document.querySelector("[data-sessions-backdrop]")).toBeNull()
  expect(classes(screen.getByRole("complementary", { name: "Sessions" }))).not.toContain("absolute")
  for (const element of besideDrawer()) expect(element.hasAttribute("inert")).toBe(false)
  expect(allowOnce().closest("[inert]")).toBeNull()
  await user.keyboard("{Escape}")
  expect(screen.getByRole("complementary", { name: "Sessions" })).toBeTruthy()
  const other = snapshot.sessions.find((session) => session.id !== snapshot.activeSessionId)!
  await user.click(screen.getByRole("button", { name: new RegExp(`^${other.title.slice(0, 24)}`) }))
  expect(pendingRequest(socket, "session.activate").params).toMatchObject({ sessionId: other.id })
  expect(screen.getByRole("complementary", { name: "Sessions" })).toBeTruthy()
})
