import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { sessionHistoryEntrySchema, sessionHistoryPageSchema } from '@getdomovoi/protocol'
import { HistoryPanel } from './workspace-shell'

afterEach(cleanup)

const base = {
  id: 'thread:peer-history', sourceId: 'peer-history', sessionId: 'session-history',
  createdAt: '2026-09-13T12:00:00.000Z',
}

async function display(fields: Record<string, unknown>) {
  const item = sessionHistoryEntrySchema.parse({ ...base, ...fields })
  const page = sessionHistoryPageSchema.parse({ sessionId: base.sessionId, items: [item], hasMore: false })
  const onLoad = async () => page
  const view = render(<HistoryPanel sessionId={base.sessionId} connected onLoad={onLoad} />)
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() })
  expect(view.container.textContent).not.toContain('Loading history')
  return view.container.textContent
}

describe('the history panel keeps its evidence on the row', () => {
  it('keeps the second line of a recorded message reachable', async () => {
    const text = await display({ category: 'messages', role: 'assistant', body: 'Visible title\nMESSAGE_SECOND_LINE_SENTINEL' })
    expect(text).toContain('Visible title')
    expect(text).toContain('MESSAGE_SECOND_LINE_SENTINEL')
  })

  it.each(['tools', 'tests'])('keeps %s output reachable', async (category) => {
    const text = await display({ category, tool: 'command', status: 'failed', title: 'Failing command', output: 'COMMAND_OUTPUT_SENTINEL' })
    expect(text).toContain('Failing command')
    expect(text).toContain('COMMAND_OUTPUT_SENTINEL')
  })

  it('keeps a system message diagnostic detail reachable', async () => {
    const text = await display({ category: 'messages', role: 'system', body: 'Provider could not start', detail: 'DIAGNOSTIC_DETAIL_SENTINEL' })
    expect(text).toContain('DIAGNOSTIC_DETAIL_SENTINEL')
  })

  it.each(['CHECKPOINT_SENTINEL', '3ff847f2-31a6-4357-ae76-5584e0e06f14'])('keeps approval evidence %s when a client id also exists', async (evidence) => {
    const text = await display({ category: 'approvals', decision: 'allow-once', operation: 'write',
      checkpoint: 'CHECKPOINT_SENTINEL', client: 'desktop', clientId: 'declared-client-id', connectionId: '3ff847f2-31a6-4357-ae76-5584e0e06f14' })
    expect(text).toContain(evidence)
  })
})
