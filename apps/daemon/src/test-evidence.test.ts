import type { ThreadItem } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { testEvidence } from "./test-evidence.js"

function tool(
  id: string,
  title: string,
  status: "running" | "completed" | "failed" | "declined",
  output?: string,
): ThreadItem {
  return {
    id,
    sessionId: "session-1",
    kind: "tool",
    tool: "command",
    status,
    title,
    ...(output === undefined ? {} : { output }),
    createdAt: "2026-08-29T12:00:00.000Z",
  }
}

describe("testEvidence", () => {
  it("counts only observed completed test commands", () => {
    const evidence = testEvidence([
      tool("install", "pnpm install", "completed", "installed"),
      tool("unit", "pnpm test", "completed", "42 passed"),
      tool("go", "go test ./...", "failed", "FAIL package"),
      tool("running", "cargo test", "running"),
      tool("declined", "pytest", "declined"),
      {
        id: "message",
        sessionId: "session-1",
        kind: "assistant",
        body: "pnpm test passed",
        createdAt: "2026-08-29T12:00:00.000Z",
      },
    ])

    expect(evidence).toEqual({
      passed: 1,
      failed: 1,
      totalRuns: 2,
      runsTruncated: false,
      runs: [
        expect.objectContaining({ id: "unit", command: "pnpm test", status: "passed" }),
        expect.objectContaining({ id: "go", command: "go test ./...", status: "failed" }),
      ],
    })
  })

  it("recognizes supported test runners without matching prose", () => {
    const commands = [
      "npm run test:unit",
      "yarn vitest run",
      "bun test",
      "pnpm exec jest",
      "pytest -q",
      "python -m pytest",
      "cargo test --workspace",
      "dotnet test",
      "mvn test",
      "gradle test",
      "bash -lc \"pnpm test\"",
      "pwsh -Command \"dotnet test\"",
    ]
    const items = [
      ...commands.map((command, index) => tool(`test-${index}`, command, "completed")),
      tool("prose", "echo tests passed", "completed"),
      tool("file", "rg test src", "completed"),
    ]

    expect(testEvidence(items).runs.map((run) => run.command)).toEqual(commands)
  })

  it("bounds run history and each captured output", () => {
    const evidence = testEvidence(Array.from({ length: 55 }, (_, index) =>
      tool(`test-${index}`, "pnpm test", "completed", `prefix-${"x".repeat(10_000)}-${index}`)
    ))

    expect(evidence.totalRuns).toBe(55)
    expect(evidence.runs).toHaveLength(50)
    expect(evidence.runsTruncated).toBe(true)
    expect(evidence.runs.every((run) => run.output?.length === 4_096)).toBe(true)
    expect(evidence.runs.every((run) => run.outputTruncated)).toBe(true)
    expect(evidence.runs.at(-1)?.output).toContain("-54")
  })
})
