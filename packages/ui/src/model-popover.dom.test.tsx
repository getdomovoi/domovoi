import type { ProviderModel, ProviderRuntime, Runtime, RuntimeDiscoverResult } from "@getdomovoi/protocol"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { ModelPopover, modelCountText } from "./model-popover"

afterEach(cleanup)

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

const runtime: Runtime = { provider: "claude", model: "claude-sonnet-4.6", reasoning: "medium", permissionMode: "build", auto: false }

const providers: ProviderRuntime[] = [
  { id: "claude", command: "claude", status: "ready", sessionCapable: true },
  { id: "codex", command: "codex", status: "ready", sessionCapable: true },
  { id: "aider", command: "aider", status: "missing", sessionCapable: true },
]

function model(provider: string, id: string, description: string, isDefault = false): ProviderModel {
  return { provider, id, displayName: id, description, supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium", isDefault }
}

const catalogs: Record<string, ProviderModel[]> = {
  claude: [model("claude", "claude-sonnet-4.6", "The default here.", true), model("claude", "claude-opus-4.2", "Slower and dearer.")],
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

// One flat list across every harness on the machine, the current model
// ticked, and the harness that cannot run here still listed, dimmed, with
// the reason, the way the design draws it.
it("lists every harness's models flat, ticks the current one, and names the harness that cannot run", async () => {
  const user = userEvent.setup()
  render(popover())
  await user.click(screen.getByRole("button", { name: /claude-sonnet-4\.6/ }))
  await settle()
  const rows = screen.getAllByRole("option")
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
    "claude-sonnet-4.6, claude", "claude-opus-4.2, claude", "gpt-5.3-codex, codex", "aider",
  ])
  expect(rows[0]!.getAttribute("aria-selected")).toBe("true")
  expect(within(rows[3]!).getByText(/aider is not installed on mac-mini-m4, so this cannot run here/)).toBeTruthy()
  expect((rows[3] as HTMLElement).getAttribute("aria-disabled")).toBe("true")
  expect(screen.getByText("3 of 3 · 3 harnesses")).toBeTruthy()
})

it("narrows by typed text and by a harness chip, and says when nothing matches", async () => {
  const user = userEvent.setup()
  render(popover())
  await user.click(screen.getByRole("button", { name: /claude-sonnet-4\.6/ }))
  await settle()
  await user.type(screen.getByRole("searchbox", { name: "Search models on this machine" }), "opus")
  expect(screen.getAllByRole("option").map((row) => row.getAttribute("aria-label"))).toEqual(["claude-opus-4.2, claude"])
  expect(screen.getByText("1 of 3 · 3 harnesses")).toBeTruthy()
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
    : { machineId: "machine-1", provider, status: "ready", models: [...catalogs.claude!, model("claude", "claude-haiku-4.1", "Fast and cheap.")], defaultRuntime: runtime, permissionModes: ["ask", "plan", "build"], supportsAuto: true })
  render(popover({ onDiscoverRuntime }))
  await user.click(screen.getByRole("button", { name: /claude-sonnet-4\.6/ }))
  await settle()
  await user.click(screen.getByRole("button", { name: "Ask the agents again" }))
  await settle()
  expect(onDiscoverRuntime.mock.calls.map(([provider]) => provider).sort()).toEqual(["claude", "codex"])
  const labels = screen.getAllByRole("option").map((row) => row.getAttribute("aria-label"))
  expect(labels).toContain("claude-haiku-4.1, claude")
  expect(labels).toContain("codex")
  expect(screen.getByText("Sign in to codex on this machine.")).toBeTruthy()
})

it("asks before changing to another model, and switches here on that answer", async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  render(popover({ onChange }))
  await user.click(screen.getByRole("button", { name: /claude-sonnet-4\.6/ }))
  await settle()
  await user.click(screen.getByRole("option", { name: "gpt-5.3-codex, codex" }))
  expect(screen.getByRole("alertdialog")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Switch here" }))
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex", model: "gpt-5.3-codex" }))
})

it("says a change lands at the next safe turn boundary", async () => {
  const user = userEvent.setup()
  render(popover())
  await user.click(screen.getByRole("button", { name: /claude-sonnet-4\.6/ }))
  await settle()
  expect(screen.getByText(/A change lands at the next safe turn boundary/)).toBeTruthy()
})

it("counts matches against everything reported", () => {
  expect(modelCountText(3, 11, 5)).toBe("3 of 11 · 5 harnesses")
  expect(modelCountText(1, 1, 1)).toBe("1 of 1 · 1 harness")
})

it("locks the chip while a runtime update is pending", () => {
  render(popover({ pending: true }))
  expect((screen.getByRole("button", { name: /claude-sonnet-4\.6/ }) as HTMLButtonElement).disabled).toBe(true)
})
