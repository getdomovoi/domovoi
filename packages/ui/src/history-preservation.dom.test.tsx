import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

// Everything is a state, not an action. Pressing it while it is already the
// state reloaded nothing and cleared the page, so the rows vanished.
it('keeps the loaded page when Everything is already selected', async () => {
  const page = sessionHistoryPageSchema.parse({ sessionId: base.sessionId, items: [sessionHistoryEntrySchema.parse({ ...base, category: 'messages', role: 'system', body: 'Recorded row' })], hasMore: false })
  const onLoad = vi.fn(async () => page)
  render(<HistoryPanel sessionId={base.sessionId} connected onLoad={onLoad} />)
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() })
  expect(screen.getByRole('button', { name: 'Everything', pressed: true })).toBeTruthy()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Everything' }))
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() })
  expect(onLoad).toHaveBeenCalledTimes(1)
  expect(screen.queryAllByText('Recorded row').length).toBeGreaterThan(0)
})

// The meta line sits inside a scroll viewport whose content box grows to fit
// its widest child, so a truncated line does not clip, it widens the table and
// the viewport hides the rest. Measured in Chromium at 400px: a long approval
// meta pushed the row to 1570px. The line wraps instead; this pins that.
it('wraps the meta line rather than truncating it', async () => {
  const item = sessionHistoryEntrySchema.parse({ ...base, category: 'approvals', decision: 'allow-once', operation: 'write',
    checkpoint: 'checkpoint-approval-boundary-7f23abcd', client: 'desktop', connectionId: '3ff847f2-31a6-4357-ae76-5584e0e06f14',
    explanation: 'Approved only the migration files in the reviewed project. Keep unrelated repository changes untouched.' })
  const page = sessionHistoryPageSchema.parse({ sessionId: base.sessionId, items: [item], hasMore: false })
  render(<HistoryPanel sessionId={base.sessionId} connected onLoad={async () => page} />)
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() })
  const meta = screen.getByTestId('history-meta')
  expect(meta.className).not.toMatch(/\btruncate\b/)
  expect(meta.className).toMatch(/break-words/)
})
