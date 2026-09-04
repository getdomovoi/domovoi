import { describe, expect, it, vi } from "vitest"

import {
  demoWorkspace,
  sessionTransferManifestSchema,
  sessionTransferStateSchema,
  type SessionTransferUsageRecord,
} from "@getdomovoi/protocol"

import {
  createSessionTransferPackage,
  prepareSessionTransferIntent,
  sessionTransferManifestDigest,
} from "./session-transfer-package.js"

const sourceMachineId = `machine-${"a".repeat(32)}`
const targetMachineId = `machine-${"b".repeat(32)}`
const baseCommit = "c".repeat(40)
const checkpointCommit = "d".repeat(40)
const cropRef = `crop-${"e".repeat(64)}`

function transferableWorkspace() {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.machine.id = sourceMachineId
  snapshot.project!.machineId = sourceMachineId
  const session = snapshot.sessions.find((candidate) => candidate.id === "session-billing")!
  session.state = "idle"
  session.workspacePath = "/source/session-billing"
  session.baseCommit = baseCommit
  session.ownershipGeneration = 2
  snapshot.approvals = []
  const preview = snapshot.artifacts.find((artifact) => artifact.id === "artifact-preview")!
  preview.path = "previews/preview.html"
  preview.mimeType = "text/html"
  const annotation = snapshot.annotations.find(
    (candidate) => candidate.artifactId === preview.id,
  )!
  annotation.visualContext = {
    status: "available",
    ref: cropRef,
    artifactRevision: preview.revision,
    mimeType: "image/png",
    width: 32,
    height: 16,
    byteLength: 8,
  }
  return snapshot
}

const usage: SessionTransferUsageRecord[] = [{
  turnId: "turn-1",
  provider: "claude-code",
  model: "claude-opus-5",
  inputTokens: 5,
  cachedInputTokens: 0,
  outputTokens: 3,
  reasoningTokens: 0,
  totalTokens: 8,
  costSource: "unavailable",
}]

function intentInput() {
  return {
    snapshot: transferableWorkspace(),
    sessionId: "session-billing",
    usage,
    sourceMachineId,
    targetMachineId,
    sourceProjectId: "project-acme-api",
    targetProjectId: "project-target",
    lineageCommit: baseCommit,
    sourceHeadCommit: baseCommit,
    worktreeDigest: `sha256:${"f".repeat(64)}`,
    method: "git-bundle" as const,
    readIgnoredArtifactSource: vi.fn(async () => Buffer.from("<h1>preview</h1>\n")),
    readAnnotationCrop: vi.fn(async () => Buffer.from("pngbytes")),
  }
}

describe("session transfer package", () => {
  it("binds exact portable state and promoted resources to the preview intent", async () => {
    const input = intentInput()
    const intent = await prepareSessionTransferIntent(input)

    expect(intent.preview).toMatchObject({
      allowed: true,
      contractVersion: 1,
      sessionId: "session-billing",
      sourceMachineId,
      targetMachineId,
      project: {
        sourceProjectId: "project-acme-api",
        targetProjectId: "project-target",
        lineageCommit: baseCommit,
        sourceHeadCommit: baseCommit,
      },
    })
    expect(intent.preview.intentDigest).toMatch(/^sha256:[a-f0-9]{64}$/u)
    expect(intent.preview.coverage.included).toEqual(expect.arrayContaining([
      { kind: "thread", count: 4 },
      { kind: "artifacts", count: 2 },
      { kind: "artifact-sources", count: 1 },
      { kind: "annotations", count: 2 },
      { kind: "annotation-crops", count: 1 },
      { kind: "working-plan", count: 1 },
      { kind: "usage", count: 1 },
    ]))
    expect(intent.preview.coverage.warnings).toContainEqual({
      kind: "promoted-ignored-artifacts",
      count: 1,
    })
    expect(input.readIgnoredArtifactSource).toHaveBeenCalledWith(
      "artifact-preview",
      "previews/preview.html",
    )
    expect(input.readAnnotationCrop).toHaveBeenCalledWith(cropRef, "image/png")

    const changed = intentInput()
    changed.worktreeDigest = `sha256:${"0".repeat(64)}`
    expect((await prepareSessionTransferIntent(changed)).preview.intentDigest)
      .not.toBe(intent.preview.intentDigest)
  })

  it("creates a digest-bound manifest for state, repository, sources, and crops", async () => {
    const intent = await prepareSessionTransferIntent(intentInput())
    const repositoryBytes = Buffer.from("git bundle bytes")
    const packaged = createSessionTransferPackage(intent, {
      transferId: `transfer-${"1".repeat(32)}`,
      checkpointCommit,
      repository: { method: "git-bundle", bytes: repositoryBytes },
      createdAt: "2026-09-03T20:30:00.000Z",
    })

    expect(sessionTransferManifestSchema.parse(packaged.manifest)).toEqual(packaged.manifest)
    expect(packaged.manifestDigest).toBe(sessionTransferManifestDigest(packaged.manifest))
    expect(packaged.manifest.ownership).toEqual({ fromGeneration: 2, toGeneration: 3 })
    expect(packaged.manifest.project.targetProjectId).toBe("project-target")
    expect(packaged.members.find((member) => member.member.kind === "repository-bundle")?.bytes)
      .toEqual(repositoryBytes)
    const stateBytes = packaged.members.find((member) => member.member.kind === "session-state")!.bytes
    expect(sessionTransferStateSchema.parse(JSON.parse(stateBytes.toString("utf8"))))
      .toEqual(intent.state)
    expect(packaged.members.map(({ member }) => member.kind)).toEqual([
      "session-state",
      "repository-bundle",
      "artifact-source",
      "annotation-crop",
    ])
  })

  it("uses a remote ref without pretending repository bytes were streamed", async () => {
    const input = intentInput()
    const intent = await prepareSessionTransferIntent({
      ...input,
      method: "remote-ref",
      remote: "origin",
    })
    const packaged = createSessionTransferPackage(intent, {
      transferId: `transfer-${"1".repeat(32)}`,
      checkpointCommit,
      repository: {
        method: "remote-ref",
        remote: "origin",
        ref: "refs/domovoi/sessions/session-billing",
        commit: checkpointCommit,
      },
      createdAt: "2026-09-03T20:30:00.000Z",
    })

    expect(packaged.manifest.repository).toMatchObject({ method: "remote-ref", remote: "origin" })
    expect(packaged.members.some(({ member }) => member.kind === "repository-bundle")).toBe(false)
  })
})
