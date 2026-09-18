import type { ProviderModel, ProviderRuntime, Runtime, RuntimeDiscoverResult } from "@getdomovoi/protocol"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { ModelPopover, modelCountText } from "./model-popover"

afterEach(cleanup)

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

const runtime: Runtime = { provider: "claude-code", model: "claude-sonnet-4.6", reasoning: "medium", permissionMode: "build", auto: false }

const providers: ProviderRuntime[] = [
  { id: "claude-code", command: "claude", status: "ready", sessionCapable: true },
  { id: "codex", command: "codex", status: "ready", sessionCapable: true },
  { id: "aider", command: "aider", status: "missing", sessionCapable: true },
]

function model(provider: string, id: string, description: string, isDefault = false): ProviderModel {
  return { provider, id, displayName: id, description, supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium", isDefault }
}

const catalogs: Record<string, ProviderModel[]> = {
  "claude-code": [model("claude-code", "claude-sonnet-4.6", "The default here.", true), model("claude-code", "claude-opus-4.2", "Slower and dearer.")],
  codex: [model("codex", "gpt-5.3-codex", "Authenticated here.")],
}

function popover(extra: Partial<Parameters<typeof ModelPopover>[0]> = {}) {
  return (
    <ModelPopover
      runtime={runtime}
      providers={providers}
      machineName="mac-mini-m4"
      pending={false}
      onListModels={vi.fn(async (provider: string) => catalogs[provider] ?? [])}
      onChange={vi.fn()}
      onFork={vi.fn(async () => {})}
      {...extra}
    />
  )
}

// One flat list across every harness that reported, the current model ticked.
// A harness that is not installed is absent, not dimmed: the fleet's
// dim-and-keep rule is about machines you paired and still own; an agent that
// was never installed was never yours, and a greyed filter returns nothing.
it("lists every reporting harness's models flat, ticks the current one, and omits a harness that is not installed", async () => {
  const user = userEvent.setup()
  render(popover())
  await user.click(screen.getByRole("button", { name: /claude-code · sonnet 4\.6/ }))
  await settle()
  const rows = screen.getAllByRole("option")
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
    "claude-sonnet-4.6, claude-code", "claude-opus-4.2, claude-code", "gpt-5.3-codex, codex",
  ])
  expect(rows[0]!.getAttribute("aria-selected")).toBe("true")
  expect(screen.queryByRole("button", { name: "aider" })).toBeNull()
  expect(screen.queryByText(/aider/)).toBeNull()
  expect(screen.getByText("3 of 3 · 2 harnesses reported")).toBeTruthy()
})

// The chip and each row show a display name derived from the id, with the id
// itself still on the row in mono: that string is what the audit log and the
// provider's own error say.
it("derives the short name and keeps the full id beside it", async () => {
  const user = userEvent.setup()
  render(popover())
  await user.click(screen.getByRole("button", { name: /claude-code · sonnet 4\.6/ }))
  await settle()
  const row = screen.getByRole("option", { name: "gpt-5.3-codex, codex" })
  expect(within(row).getByText("gpt 5.3")).toBeTruthy()
  expect(within(row).getByText("gpt-5.3-codex")).toBeTruthy()
})

it("narrows by typed text and by a harness chip, and says when nothing matches", async () => {
  const user = userEvent.setup()
  render(popover())
  await user.click(screen.getByRole("button", { name: /claude-code · sonnet 4\.6/ }))
  await settle()
  await user.type(screen.getByRole("searchbox", { name: "Search models on this machine" }), "opus")
  expect(screen.getAllByRole("option").map((row) => row.getAttribute("aria-label"))).toEqual(["claude-opus-4.2, claude-code"])
  expect(screen.getByText("1 of 3 · 2 harnesses reported")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "clear" }))
  await user.click(screen.getByRole("button", { name: "codex", pressed: false }))
  expect(screen.getAllByRole("option").map((row) => row.getAttribute("aria-label"))).toEqual(["gpt-5.3-codex, codex"])
  await user.type(screen.getByRole("searchbox", { name: "Search models on this machine" }), "kimi")
  expect(screen.getByText(/Nothing on this machine matches/)).toBeTruthy()
})

it("asks the agents again through discovery and shows what each one reported", async () => {
  const user = userEvent.setup()
  const onDiscoverRuntime = vi.fn(async (provider: string): Promise<RuntimeDiscoverResult> => provider === "codex"
    ? { machineId: "machine-1", provider, status: "unavailable", reason: "auth-required", action: "sign-in", retryable: true, message: "Sign in to codex on this machine." }
    : provider === "aider"
      ? { machineId: "machine-1", provider, status: "unavailable", reason: "missing", action: "install", retryable: false, message: "aider is not installed." }
      : { machineId: "machine-1", provider, status: "ready", models: [...catalogs["claude-code"]!, model("claude-code", "claude-haiku-4.1", "Fast and cheap.")], defaultRuntime: runtime, permissionModes: ["ask", "plan", "build"], supportsAuto: true })
  render(popover({ onDiscoverRuntime }))
  await user.click(screen.getByRole("button", { name: /claude-code · sonnet 4\.6/ }))
  await settle()
  await user.click(screen.getByRole("button", { name: "Ask the agents again" }))
  await settle()
  expect(onDiscoverRuntime.mock.calls.map(([provider]) => provider).sort()).toEqual(["aider", "claude-code", "codex"])
  const labels = screen.getAllByRole("option").map((row) => row.getAttribute("aria-label"))
  expect(labels).toContain("claude-haiku-4.1, claude-code")
  expect(labels).toContain("codex")
  expect(labels).not.toContain("aider")
  expect(screen.getByText("Sign in to codex on this machine.")).toBeTruthy()
})

// A harness the snapshot called missing that answers discovery with models
// has reported, and appears from that answer on.
it("shows a harness the snapshot called missing once discovery hears models from it", async () => {
  const user = userEvent.setup()
  const onDiscoverRuntime = vi.fn(async (provider: string): Promise<RuntimeDiscoverResult> => provider === "aider"
    ? { machineId: "machine-1", provider, status: "ready", models: [model("aider", "deepseek-v4", "Installed since the snapshot.")], defaultRuntime: runtime, permissionModes: ["ask", "plan", "build"], supportsAuto: true }
    : { machineId: "machine-1", provider, status: "ready", models: catalogs[provider] ?? [], defaultRuntime: runtime, permissionModes: ["ask", "plan", "build"], supportsAuto: true })
  render(popover({ onDiscoverRuntime }))
  await user.click(screen.getByRole("button", { name: /claude-code · sonnet 4\.6/ }))
  await settle()
  await user.click(screen.getByRole("button", { name: "Ask the agents again" }))
  await settle()
  expect(screen.getAllByRole("option").map((row) => row.getAttribute("aria-label"))).toContain("deepseek-v4, aider")
  expect(screen.getByRole("button", { name: "aider", pressed: false })).toBeTruthy()
  expect(screen.getByText("4 of 4 · 3 harnesses reported")).toBeTruthy()
})

it("asks before changing to another model, and switches here on that answer", async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  render(popover({ onChange }))
  await user.click(screen.getByRole("button", { name: /claude-code · sonnet 4\.6/ }))
  await settle()
  await user.click(screen.getByRole("option", { name: "gpt-5.3-codex, codex" }))
  expect(screen.getByRole("alertdialog")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Switch here" }))
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex", model: "gpt-5.3-codex" }))
})

// The daemon applies a same-harness model change from the next turn and
// refuses a harness change while a turn runs ("Stop the active turn before
// changing providers"). The footer says that, not the design's promise of a
// deferred change, and Switch here is held shut for the case the daemon
// refuses.
it("states what the daemon does with a change, and holds a harness switch shut during a turn", async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  render(popover({ onChange, turnRunning: true }))
  await user.click(screen.getByRole("button", { name: /claude-code · sonnet 4\.6/ }))
  await settle()
  expect(screen.getByText(/applies from the next turn/)).toBeTruthy()
  expect(screen.getByText(/needs the running turn stopped first/)).toBeTruthy()
  await user.click(screen.getByRole("option", { name: "gpt-5.3-codex, codex" }))
  const switchHere = screen.getByRole("button", { name: "Switch here" }) as HTMLButtonElement
  expect(switchHere.disabled).toBe(true)
  expect(switchHere.title).toMatch(/Stop the active turn/)
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  // The dialog sits outside the surface, so answering it closed the chip.
  await user.click(screen.getByRole("button", { name: /claude-code · sonnet 4\.6/ }))
  await settle()
  await user.click(screen.getByRole("option", { name: "claude-opus-4.2, claude-code" }))
  await user.click(screen.getByRole("button", { name: "Switch here" }))
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ provider: "claude-code", model: "claude-opus-4.2" }))
})

it("asks every harness again, so one that needed a sign-in can come back with models", async () => {
  const user = userEvent.setup()
  const signedOut: ProviderRuntime[] = [
    providers[0]!,
    { id: "codex", command: "codex", status: "auth-required", sessionCapable: true },
    providers[2]!,
  ]
  const onDiscoverRuntime = vi.fn(async (provider: string): Promise<RuntimeDiscoverResult> => provider === "aider"
    ? { machineId: "machine-1", provider, status: "unavailable", reason: "missing", action: "install", retryable: false, message: "aider is not installed." }
    : { machineId: "machine-1", provider, status: "ready", models: catalogs[provider]!, defaultRuntime: runtime, permissionModes: ["ask", "plan", "build"], supportsAuto: true })
  render(popover({ providers: signedOut, onDiscoverRuntime }))
  await user.click(screen.getByRole("button", { name: /claude-code · sonnet 4\.6/ }))
  await settle()
  expect(screen.getByText(/codex needs a sign-in on mac-mini-m4/)).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Ask the agents again" }))
  await settle()
  expect(onDiscoverRuntime.mock.calls.map(([provider]) => provider).sort()).toEqual(["aider", "claude-code", "codex"])
  expect(screen.getAllByRole("option").map((row) => row.getAttribute("aria-label"))).toContain("gpt-5.3-codex, codex")
  expect(screen.queryByText("aider is not installed.")).toBeNull()
})

it("counts matches against everything reported", () => {
  expect(modelCountText(3, 11, 5)).toBe("3 of 11 · 5 harnesses reported")
  expect(modelCountText(1, 1, 1)).toBe("1 of 1 · 1 harness reported")
})

it("locks the chip while a runtime update is pending", () => {
  render(popover({ pending: true }))
  expect((screen.getByRole("button", { name: /claude-code · sonnet 4\.6/ }) as HTMLButtonElement).disabled).toBe(true)
})
