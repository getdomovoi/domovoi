import type { PermissionMode, WorkspaceSnapshot } from "@getdomovoi/protocol"

type Session = WorkspaceSnapshot["sessions"][number]

export type StartLikeRequest = {
  title: string
  prompt: string
  runtime: Session["runtime"]
}

const maximumTitleCharacters = 512

// A session started from a phone is started like the one the person is
// looking at: same machine, same repository, same provider and model. Three of
// the launcher's four choices are already made. The fourth, the mode, is Plan
// unless the person says otherwise: Ask would block on the first write with
// nobody there to answer, Build would write to a worktree with nobody reading,
// and Plan comes back as a proposal to approve, which is the right artifact
// for a start nobody is watching. Auto never carries over for the same reason.
export function startLikeRequest(like: Session, prompt: string, mode: PermissionMode): StartLikeRequest {
  const trimmed = prompt.trim()
  const firstLine = trimmed.split("\n")[0]?.trim() ?? trimmed
  return {
    title: firstLine.slice(0, maximumTitleCharacters),
    prompt: trimmed,
    runtime: { ...like.runtime, permissionMode: mode, auto: false },
  }
}
