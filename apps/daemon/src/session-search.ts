import type { SessionSearchMatch, WorkspaceSnapshot } from "@getdomovoi/protocol"

// Caseless matching for session search. JavaScript has no full Unicode case
// fold, so this approximates one: NFKC normalisation (so a ligature such as
// "ﬁ" reads as "fi"), then upper case and back to lower case (so "ß" and "SS"
// meet as "ss"), then every final sigma as a medial one (lower-casing picks
// "ς" at the end of a word and "σ" elsewhere, so "Σ" would miss "ΟΣ").
// Known gaps: no locale rules (Turkish dotted and dotless i fold as in
// English), and no folds beyond what upper then lower casing gives.
export function foldForSearch(text: string): string {
  return text.normalize("NFKC").toUpperCase().toLowerCase().replaceAll("ς", "σ")
}

// Search over sessions by title, then by summary: the newest assistant message
// the snapshot holds for each session. The summaries are found in one pass
// over the thread, newest first, not one scan per session.
export function searchSessions(
  snapshot: Pick<WorkspaceSnapshot, "sessions" | "thread">,
  query: string,
  limit: number,
): { matches: SessionSearchMatch[], truncated: boolean } {
  const needle = foldForSearch(query)
  let summaries: Map<string, string> | undefined
  const summaryOf = (sessionId: string): string | undefined => {
    if (!summaries) {
      summaries = new Map()
      for (let index = snapshot.thread.length - 1; index >= 0; index -= 1) {
        const item = snapshot.thread[index]!
        if (item.kind === "assistant" && !summaries.has(item.sessionId)) summaries.set(item.sessionId, item.body)
      }
    }
    return summaries.get(sessionId)
  }
  const matches: SessionSearchMatch[] = []
  for (const session of snapshot.sessions) {
    const inTitle = foldForSearch(session.title).includes(needle)
    const summary = inTitle ? undefined : summaryOf(session.id)
    const matchedIn = inTitle ? "title" : summary !== undefined && foldForSearch(summary).includes(needle) ? "summary" : undefined
    if (!matchedIn) continue
    if (matches.length >= limit) return { matches, truncated: true }
    matches.push({ session, matchedIn })
  }
  return { matches, truncated: false }
}
