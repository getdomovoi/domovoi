import type { SessionAttachment } from "@getdomovoi/protocol"

// How a dock surface hands an attachment to the composer without the two
// sharing a parent that holds the draft. The thread opens the inbox for the
// session it shows; a surface offers to a session by id.
//
// Every offer names its session. One for a session whose composer is not open
// is dropped, not queued and not redirected, so output from one session's
// terminal can never land in another session's draft.

export type ComposerReceipt = "attached" | "full"
export type ComposerOfferOutcome = ComposerReceipt | "closed"
export type ComposerReceiver = (attachment: SessionAttachment) => ComposerReceipt

export type ComposerInbox = {
  open(sessionId: string, receiver: ComposerReceiver): () => void
  offer(sessionId: string, attachment: SessionAttachment): ComposerOfferOutcome
  canReceive(sessionId: string | null): boolean
  subscribe(listener: () => void): () => void
}

export function createComposerInbox(): ComposerInbox {
  const receivers = new Map<string, ComposerReceiver>()
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }

  return {
    open: (sessionId, receiver) => {
      receivers.set(sessionId, receiver)
      notify()
      return () => {
        // A remount opens the new composer before the old cleanup runs, so a
        // close only removes the receiver it opened.
        if (receivers.get(sessionId) !== receiver) return
        receivers.delete(sessionId)
        notify()
      }
    },
    offer: (sessionId, attachment) => receivers.get(sessionId)?.(attachment) ?? "closed",
    canReceive: (sessionId) => sessionId !== null && receivers.has(sessionId),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export const composerInbox = createComposerInbox()
