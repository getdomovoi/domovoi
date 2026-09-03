import { describe, expect, it, vi } from "vitest"

import type { FleetMachine, WorkspaceSnapshot } from "@getdomovoi/protocol"

import { buildWorkspaceCommands, rankWorkspaceCommands } from "./command-palette"

type Session = WorkspaceSnapshot["sessions"][number]

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-billing",
    title: "Migrate billing webhooks to idempotent handlers",
    state: "waiting",
    runtime: {
      provider: "claude-code",
      model: "sonnet",
      reasoning: "high",
      permissionMode: "build",
      auto: false,
    },
    ...overrides,
  } as Session
}

function machine(overrides: Partial<FleetMachine> = {}): FleetMachine {
  return {
    id: "machine-hetzner",
    label: "hetzner-cx42",
    platform: "linux",
    arch: "x64",
    version: "0.1.0",
    connection: "tailnet",
    capabilities: ["sessions", "skills"],
    protocolVersion: "0.1.0",
    transports: [{ kind: "tailnet", endpoint: "wss://hetzner:47831/rpc" }],
    heartbeat: { state: "online", lastSeenAt: new Date().toISOString() },
    health: "online",
    self: false,
    ...overrides,
  } as FleetMachine
}

const base = {
  connected: true,
  emergencyStopPending: false,
  hasProject: true,
  openProject: vi.fn(),
  newSession: vi.fn(),
  pauseAll: vi.fn(),
  reconnect: vi.fn(),
  setSurface: vi.fn(),
}

describe("launcher entries", () => {
  it("offers nothing extra when the shell supplies no openers", () => {
    const commands = buildWorkspaceCommands(base)
    expect(commands.some((command) => ["Sessions", "Machines", "Skills"].includes(command.section)))
      .toBe(false)
  })

  it("lists each session with its state and opens it", () => {
    const activateSession = vi.fn()
    const commands = buildWorkspaceCommands({
      ...base,
      sessions: [session(), session({ id: "session-grok", title: "Parse crash logs", state: "idle" })],
      activateSession,
    })
    const entries = commands.filter((command) => command.section === "Sessions")
    expect(entries.map((entry) => entry.label)).toEqual([
      "Migrate billing webhooks to idempotent handlers",
      "Parse crash logs",
    ])
    expect(entries[0]?.detail).toBe("waiting")
    entries[1]?.run()
    expect(activateSession).toHaveBeenCalledWith("session-grok")
  })

  it("finds a session by its model or provider as well as its title", () => {
    const commands = buildWorkspaceCommands({
      ...base,
      sessions: [session()],
      activateSession: vi.fn(),
    })
    expect(rankWorkspaceCommands(commands, "sonnet").map((command) => command.id))
      .toContain("session-session-billing")
  })

  it("lists machines, names this one, and selects the machine it names", () => {
    const selectMachine = vi.fn()
    const commands = buildWorkspaceCommands({
      ...base,
      machines: [machine({ id: "machine-self", label: "studio-arch", self: true }), machine()],
      selectMachine,
    })
    const entries = commands.filter((command) => command.section === "Machines")
    expect(entries.map((entry) => entry.detail)).toEqual(["this machine", "tailnet"])
    entries[1]?.run()
    expect(selectMachine).toHaveBeenCalledWith("machine-hetzner")
  })

  it("disables a machine the switcher would refuse for the same reason", () => {
    const commands = buildWorkspaceCommands({
      ...base,
      machines: [machine({ health: "upgrade-required" }), machine({ id: "machine-b", label: "b", transports: [] })],
      selectMachine: vi.fn(),
    })
    expect(commands.filter((command) => command.section === "Machines").map((entry) => entry.disabled))
      .toEqual([true, true])
  })

  it("keeps this machine selectable even when its health is unknown", () => {
    const commands = buildWorkspaceCommands({
      ...base,
      machines: [machine({ id: "machine-self", label: "studio-arch", self: true, health: "unreachable" })],
      selectMachine: vi.fn(),
    })
    expect(commands.find((command) => command.section === "Machines")?.disabled).toBe(false)
  })

  it("lists skills with their scope and opens the one it names", () => {
    const openSkill = vi.fn()
    const commands = buildWorkspaceCommands({
      ...base,
      skills: [{ id: "skill-design-studio", name: "design-studio", scope: "user" }],
      openSkill,
    })
    const entry = commands.find((command) => command.section === "Skills")
    expect(entry?.label).toBe("design-studio")
    expect(entry?.detail).toBe("user")
    entry?.run()
    expect(openSkill).toHaveBeenCalledWith("skill-design-studio")
  })

  it("keeps the fixed commands ahead of the objects it lists", () => {
    const commands = buildWorkspaceCommands({
      ...base,
      sessions: [session()],
      machines: [machine()],
      skills: [{ id: "skill-a", name: "alpha", scope: "project" }],
      activateSession: vi.fn(),
      selectMachine: vi.fn(),
      openSkill: vi.fn(),
    })
    expect(commands[0]?.id).toBe("open-project")
    expect(commands.filter((command) => command.section === "Sessions")).toHaveLength(1)
    expect(commands.filter((command) => command.section === "Machines")).toHaveLength(1)
    expect(commands.filter((command) => command.section === "Skills")).toHaveLength(1)
  })
})
