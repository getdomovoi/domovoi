import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  repositoryGitFilterErrorCode,
  repositoryGitFilterRefusalSchema,
  repositoryTrustResultSchema,
  toolInventorySchema,
  type RepositoryGitFilterRefusal,
  type RepositoryTrustResult,
  type RepositoryTrustState,
  type ToolInventory,
} from "@getdomovoi/protocol"

import { CheckpointFork } from "./checkpoint-actions.js"
import { DaemonRpcError } from "./client.js"
import { SessionRefusalCard } from "./session-refusal-card.js"
import { gitFilterRefusalFrom } from "./session-refusal.js"
import { loadingLineRef, startOpenerRef } from "./start-handoff.js"
import { assignSlotsLikeABrowser } from "./test-support/assigned-slot.js"

afterEach(cleanup)

const digest = `sha256:${"a".repeat(64)}`
const changedDigest = `sha256:${"c".repeat(64)}`
// tool.inventory's digest over the git filter block it lists.
const reviewDigest = `sha256:${"b".repeat(64)}`
// A filter driver's commands are a definition list, one row per operation
// and its command (rulings Q328, Q335), read here as [operation, command].
const filterPairs = (scope: HTMLElement) =>
  [...scope.querySelectorAll("dl[data-slot='filter-commands'] > div")].map((row) => [
    row.querySelector("dt")?.textContent,
    row.querySelector("dd")?.textContent,
  ])
const grant = { trustedDigest: digest, trustedAt: "2026-09-30T10:41:00.000Z", trustedBy: { client: "desktop" as const } }
const notTrusted: RepositoryTrustState = { state: "untrusted", reason: "not-trusted" }

function refusal(overrides: Partial<RepositoryGitFilterRefusal> = {}): RepositoryGitFilterRefusal {
  // Every fixture is an answer the daemon could send.
  return repositoryGitFilterRefusalSchema.parse({
    kind: "repository-git-filter",
    projectId: "project-acme",
    configDigest: digest,
    trust: notTrusted,
    drivers: [{ name: "sops", scope: "local" }],
    omittedDrivers: 0,
    ...overrides,
  })
}

function inventory(configDigest = digest, trust: RepositoryTrustState = notTrusted): ToolInventory {
  return toolInventorySchema.parse({
    machine: { id: "machine-1", name: "mac-mini-m4", platform: "darwin", arch: "arm64", version: "0.9.4" },
    repository: {
      projectId: "project-acme",
      root: "~/src/acme-api",
      configDigest,
      trust,
      gitFilters: {
        files: [{ path: ".git/config", scope: "local" }],
        entries: [
          { driver: "sops", operation: "smudge", command: "sops -d", required: "true", file: ".git/config", scope: "local", heldBack: true },
          { driver: "sops", operation: "clean", command: "sops -e", required: "true", file: ".git/config", scope: "local", heldBack: true },
        ],
        omittedEntries: 0,
        reviewDigest,
      },
    },
    providers: [],
  })
}

type Trust = (params: { projectId: string; configDigest: string }) => Promise<RepositoryTrustResult>

function trusted(): RepositoryTrustResult {
  return repositoryTrustResultSchema.parse({
    outcome: "trusted",
    repository: { projectId: "project-acme", configDigest: digest, trust: { state: "trusted", ...grant } },
  })
}

function show(options: {
  refusal?: RepositoryGitFilterRefusal
  onTrust?: Trust
  loadInventory?: (signal: AbortSignal) => Promise<ToolInventory>
  onStartAgain?: () => Promise<void>
  focusFrom?: { trigger: Element | null; within: Element | null }
} = {}) {
  const props = {
    refusal: options.refusal ?? refusal(),
    repository: "acme-api",
    machine: "mac-mini-m4",
    machineId: "machine-1",
    focusFrom: options.focusFrom ?? { trigger: null, within: null },
    loadInventory: options.loadInventory ?? vi.fn(async () => inventory()),
    onOpenTools: vi.fn(),
    onStartAgain: options.onStartAgain ?? vi.fn(async () => {}),
    onClose: vi.fn(),
  }
  render(<SessionRefusalCard {...props} {...(options.onTrust ? { onTrust: options.onTrust } : {})} />)
  return { ...props, user: userEvent.setup(), card: screen.getByRole("region", { name: "Domovoi did not start this session" }) }
}

// The card moves focus to its heading one frame after it appears, and only
// while the person is still where the refused start left them: the document,
// Domovoi's own loading line, or the Domovoi control that opened the start,
// each known by the exact node its component registered. Focus anywhere else
// stays there (rulings Q400, Q410).
describe("focus when the refusal appears", () => {
  function frames() {
    const pending: FrameRequestCallback[] = []
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => pending.push(callback))
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {})
    return () => { for (const callback of pending.splice(0)) act(() => callback(0)) }
  }
  let restoreSlots = () => {}
  beforeEach(() => { restoreSlots = assignSlotsLikeABrowser() })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    restoreSlots()
    document.body.replaceChildren()
  })
  const heading = () => screen.getByRole("heading", { name: "Domovoi did not start this session" })
  // A control registered, as Domovoi's own start controls register theirs, as
  // one that opens a session start.
  function opener(element: HTMLElement = document.createElement("button")) {
    startOpenerRef(element)
    return element
  }
  // A line registered as the one a surface's code loads behind.
  function loadingLine(line: HTMLElement = Object.assign(document.createElement("p"), { tabIndex: -1 })) {
    loadingLineRef(line)
    return line
  }
  // The attributes earlier rounds read. A page can put them on anything, so
  // they grant nothing (security review round 8).
  function withAttribute<E extends HTMLElement>(element: E, name: "data-domovoi-opener" | "data-surface-loading") {
    element.setAttribute(name, "")
    return element
  }

  it("takes focus from the document", () => {
    const run = frames()
    show()
    ;(document.activeElement as HTMLElement | null)?.blur()
    run()
    expect(document.activeElement).toBe(heading())
  })

  it("takes focus from the loading line its code loaded behind", () => {
    const run = frames()
    const line = document.body.appendChild(loadingLine())
    line.focus()
    show()
    run()
    expect(document.activeElement).toBe(heading())
  })

  it("takes focus from the registered control that opened the start", () => {
    const run = frames()
    const trigger = document.body.appendChild(opener())
    trigger.focus()
    show({ focusFrom: { trigger, within: null } })
    run()
    expect(document.activeElement).toBe(heading())
  })

  // The fork confirm closes and gives focus back to its Fork trigger, the
  // start's own opener, which Domovoi's fork control registered.
  it("takes focus from the fork trigger the confirm gave focus back to", async () => {
    const user = userEvent.setup()
    render(<CheckpointFork checkpointId="checkpoint-7f23" label="before migration" disabled={false} onFork={vi.fn()} />)
    const trigger = screen.getByRole("button", { name: "Fork from here" })
    await user.click(trigger)
    await user.click(screen.getByRole("button", { name: "Fork session" }))
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
    const run = frames()
    show({ focusFrom: { trigger, within: null } })
    run()
    expect(document.activeElement).toBe(heading())
  })

  // The card can appear while the launcher the start came from is still
  // closing: it waits for focus to leave that dialog, then decides.
  it("waits while focus is still in the dialog the start came from", () => {
    const run = frames()
    const trigger = document.body.appendChild(opener())
    const launcher = document.body.appendChild(document.createElement("div"))
    launcher.setAttribute("role", "dialog")
    const submit = launcher.appendChild(opener())
    submit.focus()
    show({ focusFrom: { trigger, within: submit } })
    run()
    expect(document.activeElement).toBe(submit)
    // The launcher closes and gives focus back to its trigger.
    launcher.remove()
    trigger.focus()
    run()
    expect(document.activeElement).toBe(heading())
  })

  // The dialog is drawn inside a widget's open shadow root around a slot, and
  // the control the start came from is the page's own, assigned to that slot.
  // It renders in the dialog, so the card waits for that dialog to close.
  it("waits while focus is still in a dialog the start's control is slotted into", () => {
    const run = frames()
    const trigger = document.body.appendChild(opener())
    const widget = document.body.appendChild(document.createElement("div"))
    const dialog = widget.attachShadow({ mode: "open" }).appendChild(document.createElement("div"))
    dialog.setAttribute("role", "dialog")
    dialog.appendChild(document.createElement("slot"))
    const submit = widget.appendChild(opener())
    submit.focus()
    show({ focusFrom: { trigger, within: submit } })
    run()
    expect(document.activeElement).toBe(submit)
    widget.remove()
    trigger.focus()
    run()
    expect(document.activeElement).toBe(heading())
  })

  it.each([
    ["an input", () => document.createElement("input")],
    ["a text area", () => document.createElement("textarea")],
    ["an editable region", () => Object.assign(document.createElement("div"), { contentEditable: "true", tabIndex: 0 })],
    ["another control", () => document.createElement("button")],
    ["another registered control", () => opener()],
  ])("leaves focus in %s the person moved to before the frame", (_label, make) => {
    const run = frames()
    const trigger = document.body.appendChild(opener())
    show({ focusFrom: { trigger, within: null } })
    const elsewhere = document.body.appendChild(make())
    elsewhere.focus()
    run()
    expect(document.activeElement).toBe(elsewhere)
  })

  it("leaves focus in another dialog", () => {
    const run = frames()
    show()
    const dialog = document.body.appendChild(Object.assign(document.createElement("div"), { role: "dialog" }))
    dialog.setAttribute("role", "dialog")
    const button = dialog.appendChild(document.createElement("button"))
    button.focus()
    run()
    expect(document.activeElement).toBe(button)
  })

  // document.activeElement names only the outermost shadow host, and a frame
  // holds focus of its own. The saved trigger can be that host or frame while
  // the person types inside it. Whether a closed root holds focus cannot be
  // seen at all, tabindex or not, so the card takes focus only from the exact
  // control Domovoi registered as the start's opener, and from nothing a page
  // or widget drew (ruling Q410).
  function shadowInput(host: HTMLElement, mode: ShadowRootMode) {
    return host.attachShadow({ mode }).appendChild(document.createElement("input"))
  }
  function slottedInDialog(control: HTMLElement) {
    const widget = document.body.appendChild(document.createElement("div"))
    const dialog = widget.attachShadow({ mode: "open" }).appendChild(document.createElement("div"))
    dialog.setAttribute("role", "dialog")
    dialog.appendChild(document.createElement("slot"))
    return widget.appendChild(control)
  }
  it.each([
    ["an unregistered control that opened the start", () => {
      const button = document.body.appendChild(document.createElement("button"))
      return { trigger: button, focus: button }
    }],
    ["an input in an open shadow root", () => {
      const host = document.body.appendChild(document.createElement("div"))
      return { trigger: host, focus: shadowInput(host, "open") }
    }],
    ["an input in nested open shadow roots", () => {
      const host = document.body.appendChild(document.createElement("div"))
      const inner = host.attachShadow({ mode: "open" }).appendChild(document.createElement("div"))
      return { trigger: host, focus: shadowInput(inner, "open") }
    }],
    ["an input in a closed shadow root", () => {
      const host = document.body.appendChild(document.createElement("div"))
      return { trigger: host, focus: shadowInput(host, "closed") }
    }],
    ["an input in a closed shadow root whose host has tabindex 0", () => {
      const host = document.body.appendChild(Object.assign(document.createElement("div"), { tabIndex: 0 }))
      return { trigger: host, focus: shadowInput(host, "closed") }
    }],
    ["an input in a closed shadow root whose host has tabindex -1", () => {
      const host = document.body.appendChild(Object.assign(document.createElement("div"), { tabIndex: -1 }))
      return { trigger: host, focus: shadowInput(host, "closed") }
    }],
    ["an input in a closed shadow root inside an open one, whose host has tabindex 0", () => {
      const outer = document.body.appendChild(document.createElement("div"))
      const host = outer.attachShadow({ mode: "open" }).appendChild(Object.assign(document.createElement("div"), { tabIndex: 0 }))
      return { trigger: outer, focus: shadowInput(host, "closed") }
    }],
    ["a shadow host whose open root holds no focus", () => {
      const host = document.body.appendChild(Object.assign(document.createElement("div"), { tabIndex: 0 }))
      host.attachShadow({ mode: "open" }).appendChild(document.createElement("span"))
      return { trigger: host, focus: host }
    }],
    ["a control in an open shadow root", () => {
      const host = document.body.appendChild(document.createElement("div"))
      const button = host.attachShadow({ mode: "open" }).appendChild(document.createElement("button"))
      return { trigger: button, focus: button }
    }],
    ["a registered control in an open shadow root", () => {
      const host = document.body.appendChild(document.createElement("div"))
      const button = host.attachShadow({ mode: "open" }).appendChild(opener())
      return { trigger: button, focus: button }
    }],
    ["a loading line in an open shadow root", () => {
      const host = document.body.appendChild(document.createElement("div"))
      const line = host.attachShadow({ mode: "open" }).appendChild(loadingLine())
      return { trigger: null, focus: line }
    }],
    ["a frame", () => {
      const frame = document.body.appendChild(document.createElement("iframe"))
      return { trigger: frame, focus: frame }
    }],
    ["a control in a shadow root inside another dialog", () => {
      const dialog = document.body.appendChild(document.createElement("div"))
      dialog.setAttribute("role", "dialog")
      const host = dialog.appendChild(document.createElement("div"))
      const button = host.attachShadow({ mode: "open" }).appendChild(opener())
      return { trigger: button, focus: button }
    }],
    ["a control slotted into a dialog in an open shadow root", () => {
      const button = slottedInDialog(document.createElement("button"))
      return { trigger: button, focus: button }
    }],
    ["a registered control slotted into a dialog in an open shadow root", () => {
      const button = slottedInDialog(opener())
      return { trigger: button, focus: button }
    }],
    // Security review round 8: a page can copy any attribute onto its own
    // field or host, so no attribute lets the card take focus.
    ["an input carrying the opener attribute", () => {
      const input = document.body.appendChild(withAttribute(document.createElement("input"), "data-domovoi-opener"))
      return { trigger: input, focus: input }
    }],
    ["a text area carrying the opener attribute", () => {
      const area = document.body.appendChild(withAttribute(document.createElement("textarea"), "data-domovoi-opener"))
      return { trigger: area, focus: area }
    }],
    ["an editable region carrying the opener attribute", () => {
      const region = document.body.appendChild(withAttribute(Object.assign(document.createElement("div"), { contentEditable: "true", tabIndex: 0 }), "data-domovoi-opener"))
      return { trigger: region, focus: region }
    }],
    ["a button carrying the opener attribute that Domovoi did not register", () => {
      const button = document.body.appendChild(withAttribute(document.createElement("button"), "data-domovoi-opener"))
      return { trigger: button, focus: button }
    }],
    ["a closed shadow root whose host carries the opener attribute", () => {
      const host = document.body.appendChild(withAttribute(Object.assign(document.createElement("div"), { tabIndex: 0 }), "data-domovoi-opener"))
      return { trigger: host, focus: shadowInput(host, "closed") }
    }],
    ["an unrelated input carrying the loading line's attribute, with no saved trigger", () => {
      const input = document.body.appendChild(withAttribute(document.createElement("input"), "data-surface-loading"))
      return { trigger: null, focus: input }
    }],
    ["a closed shadow root whose host carries the loading line's attribute", () => {
      const host = document.body.appendChild(withAttribute(Object.assign(document.createElement("div"), { tabIndex: 0 }), "data-surface-loading"))
      return { trigger: null, focus: shadowInput(host, "closed") }
    }],
    // Registration is no pass for text entry, frames or hosts either.
    ["an input registered as an opener", () => {
      const input = document.body.appendChild(opener(document.createElement("input")))
      return { trigger: input, focus: input }
    }],
    ["an input registered as a loading line", () => {
      const input = document.body.appendChild(loadingLine(document.createElement("input")))
      return { trigger: null, focus: input }
    }],
    ["an open shadow host registered as a loading line", () => {
      const host = document.body.appendChild(loadingLine(Object.assign(document.createElement("div"), { tabIndex: -1 })))
      host.attachShadow({ mode: "open" }).appendChild(document.createElement("span"))
      return { trigger: null, focus: host }
    }],
    ["a custom element registered as a loading line", () => {
      const element = document.body.appendChild(loadingLine(Object.assign(document.createElement("review-note"), { tabIndex: -1 })))
      return { trigger: null, focus: element }
    }],
    ["a frame registered as a loading line", () => {
      const frame = document.body.appendChild(loadingLine(document.createElement("iframe")))
      return { trigger: null, focus: frame }
    }],
  ])("leaves focus in %s, even when it is the saved trigger", (_label, make) => {
    const run = frames()
    const { trigger, focus } = make()
    show({ focusFrom: { trigger, within: null } })
    focus.focus()
    const held = document.activeElement
    run()
    expect(document.activeElement).toBe(held)
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { name: "Domovoi did not start this session" }))
  })
})

describe("reading a refusal", () => {
  it("reads the git filter refusal from the daemon's error, and nothing else", () => {
    const data = refusal()
    expect(gitFilterRefusalFrom(new DaemonRpcError(repositoryGitFilterErrorCode, "refused", data))).toEqual(data)
    // Another code, or data the protocol refuses, is an ordinary failure.
    expect(gitFilterRefusalFrom(new DaemonRpcError(-32603, "refused", data))).toBeUndefined()
    expect(gitFilterRefusalFrom(new DaemonRpcError(repositoryGitFilterErrorCode, "refused", { kind: "repository-git-filter" }))).toBeUndefined()
    expect(gitFilterRefusalFrom(new Error("refused"))).toBeUndefined()
  })
})

describe("session refused for an untrusted git filter", () => {
  it("names who refused, the reason code, the filter it names and that nothing ran", () => {
    const { card } = show({ onTrust: vi.fn<Trust>() })

    expect(within(card).getByRole("heading", { name: "Domovoi did not start this session" })).toBeTruthy()
    expect(within(card).getByText("refused · untrusted git filter")).toBeTruthy()
    expect(within(card).getByText("Checking out acme-api would run the sops filter driver, which is not trusted on mac-mini-m4.")).toBeTruthy()
    expect(within(card).getByText("It names")).toBeTruthy()
    expect(within(card).getByText("sops · local git config")).toBeTruthy()
    expect(within(card).getByText("Nothing from the repository ran.")).toBeTruthy()
    expect(within(card).getByRole("button", { name: "Review and trust" })).toBeTruthy()
    expect(within(card).getByRole("button", { name: "Open Tools" })).toBeTruthy()
    expect(within(card).queryByRole("button", { name: "Start the session again" })).toBeNull()
  })

  // The Skills design draws the refusal (step 15) with the danger family: its
  // border, background and text, and a destructive dot, so a refusal never
  // reads as held-back inventory (bot finding 4151622864). jsdom lays nothing
  // out, so the tokens are read from the classes.
  it("draws the refusal with the danger tokens, as the design does", () => {
    const { card } = show({ onTrust: vi.fn<Trust>() })

    expect(card.className).toContain("border-danger-border")
    expect(card.className).toContain("bg-danger-background")
    expect(card.querySelector("[data-slot='refusal-dot']")?.className).toContain("bg-destructive")
    expect(within(card).getByRole("heading", { name: "Domovoi did not start this session" }).className).toContain("text-danger-foreground")
    expect(within(card).getByText("refused · untrusted git filter").className).toContain("text-danger-dim")
    expect(within(card).getByText("Nothing from the repository ran.").className).toContain("text-danger-dim")
  })

  it("names several drivers and counts the ones the daemon did not name", () => {
    const { card } = show({
      refusal: refusal({ drivers: [{ name: "sops", scope: "local" }, { name: "crypt", scope: "worktree" }], omittedDrivers: 2 }),
    })

    expect(within(card).getByText("Checking out acme-api would run the sops and crypt filter drivers and 2 more, which are not trusted on mac-mini-m4.")).toBeTruthy()
    expect(within(card).getByText("sops · local git config")).toBeTruthy()
    expect(within(card).getByText("crypt · worktree git config")).toBeTruthy()
    expect(within(card).getByText("and 2 more")).toBeTruthy()
  })

  it("says where trust is granted on a client that cannot grant it, and still opens Tools", async () => {
    const { card, user, onOpenTools } = show()

    expect(within(card).queryByRole("button", { name: "Review and trust" })).toBeNull()
    expect(within(card).getByText("Granted from desktop or web only.")).toBeTruthy()
    await user.click(within(card).getByRole("button", { name: "Open Tools" }))
    expect(onOpenTools).toHaveBeenCalledOnce()
  })

  it("offers no trust when the repository cannot be trusted", () => {
    const { card } = show({
      onTrust: vi.fn<Trust>(),
      refusal: refusal({ trust: { state: "untrusted", reason: "cannot-trust", refusals: [{ provider: "codex", code: "nested-config", path: "packages/api/.codex" }], omittedRefusals: 0 } }),
    })

    expect(within(card).getByText("Checking out acme-api would run the sops filter driver, and acme-api cannot be trusted on mac-mini-m4.")).toBeTruthy()
    expect(within(card).queryByRole("button", { name: "Review and trust" })).toBeNull()
    expect(within(card).getByRole("button", { name: "Open Tools" })).toBeTruthy()
  })

  // A trusted refusal: the filters are held back under the trust read now
  // (the daemon's filters-not-reviewed or filters-changed, or a grant that
  // changed while the start ran). The refusal does not say which, so the
  // sentence names no cause. Trusting again from a client that shows the
  // filters settles it.
  it("says the filters are held back until they are reviewed again when the repository is trusted", () => {
    const { card } = show({ onTrust: vi.fn<Trust>(), refusal: refusal({ trust: { state: "trusted", ...grant } }) })

    expect(within(card).getByText("Checking out acme-api would run the sops filter driver. acme-api is trusted on mac-mini-m4, but its Git filters are held back until they are reviewed again.")).toBeTruthy()
    expect(within(card).getByRole("button", { name: "Review and trust again" })).toBeTruthy()
    expect(within(card).queryByRole("button", { name: "Start the session again" })).toBeNull()
  })

  it("says where trust is granted for a trusted refusal on a client that cannot grant it", () => {
    const { card } = show({ refusal: refusal({ trust: { state: "trusted", ...grant } }) })

    expect(within(card).queryByRole("button", { name: "Review and trust again" })).toBeNull()
    expect(within(card).getByText("Granted from desktop or web only.")).toBeTruthy()
  })
})

describe("review and trust from the refusal", () => {
  it("opens the one trust sheet over the files read now, and after trust offers to start again without starting", async () => {
    const onTrust = vi.fn<Trust>().mockResolvedValue(trusted())
    const loadInventory = vi.fn(async () => inventory())
    const onStartAgain = vi.fn(async () => {})
    const { card, user } = show({ onTrust, loadInventory, onStartAgain })

    await user.click(within(card).getByRole("button", { name: "Review and trust" }))
    const sheet = await screen.findByRole("dialog")
    expect(loadInventory).toHaveBeenCalledOnce()
    expect(within(sheet).getByRole("heading", { name: "Trust acme-api on mac-mini-m4" })).toBeTruthy()
    await within(sheet).findByRole("group", { name: ".git/config" })
    expect(filterPairs(sheet)).toEqual([["smudge", "sops -d"], ["clean", "sops -e"]])

    await user.click(within(sheet).getByRole("button", { name: "Trust for this machine" }))

    // The grant acknowledges the git filters the sheet showed (#688).
    expect(onTrust).toHaveBeenCalledExactlyOnceWith({ projectId: "project-acme", configDigest: digest, gitFilters: { reviewed: true, reviewDigest } })
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(within(card).getByText("Trusted on mac-mini-m4. Nothing has started yet.")).toBeTruthy()
    // The refusal no longer says the filter is not trusted.
    expect(within(card).getByText("Checking out acme-api would run the sops filter driver.")).toBeTruthy()
    expect(within(card).queryByText(/is not trusted on/)).toBeNull()
    expect(within(card).queryByRole("button", { name: "Review and trust" })).toBeNull()
    // The session never starts by itself (ruling Q202 A).
    expect(onStartAgain).not.toHaveBeenCalled()

    await user.click(within(card).getByRole("button", { name: "Start the session again" }))
    expect(onStartAgain).toHaveBeenCalledOnce()
  })

  it("reviews and trusts again from a trusted refusal, acknowledging the filters it shows", async () => {
    const onTrust = vi.fn<Trust>().mockResolvedValue(trusted())
    const loadInventory = vi.fn(async () => inventory(digest, { state: "trusted", ...grant }))
    const { card, user } = show({ onTrust, loadInventory, refusal: refusal({ trust: { state: "trusted", ...grant } }) })

    await user.click(within(card).getByRole("button", { name: "Review and trust again" }))
    const sheet = await screen.findByRole("dialog")
    expect(await within(sheet).findByRole("heading", { name: "Trust acme-api again on mac-mini-m4" })).toBeTruthy()
    await user.click(within(sheet).getByRole("button", { name: "Trust for this machine" }))

    expect(onTrust).toHaveBeenCalledExactlyOnceWith({ projectId: "project-acme", configDigest: digest, gitFilters: { reviewed: true, reviewDigest } })
    expect(within(card).getByText("Trusted on mac-mini-m4. Nothing has started yet.")).toBeTruthy()
    expect(within(card).getByText("Checking out acme-api would run the sops filter driver.")).toBeTruthy()
    expect(within(card).getByRole("button", { name: "Start the session again" })).toBeTruthy()
  })

  // The review is of the refused repository on the refused machine only: an
  // inventory read for another one is not offered for trust (ruling Q323).
  it.each([
    ["another project", { ...inventory(), repository: { ...inventory().repository!, projectId: "project-other" } }],
    ["another machine", { ...inventory(), machine: { ...inventory().machine, id: "machine-2" } }],
  ])("offers no trust over the tools of %s", async (_label, other) => {
    const onTrust = vi.fn<Trust>()
    const { card, user } = show({ onTrust, loadInventory: vi.fn(async () => other) })

    await user.click(within(card).getByRole("button", { name: "Review and trust" }))
    const sheet = await screen.findByRole("dialog")

    expect(await within(sheet).findByText("Domovoi read the tools of another project or machine than the one that refused this session, so they are not shown for review.")).toBeTruthy()
    expect(within(sheet).queryByRole("button", { name: "Trust for this machine" })).toBeNull()
    expect(onTrust).not.toHaveBeenCalled()
  })

  it("keeps the refusal when the files changed while the sheet was open, and reads them again", async () => {
    const onTrust = vi.fn<Trust>().mockResolvedValue(repositoryTrustResultSchema.parse({
      outcome: "config-changed",
      repository: { projectId: "project-acme", configDigest: changedDigest, trust: notTrusted },
    }))
    const loadInventory = vi.fn<(signal: AbortSignal) => Promise<ToolInventory>>()
      .mockResolvedValueOnce(inventory())
      .mockResolvedValueOnce(inventory(changedDigest))
    const { card, user } = show({ onTrust, loadInventory })

    await user.click(within(card).getByRole("button", { name: "Review and trust" }))
    const sheet = await screen.findByRole("dialog")
    await within(sheet).findByText(digest)
    await user.click(within(sheet).getByRole("button", { name: "Trust for this machine" }))

    expect(within(screen.getByRole("dialog")).getByText("The files changed while this was open")).toBeTruthy()
    expect(await within(screen.getByRole("dialog")).findByText(changedDigest)).toBeTruthy()
    expect(loadInventory).toHaveBeenCalledTimes(2)
    expect(within(card).queryByText(/Nothing has started yet/)).toBeNull()
    expect(within(card).queryByRole("button", { name: "Start the session again" })).toBeNull()
  })

  it("does not count a grant for another project as lifting this refusal", async () => {
    const other = repositoryTrustResultSchema.parse({
      outcome: "trusted",
      repository: { projectId: "project-other", configDigest: digest, trust: { state: "trusted", ...grant } },
    })
    const { card, user } = show({ onTrust: vi.fn<Trust>().mockResolvedValue(other) })

    await user.click(within(card).getByRole("button", { name: "Review and trust" }))
    const sheet = await screen.findByRole("dialog")
    await within(sheet).findByText(digest)
    await user.click(within(sheet).getByRole("button", { name: "Trust for this machine" }))

    expect(within(card).queryByRole("button", { name: "Start the session again" })).toBeNull()
  })

  it("names a start that failed for another reason and leaves the retry with the person", async () => {
    const onStartAgain = vi.fn(async () => { throw new Error("The provider is not ready") })
    const { card, user } = show({ onTrust: vi.fn<Trust>().mockResolvedValue(trusted()), onStartAgain })

    await user.click(within(card).getByRole("button", { name: "Review and trust" }))
    const sheet = await screen.findByRole("dialog")
    await within(sheet).findByText(digest)
    await user.click(within(sheet).getByRole("button", { name: "Trust for this machine" }))
    await user.click(within(card).getByRole("button", { name: "Start the session again" }))

    expect(within(card).getByText("The provider is not ready")).toBeTruthy()
    expect(within(card).getByRole("button", { name: "Start the session again" })).toBeTruthy()
    expect(onStartAgain).toHaveBeenCalledOnce()
  })
})
