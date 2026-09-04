import { createHash, randomUUID } from "node:crypto"
import { open, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  sessionTransferManifestSchema,
  transferIdSchema,
  transferMemberParamsSchema,
  transferMemberResultSchema,
  transferPrepareResultSchema,
  transferStatusResultSchema,
  type SessionTransferManifest,
  type TransferMemberParams,
  type TransferMemberResult,
  type TransferPrepareResult,
  type TransferStatusResult,
} from "@getdomovoi/protocol"

import { sessionTransferManifestDigest } from "./session-transfer-package.js"

type StoredManifest = {
  manifestDigest: string
  manifest: SessionTransferManifest
}

type CommittedStatus = Extract<TransferStatusResult, { state: "committed" }>
type TransferRecoveryStage = Extract<TransferStatusResult, { state: "recovering" }>[
  "stage"
]
type TransferFailureReason = Extract<TransferStatusResult, { state: "failed" }>["reason"]

const manifestFile = "manifest.json"
const statusFile = "status.json"
const membersDirectory = "members"
const chunksDirectory = "chunks"
const chunkName = /^(0|[1-9][0-9]*)-(0|1)\.chunk$/u

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600, flush: true })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export class FileTransferTransactions {
  readonly #root: string

  constructor(root: string) {
    this.#root = root
  }

  async prepare(
    rawManifest: SessionTransferManifest,
    suppliedDigest: string,
  ): Promise<TransferPrepareResult> {
    const manifest = sessionTransferManifestSchema.parse(rawManifest)
    if (sessionTransferManifestDigest(manifest) !== suppliedDigest) {
      return transferPrepareResultSchema.parse({
        state: "refused",
        transferId: manifest.transferId,
        reason: "digest-mismatch",
      })
    }
    await mkdir(this.#root, { recursive: true, mode: 0o700 })
    const path = this.#path(manifest.transferId)
    const temporary = join(this.#root, `.${manifest.transferId}-${randomUUID()}`)
    try {
      await mkdir(temporary, { mode: 0o700 })
      await Promise.all([
        mkdir(join(temporary, membersDirectory), { mode: 0o700 }),
        mkdir(join(temporary, chunksDirectory), { mode: 0o700 }),
        writeFile(
          join(temporary, manifestFile),
          JSON.stringify({ manifestDigest: suppliedDigest, manifest }),
          { flag: "wx", mode: 0o600, flush: true },
        ),
        writeFile(
          join(temporary, statusFile),
          JSON.stringify({ state: "receiving", transferId: manifest.transferId }),
          { flag: "wx", mode: 0o600, flush: true },
        ),
      ])
      try {
        await rename(temporary, path)
      } catch (error) {
        if (!new Set(["EEXIST", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) {
          throw error
        }
      }
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => {})
    }

    const stored = await this.#stored(manifest.transferId)
    if (stored.manifestDigest !== suppliedDigest) {
      return transferPrepareResultSchema.parse({
        state: "refused",
        transferId: manifest.transferId,
        reason: "digest-mismatch",
      })
    }
    const status = await this.#status(manifest.transferId)
    if (status.state === "committed") return transferPrepareResultSchema.parse(status)
    if (status.state === "aborted") {
      return transferPrepareResultSchema.parse({
        state: "refused",
        transferId: manifest.transferId,
        reason: "session-state-changed",
      })
    }
    if (status.state === "recovering" || status.state === "failed") {
      return transferPrepareResultSchema.parse({
        state: "refused",
        transferId: manifest.transferId,
        reason: "session-resource-unavailable",
      })
    }
    const missingMemberIds = await this.#missingMembers(stored.manifest)
    if (missingMemberIds.length === 0) {
      await this.#writeStatus(manifest.transferId, { state: "prepared", transferId: manifest.transferId })
      return transferPrepareResultSchema.parse({ state: "prepared", transferId: manifest.transferId })
    }
    return transferPrepareResultSchema.parse({
      state: "receiving",
      transferId: manifest.transferId,
      missingMemberIds,
    })
  }

  async acceptMember(rawParams: TransferMemberParams): Promise<TransferMemberResult> {
    const params = transferMemberParamsSchema.parse(rawParams)
    const stored = await this.#stored(params.transferId)
    const descriptor = stored.manifest.members.find(
      (member) => member.memberId === params.memberId,
    )
    if (!descriptor) return this.#memberRefusal(params, "digest-mismatch")
    const completedPath = this.#completedPath(params.transferId, params.memberId)
    try {
      await this.#verifyMember(completedPath, descriptor.byteLength, descriptor.digest)
      const missing = await this.#missingMembers(stored.manifest)
      return transferMemberResultSchema.parse(missing.length === 0
        ? { state: "prepared", transferId: params.transferId }
        : { state: "member-received", transferId: params.transferId, memberId: params.memberId })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }

    const chunkPath = this.#chunkPath(params.transferId, params.memberId)
    await mkdir(chunkPath, { recursive: true, mode: 0o700 })
    const chunks = await this.#chunks(chunkPath)
    const bytes = Buffer.from(params.bytes, "base64")
    if (params.sequence < chunks.length) {
      const existing = chunks[params.sequence]
      if (!existing) return this.#memberRefusal(params, "chunk-out-of-order")
      const prior = await readFile(join(chunkPath, existing.name))
      if (!prior.equals(bytes) || existing.final !== params.final) {
        return this.#memberRefusal(params, "chunk-out-of-order")
      }
      return transferMemberResultSchema.parse({
        state: "receiving",
        transferId: params.transferId,
        memberId: params.memberId,
        nextSequence: chunks.length,
      })
    }
    if (params.sequence !== chunks.length) {
      return this.#memberRefusal(params, "chunk-out-of-order")
    }
    const receivedBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
    const nextBytes = receivedBytes + bytes.byteLength
    if (nextBytes > descriptor.byteLength) {
      return this.#memberRefusal(params, "transfer-too-large")
    }
    if ((params.final && nextBytes !== descriptor.byteLength) || (!params.final && nextBytes >= descriptor.byteLength)) {
      return this.#memberRefusal(params, "digest-mismatch")
    }

    const nextChunk = join(chunkPath, `${params.sequence}-${params.final ? 1 : 0}.chunk`)
    await writeFile(nextChunk, bytes, { flag: "wx", mode: 0o600, flush: true })
    if (!params.final) {
      return transferMemberResultSchema.parse({
        state: "receiving",
        transferId: params.transferId,
        memberId: params.memberId,
        nextSequence: params.sequence + 1,
      })
    }

    const allChunks = [...chunks, {
      name: `${params.sequence}-1.chunk`,
      sequence: params.sequence,
      final: true,
      byteLength: bytes.byteLength,
    }]
    const published = await this.#publishMember(
      chunkPath,
      completedPath,
      allChunks,
      descriptor.byteLength,
      descriptor.digest,
    )
    if (!published) {
      await rm(nextChunk, { force: true })
      return this.#memberRefusal(params, "digest-mismatch")
    }
    await rm(chunkPath, { recursive: true, force: true })
    const missing = await this.#missingMembers(stored.manifest)
    if (missing.length === 0) {
      await this.#writeStatus(params.transferId, { state: "prepared", transferId: params.transferId })
      return transferMemberResultSchema.parse({ state: "prepared", transferId: params.transferId })
    }
    return transferMemberResultSchema.parse({
      state: "member-received",
      transferId: params.transferId,
      memberId: params.memberId,
    })
  }

  async status(transferId: string, manifestDigest: string): Promise<TransferStatusResult> {
    transferIdSchema.parse(transferId)
    try {
      const stored = await this.#stored(transferId)
      if (stored.manifestDigest !== manifestDigest) {
        return transferStatusResultSchema.parse({ state: "unknown", transferId })
      }
      return this.#status(transferId)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return transferStatusResultSchema.parse({ state: "unknown", transferId })
      }
      throw error
    }
  }

  async manifest(transferId: string, manifestDigest: string): Promise<SessionTransferManifest> {
    const stored = await this.#stored(transferId)
    if (stored.manifestDigest !== manifestDigest) throw new Error("Transfer manifest digest changed")
    return stored.manifest
  }

  async memberPath(
    transferId: string,
    manifestDigest: string,
    memberId: string,
  ): Promise<string> {
    const manifest = await this.manifest(transferId, manifestDigest)
    const descriptor = manifest.members.find((member) => member.memberId === memberId)
    if (!descriptor) throw new Error("Transfer member is not declared")
    const path = this.#completedPath(transferId, memberId)
    await this.#verifyMember(path, descriptor.byteLength, descriptor.digest)
    return path
  }

  async readMember(
    transferId: string,
    manifestDigest: string,
    memberId: string,
  ): Promise<Buffer> {
    try {
      return await readFile(await this.memberPath(transferId, manifestDigest, memberId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("Transfer member is incomplete", { cause: error })
      }
      throw error
    }
  }

  async markRecovering(
    transferId: string,
    manifestDigest: string,
    stage: TransferRecoveryStage,
  ): Promise<void> {
    await this.manifest(transferId, manifestDigest)
    await this.#writeStatus(transferId, { state: "recovering", transferId, stage })
  }

  async markFailed(
    transferId: string,
    manifestDigest: string,
    reason: TransferFailureReason,
  ): Promise<void> {
    await this.manifest(transferId, manifestDigest)
    await this.#writeStatus(transferId, { state: "failed", transferId, reason })
  }

  async markCommitted(
    transferId: string,
    manifestDigest: string,
    committed: CommittedStatus,
  ): Promise<void> {
    const manifest = await this.manifest(transferId, manifestDigest)
    if (committed.transferId !== transferId) throw new Error("Committed transfer id changed")
    if (
      committed.checkpointCommit !== manifest.project.checkpointCommit
      || committed.ownershipGeneration !== manifest.ownership.toGeneration
    ) {
      throw new Error("Committed transfer result does not match its manifest")
    }
    await this.#writeStatus(transferId, transferStatusResultSchema.parse(committed))
  }

  async abort(transferId: string, manifestDigest: string): Promise<TransferStatusResult> {
    const manifest = await this.manifest(transferId, manifestDigest)
    const current = await this.#status(transferId)
    if (current.state === "committed") return current
    const aborted = transferStatusResultSchema.parse({ state: "aborted", transferId })
    await this.#writeStatus(transferId, aborted)
    await Promise.all([
      rm(join(this.#path(manifest.transferId), chunksDirectory), { recursive: true, force: true }),
      rm(join(this.#path(manifest.transferId), membersDirectory), { recursive: true, force: true }),
    ])
    return aborted
  }

  #path(transferId: string): string {
    return join(this.#root, transferIdSchema.parse(transferId))
  }

  #completedPath(transferId: string, memberId: string): string {
    return join(this.#path(transferId), membersDirectory, `${memberId}.member`)
  }

  #chunkPath(transferId: string, memberId: string): string {
    return join(this.#path(transferId), chunksDirectory, memberId)
  }

  async #stored(transferId: string): Promise<StoredManifest> {
    const raw: unknown = JSON.parse(await readFile(join(this.#path(transferId), manifestFile), "utf8"))
    if (typeof raw !== "object" || raw === null) throw new Error("Transfer manifest is malformed")
    const record = raw as Record<string, unknown>
    if (typeof record.manifestDigest !== "string") throw new Error("Transfer manifest is malformed")
    const manifest = sessionTransferManifestSchema.parse(record.manifest)
    if (
      manifest.transferId !== transferId
      || sessionTransferManifestDigest(manifest) !== record.manifestDigest
    ) {
      throw new Error("Transfer manifest is malformed")
    }
    return { manifestDigest: record.manifestDigest, manifest }
  }

  async #status(transferId: string): Promise<TransferStatusResult> {
    return transferStatusResultSchema.parse(
      JSON.parse(await readFile(join(this.#path(transferId), statusFile), "utf8")),
    )
  }

  async #writeStatus(transferId: string, status: TransferStatusResult): Promise<void> {
    await writeJson(
      join(this.#path(transferId), statusFile),
      transferStatusResultSchema.parse(status),
    )
  }

  async #missingMembers(manifest: SessionTransferManifest): Promise<string[]> {
    const missing: string[] = []
    for (const member of manifest.members) {
      try {
        await this.#verifyMember(
          this.#completedPath(manifest.transferId, member.memberId),
          member.byteLength,
          member.digest,
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        missing.push(member.memberId)
      }
    }
    return missing
  }

  async #chunks(path: string): Promise<Array<{
    name: string
    sequence: number
    final: boolean
    byteLength: number
  }>> {
    const names = await readdir(path)
    const chunks = await Promise.all(names.map(async (name) => {
      const match = chunkName.exec(name)
      if (!match) throw new Error("Transfer chunk journal is malformed")
      return {
        name,
        sequence: Number(match[1]),
        final: match[2] === "1",
        byteLength: (await readFile(join(path, name))).byteLength,
      }
    }))
    chunks.sort((left, right) => left.sequence - right.sequence)
    if (chunks.some((chunk, index) => chunk.sequence !== index || (chunk.final && index !== chunks.length - 1))) {
      throw new Error("Transfer chunk journal is malformed")
    }
    return chunks
  }

  async #publishMember(
    chunkPath: string,
    completedPath: string,
    chunks: Array<{ name: string, byteLength: number }>,
    expectedBytes: number,
    expectedDigest: string,
  ): Promise<boolean> {
    const temporary = `${completedPath}.${randomUUID()}.tmp`
    const handle = await open(temporary, "wx", 0o600)
    const digest = createHash("sha256")
    let byteLength = 0
    try {
      for (const chunk of chunks) {
        const bytes = await readFile(join(chunkPath, chunk.name))
        byteLength += bytes.byteLength
        digest.update(bytes)
        await handle.write(bytes)
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
    const matches = byteLength === expectedBytes
      && `sha256:${digest.digest("hex")}` === expectedDigest
    if (!matches) {
      await rm(temporary, { force: true })
      return false
    }
    await rename(temporary, completedPath)
    return true
  }

  async #verifyMember(path: string, expectedBytes: number, expectedDigest: string): Promise<void> {
    const handle = await open(path, "r")
    const digest = createHash("sha256")
    let byteLength = 0
    try {
      const metadata = await handle.stat()
      if (!metadata.isFile() || metadata.size !== expectedBytes) {
        throw new Error("Stored transfer member is malformed")
      }
      const chunk = Buffer.allocUnsafe(1_048_576)
      while (byteLength < expectedBytes) {
        const { bytesRead } = await handle.read(
          chunk,
          0,
          Math.min(chunk.byteLength, expectedBytes - byteLength),
          byteLength,
        )
        if (bytesRead === 0) break
        digest.update(chunk.subarray(0, bytesRead))
        byteLength += bytesRead
      }
    } finally {
      await handle.close()
    }
    if (
      byteLength !== expectedBytes
      || `sha256:${digest.digest("hex")}` !== expectedDigest
    ) {
      throw new Error("Stored transfer member is malformed")
    }
  }

  #memberRefusal(
    params: Pick<TransferMemberParams, "transferId">,
    reason: "chunk-out-of-order" | "transfer-too-large" | "digest-mismatch",
  ): TransferMemberResult {
    return transferMemberResultSchema.parse({
      state: "refused",
      transferId: params.transferId,
      reason,
    })
  }
}
