// The shell owns the queue and its release, so the queue's real behaviour
// only shows through the shell: a live client, a fake socket and the daemon's
// own notifications. Adapted from the probes Codex wrote reviewing #352.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { workspaceSnapshotSchema, systemEmergencyStoppedNotificationSchema, skillSummarySchema, type SkillSummary, type WorkspaceSnapshot } from '@getdomovoi/protocol'
import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake, installFakeWebSocket, notify, respond, fail, sentRequests, workspaceSnapshot,
  type FakeWebSocketHarness, type FakeWebSocket,
} from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness
beforeEach(() => {
  try { localStorage?.removeItem(workspaceUiStorageKey) } catch { /* a browser with site data blocked still runs the test */ }
  harness = installFakeWebSocket()
})
afterEach(() => { cleanup(); harness?.uninstall() })

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
async function open(value = running(), strict = false, skills: SkillSummary[] = [], loadSkills = true) {
  render(strict ? <StrictMode><WorkspaceShell /></StrictMode> : <WorkspaceShell />)
  const socket = harness.sockets.at(-1)!
  await act(async () => completeHandshake(socket, value))
  if (loadSkills) await loadCatalog(socket, value, skills)
  await settle()
  return socket
}
async function loadCatalog(socket: FakeWebSocket, value: WorkspaceSnapshot, skills: SkillSummary[]) {
  await act(async () => {
    respond(socket, 'skill.list', skills)
    const { id, name, platform, arch, version } = value.machine
    respond(socket, 'skill.inventory', { machine: { id, name, platform, arch, version }, skills: [] })
  })
}
function queue(text: string) {
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
}
async function snapshot(socket: FakeWebSocket, value: WorkspaceSnapshot) {
  workspaceSnapshotSchema.parse(value)
  await act(async () => notify(socket, 'workspace.changed', value))
  await settle()
}
function stopResult(value: WorkspaceSnapshot) {
  return systemEmergencyStoppedNotificationSchema.parse({
    snapshot: value, stopId: 'stop-other-client', requestedAt: '2026-09-08T14:00:00Z', client: 'phone',
    outcomes: { turnsStopped: 1, terminalsClosed: 0, approvalsDenied: 0, mutationsCancelled: 0, providersReset: 0 }, failures: [],
  })
}

it('composer Stop holds the queue before its idle RPC response', async () => {
  const value = running()
  const socket = await open(value)
  queue('remain stopped')
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  await act(async () => respond(socket, 'session.pause', idle(value)))
  await settle()
  expect(sentRequests(socket, 'session.send')).toHaveLength(0)
  expect(screen.getByText(/Held because this session was stopped/)).toBeTruthy()
})

it('retains queues for A and B independently', async () => {
  const value = running()
  const socket = await open(value)
  const other = value.sessions.find(session => session.id !== value.activeSessionId)!.id
  queue('instruction A')
  await snapshot(socket, visible(value, other))
  queue('instruction B')
  await snapshot(socket, value)
  expect(screen.getByText('instruction A')).toBeTruthy()
  await snapshot(socket, visible(value, other))
  expect(screen.getByText('instruction B')).toBeTruthy()
})

it('sends A when A ends while B stays visible', async () => {
  const value = running()
  const socket = await open(value)
  const other = value.sessions.find(session => session.id !== value.activeSessionId)!.id
  queue('deliver for A')
  await snapshot(socket, visible(value, other))
  await snapshot(socket, visible(idle(value), other))
  expect(sentRequests(socket, 'session.send')).toHaveLength(1)
  expect(sentRequests(socket, 'session.send')[0]?.params).toMatchObject({ sessionId: value.activeSessionId, prompt: 'deliver for A' })
})

it('refusal retains the message without automatic retry', async () => {
  const value = running()
  const socket = await open(value)
  queue('retry only by choice')
  await snapshot(socket, idle(value))
  await act(async () => fail(socket, 'session.send', { code: -32015, message: 'Provider refused the turn' }))
  await settle()
  expect(sentRequests(socket, 'session.send')).toHaveLength(1)
  expect(screen.getByText('retry only by choice')).toBeTruthy()
  // The refusal is shown as what it is, with the provider's own words.
  expect(screen.getByText(/not sent: Provider refused the turn/)).toBeTruthy()
  await snapshot(socket, idle(value))
  expect(sentRequests(socket, 'session.send')).toHaveLength(1)
})

it('StrictMode navigation consumes a ready queue only once', async () => {
  const value = running()
  const socket = await open(value, true)
  const other = value.sessions.find(session => session.id !== value.activeSessionId)!.id
  queue('send once')
  await snapshot(socket, visible(value, other))
  await snapshot(socket, idle(value))
  expect(sentRequests(socket, 'session.send')).toHaveLength(1)
})

it('a single remote emergency notification cannot release before its hold applies', async () => {
  const value = running()
  const socket = await open(value)
  queue('do not restart after a remote stop')
  await act(async () => notify(socket, 'system.emergencyStopped', stopResult(idle(value))))
  await settle()
  expect(sentRequests(socket, 'session.send')).toHaveLength(0)
  expect(screen.getByText(/Held because work was stopped/)).toBeTruthy()
})

// Skipped because no client can pass it. The daemon sends the idle snapshot
// first and system.emergencyStopped afterwards, and an idle session reached by
// a stop is indistinguishable from one that simply finished. By the time the
// stop arrives the queue has legitimately left. The fix is daemon-side
// ordering: the stop notification must precede, or ride with, the snapshot
// that reflects it. Un-skip this when that lands; do not weaken it.
it.skip('snapshot then remote stop notification cannot restart work', async () => {
  const value = running()
  const socket = await open(value)
  queue('do not restart after a remote stop')
  await snapshot(socket, idle(value))
  await act(async () => notify(socket, 'system.emergencyStopped', stopResult(idle(value))))
  await settle()
  expect(sentRequests(socket, 'session.send')).toHaveLength(0)
})

it('a late refusal of an earlier send does not destroy a newer queued instruction', async () => {
  const value = running()
  const socket = await open(value)
  queue('first instruction')
  await snapshot(socket, idle(value))
  expect(sentRequests(socket, 'session.send')).toHaveLength(1)
  // A new turn is observed while the first request still awaits its result.
  const nextTurn = structuredClone(value)
  nextTurn.sessions.find(session => session.id === value.activeSessionId)!.activeTurnId = 'a-new-turn'
  await snapshot(socket, nextTurn)
  queue('newer instruction')
  expect(screen.getByText('newer instruction')).toBeTruthy()
  await act(async () => fail(socket, 'session.send', { code: -32000, message: 'Session is busy' }))
  await settle()
  expect(screen.queryByText('newer instruction')).not.toBeNull()
})

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
async function omitBeta() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '2 skills' }))
  await user.click(screen.getByRole('menuitemcheckbox', { name: 'beta' }))
}

it('captures explicit skill IDs even when the session view remounts', async () => {
  const skills = [skill('a', 'alpha'), skill('b', 'beta')]
  const value = withSkills(running(), skills)
  const socket = await open(value, false, skills)
  await omitBeta()
  queue('alpha only')
  const other = value.sessions.find(session => session.id !== value.activeSessionId)!.id
  await snapshot(socket, visible(value, other))
  await snapshot(socket, visible(idle(value), other))
  expect(sentRequests(socket, 'session.send')).toHaveLength(1)
  expect(sentRequests(socket, 'session.send')[0]?.params).toMatchObject({
    sessionId: value.activeSessionId,
    skillSelection: { mode: 'turn-explicit', skills: [{ skillId: skills[0]!.id, review: { contentDigest: skills[0]!.contentDigest, manifest: skills[0]!.manifest } }] },
  })
})

it('holds a queued explicit choice when that skill is no longer enabled', async () => {
  const skills = [skill('a', 'alpha'), skill('b', 'beta')]
  const value = withSkills(running(), skills)
  const socket = await open(value, false, skills)
  await omitBeta()
  queue('alpha only')
  const changed = idle(value)
  changed.skillEnablements[0]!.enabled = false
  await snapshot(socket, changed)
  expect(sentRequests(socket, 'session.send')).toHaveLength(0)
  expect(screen.getByText(/Held because a skill you chose is no longer/)).toBeTruthy()
})

it('retains an explicit empty skill choice rather than using project defaults', async () => {
  const skills = [skill('a', 'alpha')]
  const value = withSkills(running(), skills)
  const socket = await open(value, false, skills)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'alpha' }))
  await user.click(screen.getByRole('menuitemcheckbox', { name: 'alpha' }))
  queue('no skills this time')
  await snapshot(socket, idle(value))
  expect(sentRequests(socket, 'session.send')[0]?.params).toMatchObject({ skillSelection: { mode: 'turn-explicit', skills: [] } })
})

it('waits for a pending catalog instead of claiming the chosen skill is gone', async () => {
  const skills = [skill('a', 'alpha'), skill('b', 'beta')]
  const value = withSkills(running(), skills)
  const socket = await open(value, false, skills, false)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '2 skills' }))
  await user.click(screen.getByRole('menuitemcheckbox', { name: skills[1]!.id }))
  queue('alpha after catalog loads')
  await snapshot(socket, idle(value))
  const falseMissingNotice = screen.queryByText(/Held because a skill you chose is no longer/)
  await loadCatalog(socket, value, skills)
  await settle()
  expect(falseMissingNotice).toBeNull()
  expect(sentRequests(socket, 'session.send')).toHaveLength(1)
})

it('keeps both a newer instruction and the one that was refused', async () => {
  const value = running()
  const socket = await open(value)
  queue('the refused one')
  await snapshot(socket, idle(value))
  queue('the newer one')
  await act(async () => fail(socket, 'session.send', { code: -32015, message: 'Provider refused the turn' }))
  await settle()
  // Neither may be silently dropped: the person wrote both.
  expect(screen.getByText('the refused one')).toBeTruthy()
  expect(screen.getByText('the newer one')).toBeTruthy()
  expect(screen.getByText(/not sent: Provider refused the turn/)).toBeTruthy()
})


it('settling an earlier refusal wakes a newer queue whose turn already ended', async () => {
  const value = running()
  const socket = await open(value)
  queue('first instruction')
  await snapshot(socket, idle(value))
  expect(sentRequests(socket, 'session.send')).toHaveLength(1)
  const nextTurn = structuredClone(value)
  nextTurn.sessions.find(session => session.id === value.activeSessionId)!.activeTurnId = 'a-new-turn'
  await snapshot(socket, nextTurn)
  queue('newer instruction')
  await snapshot(socket, idle(nextTurn))
  // Still blocked: the first dispatch has not answered, so the session is
  // marked in flight and the newer message cannot go yet.
  expect(sentRequests(socket, 'session.send')).toHaveLength(1)
  await act(async () => fail(socket, 'session.send', { code: -32015, message: 'Provider refused the turn' }))
  await settle()
  // The settlement itself must wake it. Nothing else is going to.
  expect(sentRequests(socket, 'session.send')).toHaveLength(2)
  expect(sentRequests(socket, 'session.send')[1]?.params).toMatchObject({ prompt: 'newer instruction' })
})

it('a second refusal cannot replace the first undismissed receipt', async () => {
  const value = running()
  const socket = await open(value)
  queue('first rejected instruction')
  await snapshot(socket, idle(value))
  const nextTurn = structuredClone(value)
  nextTurn.sessions.find(session => session.id === value.activeSessionId)!.activeTurnId = 'a-new-turn'
  await snapshot(socket, nextTurn)
  queue('second rejected instruction')
  await act(async () => fail(socket, 'session.send', { code: -32000, message: 'First refusal' }))
  await settle()
  expect(screen.queryByText('first rejected instruction')).not.toBeNull()
  await snapshot(socket, idle(nextTurn))
  expect(sentRequests(socket, 'session.send')).toHaveLength(2)
  await act(async () => fail(socket, 'session.send', { code: -32000, message: 'Second refusal' }))
  await settle()
  expect(screen.queryByText('second rejected instruction')).not.toBeNull()
  expect(screen.queryByText('first rejected instruction')).not.toBeNull()
  expect(screen.queryByText(/First refusal/)).not.toBeNull()
})

it('a dropped acknowledgement is reported as unknown delivery, not not-sent', async () => {
  const value = running()
  const socket = await open(value)
  queue('instruction whose acknowledgement is lost')
  await snapshot(socket, idle(value))
  // The request left this client; no response told us whether it was accepted.
  expect(sentRequests(socket, 'session.send')).toHaveLength(1)
  await act(async () => socket.drop())
  await settle()
  expect(screen.queryByText('instruction whose acknowledgement is lost')).not.toBeNull()
  expect(screen.queryByText(/not sent: Daemon connection closed/)).toBeNull()
})

it('queue-again retries a recorded refusal only on explicit action', async () => {
  const value = running()
  const socket = await open(value)
  queue('retry only by choice')
  await snapshot(socket, idle(value))
  await act(async () => fail(socket, 'session.send', { code: -32015, message: 'Provider refused the turn' }))
  await settle()
  expect(sentRequests(socket, 'session.send')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Queue again' }))
  await settle()
  expect(sentRequests(socket, 'session.send')).toHaveLength(2)
  expect(sentRequests(socket, 'session.send')[1]?.params).toMatchObject({ prompt: 'retry only by choice' })
  expect(screen.queryByText(/not sent:/)).toBeNull()
})

it('dismissing a refusal does not dismiss or send the newer queue', async () => {
  const value = running()
  const socket = await open(value)
  queue('first instruction')
  await snapshot(socket, idle(value))
  const nextTurn = structuredClone(value)
  nextTurn.sessions.find(session => session.id === value.activeSessionId)!.activeTurnId = 'a-new-turn'
  await snapshot(socket, nextTurn)
  queue('newer instruction')
  await act(async () => fail(socket, 'session.send', { code: -32015, message: 'Provider refused the turn' }))
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  await settle()
  expect(screen.queryByText('first instruction')).toBeNull()
  expect(screen.queryByText('newer instruction')).not.toBeNull()
  expect(sentRequests(socket, 'session.send')).toHaveLength(1)
})

it('does not claim nothing ran when the error could have come after the turn started', async () => {
  const value = running()
  const socket = await open(value)
  queue('instruction with an ambiguous failure')
  await snapshot(socket, idle(value))
  // -32603 is an internal error. The daemon can raise it after startTurn has
  // already succeeded, so this cannot say the work did not happen.
  await act(async () => fail(socket, 'session.send', { code: -32603, message: 'Session state could not be saved' }))
  await settle()
  expect(screen.queryByText(/not sent:/)).toBeNull()
  expect(screen.getByText(/delivery could not be confirmed/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Send anyway' })).toBeTruthy()
})


it('gives refusals in different sessions their own receipts', async () => {
  const value = running()
  const socket = await open(value)
  const firstId = value.activeSessionId!
  const other = value.sessions.find(session => session.id !== firstId)!
  queue('for the first session')
  await snapshot(socket, idle(value))
  await act(async () => fail(socket, 'session.send', { code: -32015, message: 'first refusal' }))
  await settle()

  await snapshot(socket, visible(idle(value), other.id))
  queue('for the other session')
  const bothIdle = idle(visible(idle(value), other.id), other.id)
  await snapshot(socket, bothIdle)
  await act(async () => fail(socket, 'session.send', { code: -32015, message: 'second refusal' }))
  await settle()
  expect(screen.getByText('for the other session')).toBeTruthy()

  // Dismissing one session's receipt must not reach into another's. Sharing an
  // id across sessions is exactly how that happens.
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  await settle()
  await snapshot(socket, visible(bothIdle, firstId))
  expect(screen.queryByText('for the first session')).not.toBeNull()
})
