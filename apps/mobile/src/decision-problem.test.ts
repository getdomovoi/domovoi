import { approvalCheckpointErrorCode } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { decisionProblem } from "./decision-problem"
import { DaemonError, DaemonNotSentError, DaemonUnconfirmedError } from "./lib/daemon"
import { DaemonTimeoutError } from "./lib/request-timeout"

describe("decisionProblem", () => {
  it("says not sent only when the frame never left", () => {
    expect(decisionProblem(new DaemonNotSentError("The daemon connection is not open")))
      .toBe("Not sent: the daemon connection is not open. The gate is still waiting.")
  })

  it("quotes the daemon's own refusal", () => {
    expect(decisionProblem(new DaemonError("Approval already resolved", -32000, undefined)))
      .toBe("The daemon refused: Approval already resolved. The gate is still waiting.")
  })

  // The daemon's own message can already end by saying the approval still
  // waits. The phone does not say it a second time.
  it("does not repeat the waiting line the daemon already gave", () => {
    const message = "Domovoi could not reach the agent, so this decision was not applied. The approval is still waiting."
    expect(decisionProblem(new DaemonError(message, -32603, undefined)))
      .toBe(`The daemon refused: ${message}`)
  })

  // Only a closing sentence counts. A message that mentions the words in
  // passing still gets the phone's own line.
  it("keeps the waiting line when the daemon mentions it only in passing", () => {
    expect(decisionProblem(new DaemonError("Checked whether The approval is still waiting. Not applied", -32000, undefined)))
      .toBe("The daemon refused: Checked whether The approval is still waiting. Not applied. The gate is still waiting.")
    expect(decisionProblem(new DaemonError("Not applied because the approval is still waiting on the agent", -32000, undefined)))
      .toBe("The daemon refused: Not applied because the approval is still waiting on the agent. The gate is still waiting.")
  })

  // The frame left. The daemon may have applied it, so the phone may not
  // claim it did not: a person who denied and reads "not sent" would deny
  // again, or one who allowed would believe nothing ran.
  it("does not claim not sent for a frame that left without an answer", () => {
    const unknown = "The daemon went away before it confirmed. The gate may or may not have been answered; when the connection returns, this screen shows which."
    expect(decisionProblem(new DaemonUnconfirmedError("The daemon closed the connection"))).toBe(unknown)
    expect(decisionProblem(new DaemonTimeoutError("approval.resolve", 10_000))).toBe(unknown)
    expect(decisionProblem(new Error("something else"))).not.toMatch(/Not sent/)
  })

  // S3.10h, #743: a checkpoint the daemon could not take arrives with its
  // cause as data. The phone says the cause from the data, as the desktop
  // card does, and never parses the daemon's sentence.
  describe("a refused checkpoint", () => {
    const generic = "Domovoi could not take a checkpoint, so the command did not run; decide again"
    const refused = (data: unknown, message = generic) => new DaemonError(message, approvalCheckpointErrorCode, data)
    const kind = "approval-checkpoint-refused"

    it("names a held lock by its path", () => {
      const lockPath = "/Users/dana/acme-api/.git/refs/domovoi/checkpoints/cccc.lock"
      expect(decisionProblem(refused({ kind, cause: "lock-held", lockPath })))
        .toBe(`The daemon refused: Could not take a checkpoint: ${lockPath} is held by another git process, or was left by one that stopped. Nothing ran. The gate is still waiting.`)
    })

    it.each([
      ["submodule-changes", "Could not take a checkpoint: a submodule has local changes a checkpoint cannot hold. Nothing ran."],
      ["timed-out", "Could not take a checkpoint: it did not finish in time. Nothing ran."],
      ["git-failed", "Could not take a checkpoint: a Git command failed. Nothing ran."],
      ["unknown", "Could not take a checkpoint. Nothing ran."],
    ])("says the cause %s", (cause, line) => {
      expect(decisionProblem(refused({ kind, cause }))).toBe(`The daemon refused: ${line} The gate is still waiting.`)
    })

    it.each([
      ["repository-config", "Could not take a checkpoint: this repository's own Git config asks for something Domovoi does not run. Nothing ran.",
        `${generic}. The repository sets the filter "lfs" in its own Git config. Nothing ran.`],
      ["repository-config-unreadable", "Could not take a checkpoint: Git could not read this repository's config. Nothing ran.",
        `${generic}. Git could not read the repository's Git config.`],
      ["git-unavailable", "Could not take a checkpoint: this machine's Git is missing, or not a version Domovoi can use. Nothing ran.",
        `${generic}. Domovoi found no git in an absolute PATH entry.`],
    ])("keeps the daemon's detail for the cause %s", (cause, line, message) => {
      expect(decisionProblem(refused({ kind, cause }, message)))
        .toBe(`The daemon refused: ${line} ${message} The gate is still waiting.`)
    })

    it("quotes the daemon when the data is not a checkpoint refusal it can read", () => {
      for (const data of [undefined, { kind, cause: "lock-held" }, { kind, cause: "invented" }, { kind: "session-review-refused", reason: "comment-unavailable" }]) {
        expect(decisionProblem(refused(data))).toBe(`The daemon refused: ${generic}. The gate is still waiting.`)
      }
    })

    // Error data is not tied to a code on the wire: only the checkpoint
    // refusal's own code makes the data a checkpoint refusal.
    it("quotes the daemon when checkpoint data comes with another code", () => {
      expect(decisionProblem(new DaemonError(generic, -32603, { kind, cause: "unknown" })))
        .toBe(`The daemon refused: ${generic}. The gate is still waiting.`)
    })
  })
})
