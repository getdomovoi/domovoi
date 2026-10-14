// A queued message on a session whose turn has ended is the next thing to go.
// The release can still be waiting, on the skill catalog (#832) or on its own
// catalog read for a message with images (#850). A message sent past it
// reaches the daemon first, and the daemon does not refuse a send while a turn
// runs, so the order the person wrote them in would invert. Send stays off
// until the waiting message has left; the new draft stays in the composer.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { skillSummarySchema, workspaceSnapshotSchema, type ProviderModel, type SessionAttachment, type SkillSummary, type WorkspaceSnapshot } from '@getdomovoi/protocol'
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

const image: SessionAttachment = { mimeType: "image/png", width: 2, height: 2, data: "iVBORw0KGgo=" }
const waitLine = 'The queued message sends first'
const heldNotice = /Held because sonnet-4\.6 takes no image input/

function model(provider: string, id: string, imageInput: boolean | undefined): ProviderModel {
  return {
    provider, id, displayName: id, description: "", supportedReasoningEfforts: [], isDefault: false,
    ...(imageInput === undefined ? {} : { imageInput }),
  }
}
const takesImages = { 'claude-code': [model('claude-code', 'sonnet-4.6', true)] }
const textOnly = { 'claude-code': [model('claude-code', 'sonnet-4.6', false)] }

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
function onOtherBranch(value: WorkspaceSnapshot) {
  return workspaceSnapshotSchema.parse({ ...value, project: { ...value.project!, branch: 'other-branch' } })
}
function skill(character: string, name: string) {
  return skillSummarySchema.parse({
    id: `skill-${character.repeat(12)}`, name, description: `${name} instructions`, path: `/skills/${name}/SKILL.md`,
    scope: 'user', source: 'agents', manifest: { version: 1, capabilities: ['filesystem.read'] },
    contentDigest: `sha256:${character.repeat(64)}`, signature: { state: 'unsigned' }, trust: { state: 'untrusted', reason: 'unsigned' },
  })
}
function withSkills(value: WorkspaceSnapshot, skills: SkillSummary[]) {
  return workspaceSnapshotSchema.parse({ ...value, skillEnablements: skills.map(item => ({
    projectId: value.project!.id, skillId: item.id, enabled: true, contentDigest: item.contentDigest,
    manifest: item.manifest, reviewedAt: '2026-09-08T12:00:00Z', reviewedBy: { client: 'desktop' },
  })) })
}
async function loadCatalog(socket: FakeWebSocket, value: WorkspaceSnapshot, skills: SkillSummary[] = []) {
  await act(async () => {
    respond(socket, 'skill.list', skills)
    const { id, name, platform, arch, version } = value.machine
    respond(socket, 'skill.inventory', { machine: { id, name, platform, arch, version }, skills: [] })
  })
}
async function open(value: WorkspaceSnapshot, skills: SkillSummary[] = []) {
  render(<WorkspaceShell />)
  const socket = harness.sockets.at(-1)!
  await act(async () => completeHandshake(socket, value))
  await loadCatalog(socket, value, skills)
  await settle()
  return socket
}
function answerModels(socket: FakeWebSocket, catalog: Readonly<Record<string, ProviderModel[]>>) {
  while (sentRequests(socket, 'runtime.models').some((request) => !socket.answered.has(request.id))) {
    const request = sentRequests(socket, 'runtime.models').find((candidate) => !socket.answered.has(candidate.id))!
    const provider = (request.params as { provider: string }).provider
    respond(socket, 'runtime.models', catalog[provider] ?? [])
  }
}
function failModels(socket: FakeWebSocket) {
  for (const request of sentRequests(socket, 'runtime.models').filter((candidate) => !socket.answered.has(candidate.id))) {
    socket.answered.add(request.id)
    socket.receive({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'catalog unavailable' } })
  }
}
const field = () => screen.getByLabelText('Message') as HTMLTextAreaElement
const sendButton = () => screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement
function type(text: string) {
  fireEvent.change(field(), { target: { value: text } })
}
function queue(text: string) {
  type(text)
  fireEvent.click(sendButton())
}
async function pressEnter() {
  fireEvent.keyDown(field(), { key: 'Enter' })
  await settle()
}
async function snapshot(socket: FakeWebSocket, value: WorkspaceSnapshot) {
  await act(async () => notify(socket, 'workspace.changed', value))
  await settle()
}
const sends = (sockets: readonly FakeWebSocket[] = harness.sockets) => sockets.flatMap((socket) => sentRequests(socket, 'session.send'))
const prompts = () => sends().map((request) => (request.params as { prompt: string }).prompt)
function withImageDraft(sessionId: string) {
  sessionDraftStore.write(sessionId, { ...emptySessionDraft, attachments: [image] })
}

// The person tries both ways a composer sends: the control and Enter.
async function expectHeldBack(draft: string) {
  type(draft)
  expect(sendButton().disabled).toBe(true)
  expect(screen.getByText(waitLine)).toBeTruthy()
  await pressEnter()
  expect(field().value).toBe(draft)
}

it('keeps a new message behind one waiting for the skill catalog, then sends it once, after', async () => {
  const skills = [skill('a', 'alpha'), skill('b', 'beta')]
  const value = withSkills(running(), skills)
  const socket = await open(value, skills)
  queue('/skill alpha')
  queue('alpha only')
  // The turn ends in the snapshot that moves the branch, so the release waits
  // for the refreshed catalog.
  const moved = onOtherBranch(idle(value))
  await snapshot(socket, moved)
  expect(sends()).toHaveLength(0)

  await expectHeldBack('the second one')
  expect(sends()).toHaveLength(0)

  await loadCatalog(socket, moved, skills)
  await settle()
  expect(prompts()).toEqual(['alpha only'])
  expect(screen.queryByText(waitLine)).toBeNull()
  expect(sendButton().disabled).toBe(false)
  await pressEnter()
  await snapshot(socket, moved)
  expect(prompts()).toEqual(['alpha only', 'the second one'])
})

it('keeps a new message behind an image message waiting for the release\'s catalog read, then sends it once, after', async () => {
  const value = running()
  withImageDraft(value.activeSessionId!)
  const socket = await open(value)
  queue('look at this')
  await snapshot(socket, idle(value))
  expect(sends()).toHaveLength(0)

  await expectHeldBack('and this too')
  // The larger editor is the same draft and the same rule.
  fireEvent.click(screen.getByRole('button', { name: 'Expand prompt editor' }))
  const editor = await screen.findByRole('dialog')
  expect((within(editor).getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(within(editor).getByRole('button', { name: 'Keep as draft' }))
  await settle()
  expect(sends()).toHaveLength(0)

  await act(async () => answerModels(socket, takesImages))
  await settle()
  await snapshot(socket, idle(value))
  expect(prompts()).toEqual(['look at this'])
  expect(sendButton().disabled).toBe(false)
  await pressEnter()
  await snapshot(socket, idle(value))
  expect(prompts()).toEqual(['look at this', 'and this too'])
  expect(sends()[1]?.params).not.toHaveProperty('attachments')
})

// A read that fails, or times out (the client rejects the request at its
// budget), settles the release's wait the same way: nothing holds on what is
// not known.
it('ends the wait when the release\'s catalog read fails', async () => {
  const value = running()
  withImageDraft(value.activeSessionId!)
  const socket = await open(value)
  queue('look at this')
  await snapshot(socket, idle(value))
  await expectHeldBack('and this too')

  await act(async () => failModels(socket))
  await settle()
  await snapshot(socket, idle(value))
  expect(prompts()).toEqual(['look at this'])
  expect(sendButton().disabled).toBe(false)
  await pressEnter()
  expect(prompts()).toEqual(['look at this', 'and this too'])
})

it('does not hold a new message behind a held one, which only the person sends', async () => {
  const value = running()
  withImageDraft(value.activeSessionId!)
  const socket = await open(value)
  queue('look at this')
  await act(async () => {
    answerModels(socket, textOnly)
    notify(socket, 'workspace.changed', idle(value))
  })
  await settle()
  expect(screen.getByText(heldNotice)).toBeTruthy()

  type('no pictures this time')
  expect(sendButton().disabled).toBe(false)
  expect(screen.queryByText(waitLine)).toBeNull()
  fireEvent.click(sendButton())
  await settle()
  expect(prompts()).toEqual(['no pictures this time'])
  expect(screen.getByText(heldNotice)).toBeTruthy()
})

it('does not hold another session\'s send behind a background session\'s waiting message', async () => {
  const value = running()
  const owner = value.activeSessionId!
  const other = value.sessions.find(session => session.id !== owner)!.id
  withImageDraft(owner)
  const socket = await open(value)
  queue('look at this')
  const bothIdle = idle(idle(value, owner), other)
  await snapshot(socket, visible(bothIdle, other))
  expect(sends()).toHaveLength(0)

  type('for the other session')
  expect(sendButton().disabled).toBe(false)
  expect(screen.queryByText(waitLine)).toBeNull()
  fireEvent.click(sendButton())
  await settle()
  expect(sends().map((request) => request.params)).toEqual([expect.objectContaining({ sessionId: other, prompt: 'for the other session' })])

  // Back on the session whose message is still waiting, the rule applies.
  await snapshot(socket, visible(bothIdle, owner))
  await expectHeldBack('for the owner')
  expect(sends()).toHaveLength(1)
})

it('sends at once on an idle session with nothing queued', async () => {
  const value = idle(running())
  await open(value)
  type('straight away')
  expect(sendButton().disabled).toBe(false)
  expect(screen.queryByText(waitLine)).toBeNull()
  fireEvent.click(sendButton())
  await settle()
  expect(prompts()).toEqual(['straight away'])
})

it('lets the person unqueue the waiting message to send the new one now', async () => {
  const value = running()
  withImageDraft(value.activeSessionId!)
  const socket = await open(value)
  queue('look at this')
  await snapshot(socket, idle(value))
  await expectHeldBack('send this instead')

  fireEvent.click(screen.getByRole('button', { name: 'Unqueue the message' }))
  await settle()
  expect(sendButton().disabled).toBe(false)
  expect(screen.queryByText(waitLine)).toBeNull()
  await pressEnter()
  expect(prompts()).toEqual(['send this instead'])
})

// #832 stopped phone and tablet tabs reading skill.inventory. Their catalog
// still counts as loaded once skill.list answers, so the wait ends there too.
it.each(['phone', 'tablet'] as const)('a %s tab ends the skill catalog wait once skill.list answers', async (clientKind) => {
  const skills = [skill('a', 'alpha'), skill('b', 'beta')]
  const value = withSkills(running(), skills)
  render(<WorkspaceShell clientKind={clientKind} />)
  const socket = harness.sockets.at(-1)!
  await act(async () => completeHandshake(socket, value))
  await act(async () => { respond(socket, 'skill.list', skills) })
  await settle()
  queue('/skill alpha')
  queue('alpha only')
  const moved = onOtherBranch(idle(value))
  await snapshot(socket, moved)
  expect(sends()).toHaveLength(0)
  await expectHeldBack('the second one')

  await act(async () => { respond(socket, 'skill.list', skills) })
  await settle()
  expect(sentRequests(socket, 'skill.inventory')).toEqual([])
  expect(prompts()).toEqual(['alpha only'])
  expect(sendButton().disabled).toBe(false)
  await pressEnter()
  expect(prompts()).toEqual(['alpha only', 'the second one'])
})

// Offline, Send is off because nothing leaves the composer, and the wait line
// does not speak for a card that says nothing live. After the reconnect the
// release reads again on the new connection, and the wait ends on that answer.
it('is off for the offline reason while the link is down, and the wait ends after the reconnect', async () => {
  const value = running()
  withImageDraft(value.activeSessionId!)
  render(<WorkspaceShell />)
  const first = harness.socket(0)
  // The daemon names each connection, and a read on the old one says nothing
  // about the new one.
  await act(async () => completeHandshake(first, { ...value, connectionId: '11111111-1111-4111-8111-111111111111' }))
  await loadCatalog(first, value)
  await settle()
  queue('look at this')
  await snapshot(first, idle(value))
  await expectHeldBack('and this too')

  await act(async () => first.drop())
  await settle()
  expect(sendButton().disabled).toBe(true)
  expect(screen.queryByText(waitLine)).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Retry now' }))
  await settle()
  const second = harness.sockets.at(-1)!
  expect(second).not.toBe(first)
  await act(async () => completeHandshake(second, { ...idle(value), connectionId: '22222222-2222-4222-8222-222222222222' }))
  await loadCatalog(second, value)
  await settle()
  expect(sends()).toHaveLength(0)
  expect(sendButton().disabled).toBe(true)
  expect(screen.getByText(waitLine)).toBeTruthy()

  await act(async () => answerModels(second, takesImages))
  await settle()
  await snapshot(second, idle(value))
  expect(prompts()).toEqual(['look at this'])
  expect(sendButton().disabled).toBe(false)
  await pressEnter()
  expect(prompts()).toEqual(['look at this', 'and this too'])
})
