import { createHash } from "node:crypto"

import {
  sessionTransferManifestDomain,
  sessionTransferManifestSchema,
  sessionTransferPreviewSchema,
  type SessionTransferCoverage,
  type SessionTransferManifest,
  type SessionTransferMember,
  type SessionTransferPreview,
  type SessionTransferState,
  type SessionTransferUsageRecord,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import {
  portableSessionTransferState,
  SessionTransferStateError,
} from "./session-transfer-state.js"

type AllowedTransferPreview = Extract<SessionTransferPreview, { allowed: true }>

type TransferResource = {
  bytes: Buffer
  digest: string
}

type ArtifactSourceResource = TransferResource & {
  artifactId: string
  path: string
}

type AnnotationCropResource = TransferResource & {
  ref: string
  mimeType: "image/png" | "image/jpeg" | "image/webp"
}

export type PreparedSessionTransferIntent = {
  preview: AllowedTransferPreview
  state: SessionTransferState
  method: "git-bundle" | "remote-ref"
  remote?: string
  worktreeDigest: string
  artifactSources: ArtifactSourceResource[]
  annotationCrops: AnnotationCropResource[]
}

export type PackagedSessionTransfer = {
  manifest: SessionTransferManifest
  manifestDigest: string
  members: Array<{ member: SessionTransferMember, bytes: Buffer }>
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`
}

function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function coverageFor(
  snapshot: WorkspaceSnapshot,
  state: SessionTransferState,
  artifactSourceCount: number,
  cropCount: number,
): SessionTransferCoverage {
  const sourceAuthorityCount = snapshot.approvalRules.filter(
    (rule) => rule.projectId === snapshot.project?.id && rule.status === "active",
  ).length + snapshot.skillEnablements.filter(
    (review) => review.projectId === snapshot.project?.id && review.enabled,
  ).length
  return {
    included: [
      { kind: "repository", count: 1 },
      { kind: "thread", count: state.thread.length },
      {
        kind: "checkpoints",
        count: state.thread.filter((item) => item.kind === "checkpoint").length,
      },
      { kind: "artifacts", count: state.artifacts.length },
      { kind: "artifact-sources", count: artifactSourceCount },
      { kind: "annotations", count: state.annotations.length },
      { kind: "annotation-crops", count: cropCount },
      { kind: "working-plan", count: state.workingPlan ? 1 : 0 },
      { kind: "usage", count: state.usage.length },
      { kind: "runtime-settings", count: 1 },
    ],
    excluded: [
      { kind: "provider-credentials" },
      { kind: "provider-state" },
      { kind: "terminals" },
      { kind: "approval-rules" },
      { kind: "skill-authority" },
      { kind: "audit-log" },
      { kind: "ignored-files" },
      { kind: "external-databases" },
      { kind: "auto" },
    ],
    warnings: [
      { kind: "tracked-sensitive-files-may-travel" },
      ...(artifactSourceCount > 0
        ? [{ kind: "promoted-ignored-artifacts" as const, count: artifactSourceCount }]
        : []),
      { kind: "provider-restart-required" },
      ...(sourceAuthorityCount > 0
        ? [{ kind: "target-reapproval-required" as const, count: sourceAuthorityCount }]
        : []),
    ],
  }
}

export async function prepareSessionTransferIntent(input: {
  snapshot: WorkspaceSnapshot
  sessionId: string
  usage: readonly SessionTransferUsageRecord[]
  sourceMachineId: string
  targetMachineId: string
  sourceProjectId: string
  targetProjectId: string
  lineageCommit: string
  sourceHeadCommit: string
  worktreeDigest: string
  method: "git-bundle" | "remote-ref"
  remote?: string
  readIgnoredArtifactSource: (artifactId: string, path: string) => Promise<Buffer | undefined>
  readAnnotationCrop: (
    ref: string,
    mimeType: "image/png" | "image/jpeg" | "image/webp",
  ) => Promise<Uint8Array>
}): Promise<PreparedSessionTransferIntent> {
  if (
    input.snapshot.machine.id !== input.sourceMachineId
    || input.snapshot.project?.id !== input.sourceProjectId
    || input.sourceMachineId === input.targetMachineId
  ) {
    throw new SessionTransferStateError("session-state-invalid")
  }
  const state = portableSessionTransferState(input.snapshot, input.sessionId, input.usage)
  const artifactSources: ArtifactSourceResource[] = []
  const annotationCrops: AnnotationCropResource[] = []
  try {
    for (const artifact of state.artifacts) {
      if (!artifact.path) continue
      const bytes = await input.readIgnoredArtifactSource(artifact.id, artifact.path)
      if (!bytes) continue
      artifactSources.push({
        artifactId: artifact.id,
        path: artifact.path,
        bytes,
        digest: sha256(bytes),
      })
    }
    const crops = new Map<string, AnnotationCropResource>()
    for (const annotation of state.annotations) {
      const visual = annotation.visualContext
      if (visual?.status !== "available" || crops.has(visual.ref)) continue
      const bytes = Buffer.from(await input.readAnnotationCrop(visual.ref, visual.mimeType))
      crops.set(visual.ref, {
        ref: visual.ref,
        mimeType: visual.mimeType,
        bytes,
        digest: sha256(bytes),
      })
    }
    annotationCrops.push(...crops.values())
  } catch (cause) {
    throw new SessionTransferStateError("session-resource-unavailable", { cause })
  }

  const coverage = coverageFor(
    input.snapshot,
    state,
    artifactSources.length,
    annotationCrops.length,
  )
  const intentPayload = {
    contractVersion: 1,
    sourceMachineId: input.sourceMachineId,
    targetMachineId: input.targetMachineId,
    sourceProjectId: input.sourceProjectId,
    targetProjectId: input.targetProjectId,
    lineageCommit: input.lineageCommit,
    sourceHeadCommit: input.sourceHeadCommit,
    worktreeDigest: input.worktreeDigest,
    method: input.method,
    ...(input.remote ? { remote: input.remote } : {}),
    state,
    resources: [
      ...artifactSources.map(({ artifactId, path, digest, bytes }) => ({
        kind: "artifact-source" as const,
        artifactId,
        path,
        digest,
        byteLength: bytes.byteLength,
      })),
      ...annotationCrops.map(({ ref, mimeType, digest, bytes }) => ({
        kind: "annotation-crop" as const,
        ref,
        mimeType,
        digest,
        byteLength: bytes.byteLength,
      })),
    ],
    coverage,
  }
  const intentDigest = sha256(`domovoi.session-transfer-intent.v1\0${canonicalJson(intentPayload)}`)
  const preview = sessionTransferPreviewSchema.parse({
    contractVersion: 1,
    sessionId: input.sessionId,
    sourceMachineId: input.sourceMachineId,
    targetMachineId: input.targetMachineId,
    intentDigest,
    coverage,
    project: {
      sourceProjectId: input.sourceProjectId,
      targetProjectId: input.targetProjectId,
      lineageCommit: input.lineageCommit,
      sourceHeadCommit: input.sourceHeadCommit,
    },
    allowed: true,
  }) as AllowedTransferPreview
  return {
    preview,
    state,
    method: input.method,
    ...(input.remote ? { remote: input.remote } : {}),
    worktreeDigest: input.worktreeDigest,
    artifactSources,
    annotationCrops,
  }
}

export function sessionTransferManifestDigest(manifest: SessionTransferManifest): string {
  const validated = sessionTransferManifestSchema.parse(manifest)
  return sha256(`${sessionTransferManifestDomain}${canonicalJson(validated)}`)
}

function member(
  member: SessionTransferMember,
  bytes: Buffer,
): { member: SessionTransferMember, bytes: Buffer } {
  return { member, bytes }
}

export function createSessionTransferPackage(
  intent: PreparedSessionTransferIntent,
  input: {
    transferId: string
    checkpointCommit: string
    repository:
      | { method: "git-bundle", bytes: Buffer }
      | { method: "remote-ref", remote: string, ref: string, commit: string }
    createdAt: string
  },
): PackagedSessionTransfer {
  if (input.repository.method !== intent.method) {
    throw new SessionTransferStateError("session-state-changed")
  }
  const stateBytes = Buffer.from(canonicalJson(intent.state), "utf8")
  const members = [
    member({
      memberId: "state",
      kind: "session-state",
      digest: sha256(stateBytes),
      byteLength: stateBytes.byteLength,
    }, stateBytes),
    ...(input.repository.method === "git-bundle" ? [member({
      memberId: "repository",
      kind: "repository-bundle",
      digest: sha256(input.repository.bytes),
      byteLength: input.repository.bytes.byteLength,
    }, input.repository.bytes)] : []),
    ...intent.artifactSources.map((resource, index) => member({
      memberId: `artifact-source-${index}`,
      kind: "artifact-source",
      artifactId: resource.artifactId,
      digest: resource.digest,
      byteLength: resource.bytes.byteLength,
    }, resource.bytes)),
    ...intent.annotationCrops.map((resource, index) => member({
      memberId: `annotation-crop-${index}`,
      kind: "annotation-crop",
      ref: resource.ref,
      mimeType: resource.mimeType,
      digest: resource.digest,
      byteLength: resource.bytes.byteLength,
    }, resource.bytes)),
  ]
  const manifest = sessionTransferManifestSchema.parse({
    version: 1,
    transferId: input.transferId,
    sessionId: intent.state.session.id,
    sourceMachineId: intent.preview.sourceMachineId,
    targetMachineId: intent.preview.targetMachineId,
    intentDigest: intent.preview.intentDigest,
    createdAt: input.createdAt,
    ownership: {
      fromGeneration: intent.state.session.ownershipGeneration,
      toGeneration: intent.state.session.ownershipGeneration + 1,
    },
    project: {
      sourceProjectId: intent.preview.project.sourceProjectId,
      targetProjectId: intent.preview.project.targetProjectId,
      lineageCommit: intent.preview.project.lineageCommit,
      checkpointCommit: input.checkpointCommit,
    },
    repository: input.repository.method === "git-bundle"
      ? { method: "git-bundle", memberId: "repository" }
      : input.repository,
    stateMemberId: "state",
    members: members.map(({ member: descriptor }) => descriptor),
    totalBytes: members.reduce((total, entry) => total + entry.bytes.byteLength, 0),
    coverage: intent.preview.coverage,
  })
  return {
    manifest,
    manifestDigest: sessionTransferManifestDigest(manifest),
    members,
  }
}
