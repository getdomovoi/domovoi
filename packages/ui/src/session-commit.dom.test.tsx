import type { SessionEvidence } from "@getdomovoi/protocol"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { HandheldTabMachine } from "./handheld-tab"
import { sessionCommitBlocked } from "./session-commit"
import { SessionEvidenceContent, SessionEvidencePanel } from "./session-evidence"

afterEach(cleanup)

describe("when a session can commit", () => {
  const session = { runtime: { permissionMode: "build" as const } }

  it("commits in Build, with or without Auto, between turns", () => {
    expect(sessionCommitBlocked(session)).toBeUndefined()
  })

  it.each([["ask", "Ask"], ["plan", "Plan"]] as const)("says %s is read-only, as the daemon does", (permissionMode, name) => {
    expect(sessionCommitBlocked({ runtime: { permissionMode } }))
      .toBe(`This session is in ${name}, which is read-only, so Domovoi does not commit in it. Switch it to Build to commit.`)
  })

  it("waits for the turn", () => {
    expect(sessionCommitBlocked({ ...session, activeTurnId: "turn-1" })).toBe("Stop the active turn before committing")
  })
})

// Walk finding F10 (ruled 2026-10-18): the agent cannot commit from its
// sandbox, so the person commits from the Changes tab, as Desktop V2 J27 draws
// it: "Commit without a pull request" opens one COMMITS card with the message
// and the files, and nothing is committed until the person confirms there.

const evidence: SessionEvidence = {
  sessionId: "session-1",
  refreshedAt: "2026-10-18T12:00:00.000Z",
  workspace: {
    baseCommit: "a".repeat(40),
    changesDigest: `sha256:${"b".repeat(64)}`,
    diff: "",
    diffTruncated: false,
    totalChangedFiles: 2,
    files: [
      { path: "src/webhook.ts", status: "modified", staged: false, unstaged: true, additions: 3, deletions: 1, binary: false },
      { path: "src/retry.ts", status: "untracked", staged: false, unstaged: true, additions: null, deletions: null, binary: false },
    ],
    filesTruncated: false,
  },
  tests: { passed: 0, failed: 0, totalRuns: 0, runs: [], runsTruncated: false },
}

function show(commit: Partial<NonNullable<Parameters<typeof SessionEvidenceContent>[0]["commit"]>> = {}, shown: SessionEvidence = evidence) {
  const onCommit = commit.onCommit ?? vi.fn(async () => {})
  render(
    <SessionEvidenceContent
      connected
      evidence={shown}
      error=""
      loading={false}
      onRefresh={vi.fn()}
      commit={{ defaultMessage: "Retry the webhook", machine: "mac-mini", ...commit, onCommit }}
    />,
  )
  return { onCommit }
}

describe("committing from the Changes tab", () => {
  it("opens one commit with the message and the files, and commits only on confirm", async () => {
    const user = userEvent.setup()
    const { onCommit } = show()

    expect(screen.queryByRole("textbox", { name: "Commit message" })).toBeNull()
    await user.click(screen.getByRole("button", { name: "Commit without a pull request" }))

    expect(screen.getByText("COMMITS")).toBeTruthy()
    const message = screen.getByRole("textbox", { name: "Commit message" })
    expect((message as HTMLTextAreaElement).value).toBe("Retry the webhook")
    const card = screen.getByRole("list", { name: "Files in this commit" })
    expect(card.textContent).toContain("src/webhook.ts")
    expect(card.textContent).toContain("src/retry.ts")
    expect(onCommit).not.toHaveBeenCalled()

    await user.clear(message)
    await user.type(message, "fix(api): retry the webhook")
    await user.click(screen.getByRole("button", { name: "Commit 1" }))

    expect(onCommit).toHaveBeenCalledWith("fix(api): retry the webhook", "a".repeat(40), evidence.workspace.changesDigest)
    expect(await screen.findByText("Committed on mac-mini. Nothing has left the machine.")).toBeTruthy()
    expect(screen.queryByRole("textbox", { name: "Commit message" })).toBeNull()
  })

  it("disables Commit and explains unavailable verification without a digest", async () => {
    const { changesDigest: _digest, ...workspace } = evidence.workspace
    const { onCommit } = show({}, { ...evidence, workspace })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Commit without a pull request" }))
    const button = screen.getByRole("button", { name: "Commit 1" }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByText("Domovoi cannot verify these changes for a commit. The files may still be changing, or Git may be unable to stage them safely.")).toBeTruthy()
    await user.click(button)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it.each([
    ["size", "Domovoi cannot verify these changes for a commit because changed files exceed the 64 MiB staging limit. Commit in your own checkout, or ignore or remove large files from these changes."],
    ["paths", "Domovoi cannot verify these changes for a commit because there are more than 10,000 changed paths. Commit in your own checkout, or ignore or remove files to reduce the changed path count."],
    ["time", "Domovoi could not verify these changes within the 5 s staging allowance. Refresh to try again; a retry may succeed. You can also commit in your own checkout."],
  ] as const)("names the %s staging limit and keeps Commit disabled", async (limit, reason) => {
    const { changesDigest: _digest, ...workspace } = evidence.workspace
    const { onCommit } = show({}, {
      ...evidence, workspace: { ...workspace, commitUnavailableReason: { kind: "staging-limit", limit } },
    })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Commit without a pull request" }))
    expect(screen.getByText(reason)).toBeTruthy()
    expect(screen.getByRole("list", { name: "Files in this commit" }).textContent).toContain("src/webhook.ts")
    const button = screen.getByRole("button", { name: "Commit 1" }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    await user.click(button)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("forwards the evidence digest through the panel callback", async () => {
    const onCommit = vi.fn(async () => {})
    render(<SessionEvidencePanel connected sessionId="session-1" onLoad={vi.fn(async () => evidence)} onCommit={onCommit} commitFacts={{ defaultMessage: "Retry", machine: "mac-mini" }} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Commit without a pull request" }))
    await user.click(screen.getByRole("button", { name: "Commit 1" }))
    expect(onCommit).toHaveBeenCalledWith("session-1", "Retry", evidence.workspace.baseCommit, evidence.workspace.changesDigest)
  })

  it("keeps Commit off while the message is empty", async () => {
    const user = userEvent.setup()
    show({ defaultMessage: "" })

    await user.click(screen.getByRole("button", { name: "Commit without a pull request" }))

    expect((screen.getByRole("button", { name: "Commit 1" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("says why this session cannot commit now and keeps Commit off", async () => {
    const user = userEvent.setup()
    const { onCommit } = show({ blocked: "This session is in Ask, which is read-only. Switch it to Build to commit." })

    await user.click(screen.getByRole("button", { name: "Commit without a pull request" }))

    expect(screen.getByText("This session is in Ask, which is read-only. Switch it to Build to commit.")).toBeTruthy()
    const button = screen.getByRole("button", { name: "Commit 1" }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    await user.click(button)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("shows the daemon's refusal as it comes and keeps the commit open", async () => {
    const user = userEvent.setup()
    const refusal = "1 file in these changes looks like a credential, a private key or an environment file. Domovoi does not commit such files, so nothing was committed. Remove it or add it to .gitignore, then commit again."
    show({ onCommit: vi.fn(async () => { throw new Error(refusal) }) })

    await user.click(screen.getByRole("button", { name: "Commit without a pull request" }))
    await user.click(screen.getByRole("button", { name: "Commit 1" }))

    expect(await screen.findByText(refusal)).toBeTruthy()
    expect(screen.getByRole("textbox", { name: "Commit message" })).toBeTruthy()
  })

  it("offers nothing to commit in a clean worktree", () => {
    show({}, { ...evidence, workspace: { ...evidence.workspace, files: [], totalChangedFiles: 0 } })

    expect(screen.queryByRole("button", { name: "Commit without a pull request" })).toBeNull()
  })

  it("draws no commit in a phone or tablet tab and says why", async () => {
    render(
      <HandheldTabMachine.Provider value="mac-mini">
        <SessionEvidencePanel
          connected
          sessionId="session-1"
          onLoad={vi.fn(async () => evidence)}
          onCommit={vi.fn(async () => {})}
          commitFacts={{ defaultMessage: "Retry the webhook", machine: "mac-mini" }}
        />
      </HandheldTabMachine.Provider>,
    )

    await waitFor(() => expect(screen.getByText("src/webhook.ts")).toBeTruthy())
    expect(screen.queryByRole("button", { name: "Commit without a pull request" })).toBeNull()
    expect(screen.getByText(/Committing is off in a phone or tablet tab/u)).toBeTruthy()
  })
})
