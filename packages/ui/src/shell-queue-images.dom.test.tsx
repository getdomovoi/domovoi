// The shell releases queued messages for every session, on screen or not. A
// message carrying images must not go to a model whose harness says it takes
// none: the daemon refuses it and nothing reaches the provider. Thread's own
// hold (#846) reaches only the session on screen, and only from the commit
// after the model's answer, so the release itself has to know.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { workspaceSnapshotSchema, type ProviderModel, type SessionAttachment, type WorkspaceSnapshot } from '@getdomovoi/protocol'
import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import { emptySessionDraft, sessionDraftStore } from "./session-draft"
import {
  completeHandshake, installFakeWebSocket, notify, respond, sentRequests, workspaceSnapshot,
  type FakeWebSocketHarness, type FakeWebSocket,
} from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness
beforeEach(() => {
  try { localStorage?.removeItem(workspaceUiStorageKey) } catch { /* a browser with site data blocked still runs the test */ }
  harness = installFakeWebSocket()
})
afterEach(() => {
  cleanup()
  harness?.uninstall()
  for (const session of workspaceSnapshot().sessions) sessionDraftStore.clear(session.id)
})

// Eight bytes, the PNG signature: enough for a chip and a send.
const image: SessionAttachment = { mimeType: "image/png", width: 2, height: 2, data: "iVBORw0KGgo=" }
const heldNotice = /Held because sonnet-4\.6 takes no image input/

function model(provider: string, id: string, imageInput: boolean | undefined): ProviderModel {
  return {
    provider,
    id,
    displayName: id,
    description: "",
    supportedReasoningEfforts: [],
    isDefault: false,
    ...(imageInput === undefined ? {} : { imageInput }),
  }
}

const settle = () => act(async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve()
})
function running() {
  const value = workspaceSnapshot()
  value.approvals = []
  value.artifacts = []
  value.annotations = []
  value.sessions.forEach(session => { session.activeTurnId = 'turn-' + session.id; session.state = 'active' })
  return workspaceSnapshotSchema.parse(value)
}
function idle(value: WorkspaceSnapshot, id = value.activeSessionId!) {
  const next = structuredClone(value)
  const session = next.sessions.find(session => session.id === id)!
  delete session.activeTurnId
  session.state = 'idle'
  return workspaceSnapshotSchema.parse(next)
}
function visible(value: WorkspaceSnapshot, id: string) {
  return workspaceSnapshotSchema.parse({ ...value, activeSessionId: id })
}
function withModel(value: WorkspaceSnapshot, modelId: string, id = value.activeSessionId!) {
  const next = structuredClone(value)
  next.sessions.find(session => session.id === id)!.runtime.model = modelId
  return workspaceSnapshotSchema.parse(next)
}
async function open(value: WorkspaceSnapshot) {
  render(<WorkspaceShell />)
  const socket = harness.sockets.at(-1)!
  await act(async () => completeHandshake(socket, value))
  await act(async () => {
    respond(socket, 'skill.list', [])
    const { id, name, platform, arch, version } = value.machine
    respond(socket, 'skill.inventory', { machine: { id, name, platform, arch, version }, skills: [] })
  })
  await settle()
  return socket
}
// Answers every catalog read still open, each with its own provider's models.
function answerModels(socket: FakeWebSocket, catalog: Readonly<Record<string, ProviderModel[]>>) {
  while (sentRequests(socket, 'runtime.models').some((request) => !socket.answered.has(request.id))) {
    const request = sentRequests(socket, 'runtime.models').find((candidate) => !socket.answered.has(candidate.id))!
    const provider = (request.params as { provider: string }).provider
    respond(socket, 'runtime.models', catalog[provider] ?? [])
  }
}
function queue(text: string) {
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
}
async function snapshot(socket: FakeWebSocket, value: WorkspaceSnapshot) {
  await act(async () => notify(socket, 'workspace.changed', value))
  await settle()
}
function withImageDraft(sessionId: string) {
  sessionDraftStore.write(sessionId, { ...emptySessionDraft, attachments: [image] })
}

const textOnly = { 'claude-code': [model('claude-code', 'sonnet-4.6', false)] }

it('holds an image message when the model answer lands in the commit that ends the turn', async () => {
  const value = running()
  withImageDraft(value.activeSessionId!)
  const socket = await open(value)
  queue('look at this')
  expect(screen.getByText('look at this')).toBeTruthy()

  // One act, one commit: the catalog answer and the idle snapshot together.
  await act(async () => {
    answerModels(socket, textOnly)
    notify(socket, 'workspace.changed', idle(value))
  })
  await settle()

  expect(sentRequests(socket, 'session.send')).toHaveLength(0)
  expect(screen.getByText(heldNotice)).toBeTruthy()
})

it('holds a background session\'s image message for a model that takes none', async () => {
  const value = running()
  const owner = value.activeSessionId!
  const other = value.sessions.find(session => session.id !== owner)!.id
  withImageDraft(owner)
  const socket = await open(value)
  queue('look at this')
  // The person moves on before any catalog read has answered.
  await snapshot(socket, visible(value, other))
  await act(async () => answerModels(socket, textOnly))
  await settle()
  await snapshot(socket, visible(idle(value, owner), other))

  expect(sentRequests(socket, 'session.send')).toHaveLength(0)
  // Coming back shows it still queued, with the same notice.
  await snapshot(socket, idle(value, owner))
  expect(screen.getByText('look at this')).toBeTruthy()
  expect(screen.getByText(heldNotice)).toBeTruthy()
})

it('releases an image message when the harness has not said whether the model takes images', async () => {
  const value = running()
  withImageDraft(value.activeSessionId!)
  const socket = await open(value)
  queue('look at this')
  await act(async () => answerModels(socket, { 'claude-code': [model('claude-code', 'sonnet-4.6', undefined)] }))
  await settle()
  await snapshot(socket, idle(value))

  const sends = sentRequests(socket, 'session.send')
  expect(sends).toHaveLength(1)
  expect(sends[0]?.params).toMatchObject({ sessionId: value.activeSessionId, prompt: 'look at this', attachments: [image] })
})

it('waits for the catalog when the turn ends first, then sends once it answers', async () => {
  const value = running()
  withImageDraft(value.activeSessionId!)
  const socket = await open(value)
  queue('look at this')
  await snapshot(socket, idle(value))
  expect(sentRequests(socket, 'session.send')).toHaveLength(0)
  expect(screen.queryByText(heldNotice)).toBeNull()

  await act(async () => answerModels(socket, { 'claude-code': [model('claude-code', 'sonnet-4.6', true)] }))
  await settle()
  await snapshot(socket, idle(value))
  expect(sentRequests(socket, 'session.send')).toHaveLength(1)
})

it('sends a held image message exactly once after the model changes to one that takes images', async () => {
  const value = running()
  withImageDraft(value.activeSessionId!)
  const socket = await open(value)
  const catalog = { 'claude-code': [model('claude-code', 'sonnet-4.6', false), model('claude-code', 'opus-4.6', true)] }
  queue('look at this')
  await act(async () => {
    answerModels(socket, catalog)
    notify(socket, 'workspace.changed', idle(value))
  })
  await settle()
  expect(sentRequests(socket, 'session.send')).toHaveLength(0)

  const switched = withModel(idle(value), 'opus-4.6')
  await snapshot(socket, switched)
  await act(async () => answerModels(socket, catalog))
  await settle()
  const row = screen.getByText('look at this').parentElement!
  await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Send' })) })
  await act(async () => answerModels(socket, catalog))
  await settle()
  await snapshot(socket, switched)
  await act(async () => answerModels(socket, catalog))
  await settle()

  const sends = sentRequests(socket, 'session.send')
  expect(sends).toHaveLength(1)
  expect(sends[0]?.params).toMatchObject({ prompt: 'look at this', attachments: [image] })
})

it('releases a text-only message without waiting on any catalog read', async () => {
  const value = running()
  const socket = await open(value)
  queue('no pictures here')
  await snapshot(socket, idle(value))

  const sends = sentRequests(socket, 'session.send')
  expect(sends).toHaveLength(1)
  expect(sends[0]?.params).toMatchObject({ prompt: 'no pictures here' })
})
