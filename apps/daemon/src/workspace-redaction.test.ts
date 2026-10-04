import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { countWork } from "./test-work.js"
import { createWorkspaceRedactor, redactWorkspaceCopies } from "./workspace-redaction.js"

const createdAt = "2026-09-29T12:00:00.000Z"
const secrets = /(?:reply|tool|output|streamed|approval)-secret-\d+/u

// A long project history with a secret in every item, and one assistant reply
// still streaming at the end, as the persistence path sees it mid-turn.
function streamingWorkspace(historyItems: number): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const sessionId = snapshot.sessions[0]!.id
  for (let index = 0; index < historyItems; index += 1) {
    snapshot.thread.push(index % 2 === 0
      ? { id: `reply-${index}`, sessionId, kind: "assistant", body: `Run it with NPM_TOKEN=reply-secret-${index} set.`, createdAt }
      : {
        id: `tool-${index}`,
        sessionId,
        kind: "tool",
        tool: "command",
        status: "completed",
        title: `curl -H "Authorization: Bearer tool-secret-${index}" https://example.com`,
        output: `token=output-secret-${index}\nok\n`,
        createdAt,
      })
  }
  snapshot.thread.push({ id: "streaming", sessionId, kind: "assistant", body: "", createdAt })
  return snapshot
}

function streamed(snapshot: WorkspaceSnapshot): { body: string } {
  const item = snapshot.thread.at(-1)!
  if (item.kind !== "assistant") throw new Error("The last item is not the streaming reply")
  return item
}

describe("incremental workspace redaction", () => {
  it("writes what a whole redaction writes after every streamed change", () => {
    const snapshot = streamingWorkspace(40)
    const redact = createWorkspaceRedactor()
    const steps: Array<(live: WorkspaceSnapshot) => void> = [
      () => {},
      (live) => { streamed(live).body += "The handler now checks the key" },
      // The daemon appends to the live item in place, so the id and the object
      // stay the same while the text changes.
      (live) => { streamed(live).body += " before it writes. export API_KEY=streamed-secret-1" },
      (live) => {
        const tool = live.thread.find((item) => item.id === "tool-1")
        if (tool?.kind === "tool") tool.output = "password=output-secret-99\n"
      },
      (live) => { live.thread.splice(live.thread.findIndex((item) => item.id === "reply-2"), 1) },
      (live) => {
        live.thread.splice(5, 0, {
          id: "reply-2",
          sessionId: live.sessions[1]!.id,
          kind: "assistant",
          body: "Moved and rewritten, NPM_TOKEN=reply-secret-2 again.",
          createdAt,
        })
      },
      (live) => {
        const tool = live.thread.find((item) => item.id === "tool-1")
        if (tool?.kind === "tool") tool.output = "token=output-secret-1\nok\n"
      },
      (live) => { live.approvals[0]!.command = "pnpm deploy --token approval-secret-1" },
    ]
    for (const step of steps) {
      step(snapshot)
      const written = redact(snapshot)
      expect(written).toEqual(redactWorkspaceCopies(snapshot))
      expect(JSON.stringify(written)).not.toMatch(secrets)
    }
  })

  it("keeps a later write whole when a caller edits a copy it was given", () => {
    const snapshot = streamingWorkspace(10)
    const redact = createWorkspaceRedactor()
    const first = redact(snapshot)
    try {
      Object.assign(first.thread[5]!, { body: "tampered", title: "tampered" })
    } catch {
      // A copy shared between writes may refuse the edit outright.
    }
    streamed(snapshot).body += "more text"
    expect(redact(snapshot)).toEqual(redactWorkspaceCopies(snapshot))
  })

  it("redacts only the thread items a flush changed", async () => {
    const snapshot = streamingWorkspace(400)
    const redact = createWorkspaceRedactor()
    redact(snapshot)
    streamed(snapshot).body += " token one two three"
    const flush = await countWork(() => redact(snapshot))
    // The same flush with none of the untouched history: the approvals, the
    // rules and the one item the stream changed.
    const alone = { ...structuredClone(snapshot), thread: [structuredClone(snapshot.thread.at(-1)!)] }
    const reference = await countWork(() => createWorkspaceRedactor()(alone))
    const untouched = snapshot.thread.length - 1
    // Finding an item unchanged costs a visit or two. Redacting it again runs
    // every redaction rule over its text, dozens of searches per item.
    expect(flush.work - reference.work).toBeLessThanOrEqual(2 * untouched)
    expect(flush.result).toEqual(redactWorkspaceCopies(snapshot))
  })
})

// A device label is a person's own text, so it can carry a secret the way any
// durable text can. The receipt keeps the device's id, an identifier, and the
// redacted label stays within the label's schema bound.
describe("the deciding device's label on a receipt", () => {
  const deviceId = `device-${"f".repeat(32)}`
  function receiptWorkspace(label: string): WorkspaceSnapshot {
    const snapshot = structuredClone(demoWorkspace)
    const sessionId = snapshot.sessions[0]!.id
    snapshot.thread.push({
      id: "receipt-device-label",
      sessionId,
      kind: "receipt",
      decision: "allow-once",
      operation: "Run the migrations",
      checkpoint: "unavailable",
      client: "phone",
      device: { id: deviceId, label },
      createdAt,
    })
    return snapshot
  }
  const receipt = (snapshot: WorkspaceSnapshot) => snapshot.thread.find((item) => item.id === "receipt-device-label")

  it("redacts a secret in the label and keeps the id", () => {
    const snapshot = receiptWorkspace("office NPM_TOKEN=label-secret-1")
    const written = redactWorkspaceCopies(snapshot)
    expect(receipt(written)).toMatchObject({ device: { id: deviceId, label: "office NPM_TOKEN=[REDACTED]" } })
    expect(JSON.stringify(written)).not.toContain("label-secret-1")
    expect(createWorkspaceRedactor()(snapshot)).toEqual(written)
    expect(receipt(snapshot)).toMatchObject({ device: { label: "office NPM_TOKEN=label-secret-1" } })
  })

  it("keeps the redacted label within the label's bound", () => {
    const label = `${"o".repeat(128 - " password=hunter2".length)} password=hunter2`
    expect(label).toHaveLength(128)
    const written = receipt(redactWorkspaceCopies(receiptWorkspace(label)))
    if (written?.kind !== "receipt") throw new Error("The receipt is missing")
    expect(written.device?.label.length).toBeLessThanOrEqual(128)
    expect(JSON.stringify(written)).not.toContain("hunter2")
  })
})
