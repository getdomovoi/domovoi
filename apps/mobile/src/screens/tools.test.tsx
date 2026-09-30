import { describe, expect, it, jest } from "@jest/globals"
import { toolInventorySchema, type ToolInventory } from "@getdomovoi/protocol"
import { fireEvent, render, screen, within } from "@testing-library/react-native"
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context"

import { ToolsScreen, type ToolsLoad } from "./tools"

const digest = `sha256:${"a".repeat(64)}`

function inventory(): ToolInventory {
  return toolInventorySchema.parse({
    machine: { id: "machine-studio", name: "studio", platform: "darwin", arch: "arm64", version: "0.9.4" },
    repository: { projectId: "project-acme", root: "/Users/ada/src/acme-api", configDigest: digest, trust: { state: "untrusted", reason: "not-trusted" } },
    providers: [
      {
        provider: "claude-code",
        toolServers: "read-from-files",
        omittedEntries: 0,
        files: [
          { path: ".mcp.json", source: "repository-file", state: "read" },
          { path: ".claude/settings.json", source: "project-settings", state: "read" },
        ],
        entries: [
          { kind: "tool-server", name: "postgres-dev", transport: "stdio", command: "npx -y @acme/pg-mcp", envKeys: ["PGHOST"], file: ".mcp.json", startsAtSessionStart: true, heldBack: true },
          { kind: "hook", event: "PreToolUse", matcher: "Bash", command: "./scripts/guard-prod.sh", file: ".claude/settings.json", startsAtSessionStart: false, heldBack: true },
          { kind: "env-key", key: "ACME_ENV", file: ".claude/settings.json", startsAtSessionStart: true, heldBack: true },
          { kind: "env-key", key: "DATABASE_URL", file: ".claude/settings.json", startsAtSessionStart: true, heldBack: true },
        ],
      },
    ],
  })
}

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
}

async function draw(load: ToolsLoad, overrides: Partial<Parameters<typeof ToolsScreen>[0]> = {}) {
  const props = {
    load,
    machine: "studio",
    notice: undefined,
    connected: true,
    onBack: jest.fn<() => void>(),
    onRefresh: jest.fn<() => void>(),
    ...overrides,
  }
  await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <ToolsScreen {...props} />
    </SafeAreaProvider>,
  )
  return props
}

describe("ToolsScreen", () => {
  it("shows every held-back entry under the file that declared it, with the reason", async () => {
    await draw({ state: "loaded", inventory: inventory() })
    expect(screen.getByText("acme-api is held back on studio")).toBeOnTheScreen()
    expect(screen.getByText("None of it loads for any agent.")).toBeOnTheScreen()
    // Repository instructions are not blocked by trust, and the summary says so.
    expect(screen.getByText("Instruction files load either way:")).toBeOnTheScreen()
    expect(screen.getByText("CLAUDE.md · AGENTS.md")).toBeOnTheScreen()

    const mcp = screen.getByLabelText(".mcp.json")
    expect(within(mcp).getByText("postgres-dev")).toBeOnTheScreen()
    expect(within(mcp).getByText("stdio · npx -y @acme/pg-mcp · env keys PGHOST, values not read")).toBeOnTheScreen()
    expect(within(mcp).getByText("Held back until you trust this repository.")).toBeOnTheScreen()

    const settings = screen.getByLabelText(".claude/settings.json")
    expect(within(settings).getByText("PreToolUse · Bash")).toBeOnTheScreen()
    expect(within(settings).getByText("./scripts/guard-prod.sh")).toBeOnTheScreen()
    expect(within(settings).getByText("ACME_ENV · DATABASE_URL")).toBeOnTheScreen()
    expect(within(settings).getByText("Held back until you trust this repository.")).toBeOnTheScreen()
  })

  it("says trust is granted from desktop or web and offers no way to grant it here", async () => {
    await draw({ state: "loaded", inventory: inventory() })
    expect(screen.getByText("Trust from desktop or web")).toBeOnTheScreen()
    expect(screen.getByText("A phone shows this but cannot trust it.")).toBeOnTheScreen()
    const labels = screen.queryAllByRole("button").map((button) => button.props.accessibilityLabel as string | undefined)
    expect(labels.filter((label) => label !== undefined && /trust/i.test(label))).toEqual([])
    expect(screen.queryByText(/^Trust for this machine$/)).toBeNull()
  })

  // Before a trust state is known, or after a read failed, trusting is not
  // the remedy, so the bar does not offer it.
  it("does not point at desktop or web while reading or after a failed read", async () => {
    await draw({ state: "loading" })
    expect(screen.queryByText("Trust from desktop or web")).toBeNull()
    expect(screen.getByText("A phone shows this but cannot trust it.")).toBeOnTheScreen()
    await draw({ state: "error", message: "The daemon did not answer" })
    expect(screen.queryByText("Trust from desktop or web")).toBeNull()
    await draw({ state: "loaded", inventory: toolInventorySchema.parse({ machine: inventory().machine, providers: [] }) })
    expect(screen.queryByText("Trust from desktop or web")).toBeNull()
  })

  it("does not point at desktop or web when trust cannot lift the hold", async () => {
    const refused = inventory()
    refused.repository!.trust = { state: "untrusted", reason: "cannot-trust", refusals: [{ provider: "codex", code: "nested-config", path: "services/api/.codex" }], omittedRefusals: 0 }
    await draw({ state: "loaded", inventory: refused })
    expect(screen.getByText("acme-api cannot be trusted on this machine")).toBeOnTheScreen()
    expect(screen.getByText("Agent configuration below the repository root")).toBeOnTheScreen()
    expect(screen.getByText("services/api/.codex")).toBeOnTheScreen()
    expect(screen.queryByText("Trust from desktop or web")).toBeNull()
    expect(screen.getByText("A phone shows this but cannot trust it.")).toBeOnTheScreen()
  })

  it("names a file it could not read and says the list is not complete", async () => {
    const cut = inventory()
    cut.providers[0]!.files.push({ path: ".claude/hooks.json", source: "project-settings", state: "unreadable", reason: "EACCES" })
    await draw({ state: "loaded", inventory: cut })
    expect(screen.getByText("This list is not complete: 1 file could not be read.")).toBeOnTheScreen()
    expect(screen.getByText(".claude/hooks.json")).toBeOnTheScreen()
    expect(screen.getByText("EACCES")).toBeOnTheScreen()
  })

  it("says what it is doing while it reads, and why it could not", async () => {
    await draw({ state: "loading" })
    expect(screen.getByText("Reading the agents' files on studio.")).toBeOnTheScreen()

    const { onRefresh } = await draw({ state: "error", message: "The daemon did not answer" })
    expect(screen.getByText("Tools could not be read")).toBeOnTheScreen()
    expect(screen.getByText("The daemon did not answer")).toBeOnTheScreen()
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it("says when no project is open", async () => {
    await draw({ state: "loaded", inventory: toolInventorySchema.parse({ machine: inventory().machine, providers: [] }) })
    expect(screen.getByText("No project is open")).toBeOnTheScreen()
  })

  it("goes back and reads again on request", async () => {
    const { onBack, onRefresh } = await draw({ state: "loaded", inventory: inventory() })
    await fireEvent.press(screen.getByRole("button", { name: "Back" }))
    await fireEvent.press(screen.getByRole("button", { name: "Refresh" }))
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })
})
