import type { SessionAttachment } from "@getdomovoi/protocol"

// Switching sessions remounts the thread, which is what resets its per-session
// state: the pending send, the error alerts, the transfer receipt. That reset is
// correct for all of it except the part the person typed. This store keeps the
// unsent half of a turn outside React, keyed by session, so a switch and a
// switch back returns the draft rather than an empty box.
//
// It is bounded. A workspace with a long session list would otherwise hold a
// draft for every session ever opened, for the life of the tab.

export type SessionDraft = {
  prompt: string
  attachments: readonly SessionAttachment[]
  skillSelection: ReadonlySet<string> | undefined
  promptEditorOpen: boolean
}

export const emptySessionDraft: SessionDraft = {
  prompt: "",
  attachments: [],
  skillSelection: undefined,
  promptEditorOpen: false,
}

export const maximumRetainedSessionDrafts = 20

function isEmpty(draft: SessionDraft): boolean {
  return draft.prompt === ""
    && draft.attachments.length === 0
    && !draft.promptEditorOpen
    && (draft.skillSelection === undefined || draft.skillSelection.size === 0)
}

export type SessionDraftStore = {
  read: (sessionId: string | null) => SessionDraft
  write: (sessionId: string | null, draft: SessionDraft) => void
  clear: (sessionId: string | null) => void
  clearAll: () => void
  size: () => number
}

export function createSessionDraftStore(max: number = maximumRetainedSessionDrafts): SessionDraftStore {
  // Insertion order is the recency order: a rewrite deletes its key first, so
  // the oldest entry is always the first one the iterator hands back.
  const drafts = new Map<string, SessionDraft>()

  return {
    read: (sessionId) => (sessionId === null ? emptySessionDraft : drafts.get(sessionId) ?? emptySessionDraft),
    write: (sessionId, draft) => {
      if (sessionId === null) return
      drafts.delete(sessionId)
      // An empty draft is the absence of one. Holding a row for it would spend
      // the bound on sessions with nothing to restore.
      if (isEmpty(draft)) return
      drafts.set(sessionId, draft)
      for (const oldest of drafts.keys()) {
        if (drafts.size <= max) break
        drafts.delete(oldest)
      }
    },
    clear: (sessionId) => {
      if (sessionId === null) return
      drafts.delete(sessionId)
    },
    clearAll: () => drafts.clear(),
    size: () => drafts.size,
  }
}

export const sessionDraftStore = createSessionDraftStore()
