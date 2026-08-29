import type { ThreadItem } from "@getdomovoi/protocol"

export type TestRunEvidence = {
  id: string
  command: string
  status: "passed" | "failed"
  output?: string
  outputTruncated: boolean
  createdAt: string
}

export type TestEvidence = {
  passed: number
  failed: number
  totalRuns: number
  runs: TestRunEvidence[]
  runsTruncated: boolean
}

export const maximumTestEvidenceRuns = 50
export const maximumTestEvidenceOutputCharacters = 4_096

const testCommand = /(?:^|[;&|]\s*|(?:bash|zsh|sh|pwsh|powershell|cmd(?:\.exe)?)\s+(?:-lc?|-command|\/c)\s+["']?)(?:(?:pnpm|npm|yarn)\s+(?:(?:run|exec)\s+)?(?:test(?:[:\w.-]*)?|vitest|jest)|bun\s+test|(?:python\s+-m\s+)?pytest|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|gradle\s+test)(?:\s|["']?$)/i

export function testEvidence(items: readonly ThreadItem[]): TestEvidence {
  const allRuns = items.flatMap<TestRunEvidence>((item) => {
    if (
      item.kind !== "tool"
      || item.tool !== "command"
      || (item.status !== "completed" && item.status !== "failed")
      || !testCommand.test(item.title)
    ) return []
    const outputTruncated = (item.output?.length ?? 0) > maximumTestEvidenceOutputCharacters
    return [{
      id: item.id,
      command: item.title,
      status: item.status === "completed" ? "passed" : "failed",
      ...(item.output === undefined
        ? {}
        : { output: item.output.slice(-maximumTestEvidenceOutputCharacters) }),
      outputTruncated,
      createdAt: item.createdAt,
    }]
  })
  const runs = allRuns.slice(-maximumTestEvidenceRuns)
  return {
    passed: allRuns.filter((run) => run.status === "passed").length,
    failed: allRuns.filter((run) => run.status === "failed").length,
    totalRuns: allRuns.length,
    runsTruncated: allRuns.length > maximumTestEvidenceRuns,
    runs,
  }
}
