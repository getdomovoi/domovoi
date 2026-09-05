import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { SkillInventory, WorkspaceSnapshot } from "@getdomovoi/protocol"

import { DomovoiClient } from "./client"
import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake,
  installFakeWebSocket,
  notify,
  respond,
  sentRequests,
  workspaceSnapshot,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

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
  vi.restoreAllMocks()
})

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

function inventoryFor(snapshot: WorkspaceSnapshot): SkillInventory {
  const { id, name, platform, arch, version } = snapshot.machine
  return { machine: { id, name, platform, arch, version }, skills: [] }
}

function withThreadNote(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  const updated = structuredClone(snapshot)
  updated.thread.push({
    id: "unrelated-thread-update",
    sessionId: updated.activeSessionId!,
    kind: "system",
    body: "Unrelated workspace update",
    createdAt: "2026-08-30T12:00:00.000Z",
  })
  return updated
}

function withProject(snapshot: WorkspaceSnapshot, path: string): WorkspaceSnapshot {
  const updated = structuredClone(snapshot)
  const id = `project-${path}`
  updated.project = { ...updated.project!, id, path }
  updated.sessions = updated.sessions.map((session) => ({ ...session, projectId: id }))
  return updated
}

async function openWorkspace(snapshot = workspaceSnapshot()) {
  render(<WorkspaceShell />)
  const socket = harness.socket(0)
  await act(async () => {
    completeHandshake(socket, snapshot)
  })
  await settle()
  return socket
}

describe("workspace skill catalog refresh", () => {
  it("asks for the catalog once when the project opens", async () => {
    const socket = await openWorkspace()
    expect(sentRequests(socket, "skill.list")).toHaveLength(1)
    expect(sentRequests(socket, "skill.inventory")).toHaveLength(1)
  })

  it("keeps the catalog through a workspace change that did not touch skills", async () => {
    const snapshot = workspaceSnapshot()
    const socket = await openWorkspace(snapshot)
    await act(async () => {
      respond(socket, "skill.list", [])
      respond(socket, "skill.inventory", inventoryFor(snapshot))
    })
    await settle()

    await act(async () => {
      notify(socket, "workspace.changed", withThreadNote(snapshot))
    })
    await settle()

    expect(sentRequests(socket, "skill.list")).toHaveLength(1)
    expect(sentRequests(socket, "skill.inventory")).toHaveLength(1)
  })

  it("keeps the catalog while moving between surfaces with a project open", async () => {
    const user = userEvent.setup()
    const snapshot = workspaceSnapshot()
    const socket = await openWorkspace(snapshot)
    await act(async () => {
      respond(socket, "skill.list", [])
      respond(socket, "skill.inventory", inventoryFor(snapshot))
    })
    await settle()

    await user.click(screen.getByRole("button", { name: "Settings" }))
    await settle()
    await user.click(screen.getByRole("button", { name: "Sessions" }))
    await settle()

    expect(sentRequests(socket, "skill.list")).toHaveLength(1)
  })

  it("asks again when the project changes", async () => {
    const snapshot = workspaceSnapshot()
    const socket = await openWorkspace(snapshot)
    await act(async () => {
      respond(socket, "skill.list", [])
      respond(socket, "skill.inventory", inventoryFor(snapshot))
    })
    await settle()

    await act(async () => {
      notify(socket, "workspace.changed", withProject(snapshot, "/Users/dev/src/other-api"))
    })
    await settle()

    expect(sentRequests(socket, "skill.list")).toHaveLength(2)
  })

  it("cancels a refresh the project change made obsolete and ignores its late answer", async () => {
    const listSkills = vi.spyOn(DomovoiClient.prototype, "listSkills")
    const snapshot = workspaceSnapshot()
    const socket = await openWorkspace(snapshot)
    expect(listSkills).toHaveBeenCalledOnce()

    await act(async () => {
      notify(socket, "workspace.changed", withProject(snapshot, "/Users/dev/src/other-api"))
    })
    await settle()
    expect(sentRequests(socket, "skill.list")).toHaveLength(2)
    expect(listSkills.mock.calls[0]?.[0]?.signal?.aborted).toBe(true)
    expect(listSkills.mock.calls[1]?.[0]?.signal?.aborted).toBe(false)

    await act(async () => {
      respond(socket, "skill.list", [])
    })
    await settle()
    expect(screen.queryByText(/out of date with the daemon/)).toBeNull()
  })
})
