import { createHash } from "node:crypto"
import { join } from "node:path"
import { z } from "zod"
import {
  buildVersion, updateChannelSchema, updateRootMetadataSchema, updateSnapshotMetadataSchema,
  updateStatusSchema, updateTargetsMetadataSchema, updateTimestampMetadataSchema,
  type UpdateActivateParams, type UpdateCheckParams, type UpdateStatus,
} from "@getdomovoi/protocol"

import { readLocalProfileFile } from "./local-owner-record.js"
import { assertProfileLeaseHeld, type ProfileLease } from "./profile-lease.js"
import {
  persistTrustedUpdateMetadata, readTrustedUpdateMetadata, stageVerifiedUpdate,
  type BootstrapInstall, type TrustedUpdateMetadata, type VerifiedUpdateTarget,
} from "./update-state.js"
import {
  compareVersions, fetchUpdateMetadata, maximumUpdateMetadataBytes, selectUpdateTarget,
  UpdateVerificationError, verifyUpdateChain,
} from "./update-verification.js"

const updateUrlSchema = z.url().max(2048).refine((value) => {
  const url = new URL(value)
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
})

export const storedUpdatePolicySchema = z.object({
  format: z.literal(1),
  channel: updateChannelSchema,
  metadataBaseUrl: updateUrlSchema,
  artifactBaseUrl: updateUrlSchema,
  trustedRoot: updateRootMetadataSchema,
  automaticChecks: z.boolean(),
}).strict()

export type DaemonUpdateOptions = {
  homeDirectory: string
  lease: ProfileLease
  fetcher?: typeof fetch
  install?: BootstrapInstall
}

type Refusal = NonNullable<UpdateStatus["refusal"]>

const activationRefusal: Refusal = {
  reason: "policy",
  message: "Activation is unavailable until the idle-boundary and platform activation matrix are implemented.",
}

class UpdateRefusal extends Error {
  constructor(readonly refusal: Refusal) { super(refusal.message) }
}

function readPolicy(homeDirectory: string) {
  try {
    return storedUpdatePolicySchema.parse(JSON.parse(readLocalProfileFile(
      join(homeDirectory, ".domovoi", "update-policy.json"), maximumUpdateMetadataBytes,
    )))
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
    throw new UpdateRefusal({ reason: "policy", message: "Stored update policy is invalid or inaccessible." })
  }
}

function verificationRefusal(error: unknown): Refusal {
  if (error instanceof UpdateRefusal) return error.refusal
  if (error instanceof UpdateVerificationError) {
    const messages = {
      expired: "Signed update metadata has expired.",
      signature: "Update metadata signature verification failed.",
      replay: "Update metadata conflicts with previously trusted metadata.",
      "target-mismatch": "Signed metadata does not bind the served update metadata.",
      "malformed-metadata": "Update metadata could not be verified.",
      network: "Update metadata could not be fetched within its limits.",
    } satisfies Record<UpdateVerificationError["reason"], string>
    return { reason: error.reason, message: messages[error.reason] }
  }
  return { reason: "malformed-metadata", message: "Update metadata could not be verified." }
}

export class DaemonUpdates {
  #options: DaemonUpdateOptions | undefined
  #status: UpdateStatus = { channel: "stable", currentVersion: buildVersion, state: "idle" }
  #pending: VerifiedUpdateTarget | undefined
  #checking: Promise<UpdateStatus> | undefined
  #stopped = false

  constructor(options?: DaemonUpdateOptions) {
    this.#options = options
    if (options) {
      try {
        const policy = readPolicy(options.homeDirectory)
        if (policy) this.#status.channel = policy.channel
      } catch {
        this.#fail({ reason: "policy", message: "Stored update policy is invalid or inaccessible." })
      }
    }
  }

  status(): UpdateStatus { return updateStatusSchema.parse(this.#status) }

  check(params: UpdateCheckParams = {}): Promise<UpdateStatus> {
    if (this.#stopped) return Promise.resolve(this.#refused({ reason: "policy", message: "The updater is stopping." }))
    if (this.#checking) {
      if (params.channel && params.channel !== this.#status.channel) {
        return Promise.resolve(this.#refused({ reason: "busy", message: "An update check for another channel is already running." }))
      }
      return this.#checking
    }
    this.#status = {
      channel: params.channel ?? this.#status.channel, currentVersion: buildVersion,
      state: "checking", lastCheckAt: new Date().toISOString(),
    }
    this.#checking = this.#check().finally(() => { this.#checking = undefined })
    return this.#checking
  }

  activate(params: UpdateActivateParams = {}): UpdateStatus {
    if (this.#stopped) return this.#refused({ reason: "policy", message: "The updater is stopping." })
    if (this.#checking) return this.#refused({ reason: "busy", message: "An update check is still running." })
    if (!this.#pending) return this.#fail({ reason: "policy", message: "There is no verified pending update to activate." })
    if (params.version !== undefined && params.version !== this.#pending.version) {
      return this.#refused({ reason: "target-mismatch", message: "The requested version is not the verified pending update." })
    }
    this.#status = { ...this.#status, state: "deferred", refusal: activationRefusal }
    return this.status()
  }

  async stop(): Promise<void> {
    this.#stopped = true
    await this.#checking
  }

  #refused(refusal: Refusal): UpdateStatus {
    return updateStatusSchema.parse({
      channel: this.#status.channel, currentVersion: buildVersion,
      ...(this.#status.lastCheckAt ? { lastCheckAt: this.#status.lastCheckAt } : {}),
      state: "failed", refusal,
    })
  }

  #fail(refusal: Refusal): UpdateStatus {
    this.#status = {
      ...this.#refused(refusal),
      ...(this.#pending ? { state: "deferred", channel: this.#pending.channel, pendingVersion: this.#pending.version, pendingSourceCommit: this.#pending.sourceCommit } : {}),
    }
    return this.status()
  }

  async #check(): Promise<UpdateStatus> {
    let failure: Refusal = { reason: "policy", message: "Update policy or trusted metadata is unavailable." }
    try {
      const options = this.#options
      if (!options) return this.#fail(failure)
      assertProfileLeaseHeld(options.lease)
      const policy = readPolicy(options.homeDirectory)
      if (!policy) return this.#fail(failure)
      const trusted = await readTrustedUpdateMetadata(options.homeDirectory)
      failure = { reason: "network", message: "Update metadata could not be fetched within its limits." }
      const values = await fetchUpdateMetadata(policy.metadataBaseUrl, options.fetcher)
      let next: TrustedUpdateMetadata
      let target: VerifiedUpdateTarget | undefined
      try {
        const root = verifyUpdateChain({
          root: values["root.json"], timestamp: values["timestamp.json"],
          snapshot: values["snapshot.json"], targets: values["targets.json"], raw: values.raw,
        }, policy.trustedRoot)
        const timestamp = updateTimestampMetadataSchema.parse(values["timestamp.json"])
        const snapshot = updateSnapshotMetadataSchema.parse(values["snapshot.json"])
        const targets = updateTargetsMetadataSchema.parse(values["targets.json"])
        const digest = (name: string) => createHash("sha256").update(values.raw[name]!).digest("hex")
        next = {
          format: 1, rootVersion: root.signed.version, rootDigest: digest("root.json"),
          timestampVersion: timestamp.signed.version, timestampDigest: digest("timestamp.json"),
          snapshotVersion: snapshot.signed.version, snapshotDigest: digest("snapshot.json"),
          targetsVersion: targets.signed.version, targetsDigest: digest("targets.json"),
        }
        for (const role of ["root", "timestamp", "snapshot", "targets"] as const) {
          if (next[`${role}Version`] < trusted[`${role}Version`]
            || (next[`${role}Version`] === trusted[`${role}Version`] && next[`${role}Digest`] !== trusted[`${role}Digest`])) {
            throw new UpdateRefusal({ reason: "replay", message: "Update metadata conflicts with previously trusted metadata." })
          }
        }
        const selected = selectUpdateTarget(targets, this.#status.channel, buildVersion)
        if (selected) {
          const entry = targets.signed.targets[selected.name]!
          if (selected.name !== `getdomovoi-daemon-${selected.version}.tgz`) {
            throw new UpdateRefusal({ reason: "target-mismatch", message: "The signed target name does not match its version." })
          }
          if (entry.custom.minimumUpdaterVersion && compareVersions(entry.custom.minimumUpdaterVersion, buildVersion) > 0) {
            throw new UpdateRefusal({ reason: "policy", message: "This target requires a newer updater." })
          }
          target = { ...selected, sha256: entry.hashes.sha256, channel: entry.custom.channel, runtimeLockDigest: entry.custom.runtimeLockDigest }
        }
      } catch (error) { return this.#fail(verificationRefusal(error)) }
      failure = { reason: "target-mismatch", message: "The verified update could not be staged successfully." }
      if (target) {
        // Re-staging the same runtime can affect its bytes, so its previous
        // pending authority must be re-earned by staging and persistence.
        if (target.version === this.#pending?.version) this.#pending = undefined
        await stageVerifiedUpdate({ ...options, target, baseUrl: policy.artifactBaseUrl })
      }
      failure = { reason: "policy", message: "Verified update metadata could not be persisted; the checked target is not pending." }
      await persistTrustedUpdateMetadata(options.homeDirectory, options.lease, next)
      this.#pending = target
      this.#status = target
        ? { ...this.#status, state: "pending", pendingVersion: target.version, pendingSourceCommit: target.sourceCommit }
        : { channel: this.#status.channel, currentVersion: buildVersion, state: "idle", lastCheckAt: this.#status.lastCheckAt }
      return this.status()
    } catch (error) {
      return this.#fail(error instanceof UpdateRefusal ? error.refusal : failure)
    }
  }
}
