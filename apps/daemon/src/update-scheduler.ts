import { join } from "node:path"

import { readLocalProfileFile } from "./local-owner-record.js"
import { profileDirectory } from "./profile-directory.js"
import { assertProfileLeaseHeld } from "./profile-lease.js"
import { storedUpdatePolicySchema, type DaemonUpdateOptions, type DaemonUpdates } from "./update-dispatch.js"
import { maximumUpdateMetadataBytes } from "./update-verification.js"

// Local cadence only. No catch-up burst after a slow check or suspended process.
export const automaticUpdateCheckIntervalMs = 60 * 60 * 1000

export class UpdateScheduler {
  #started = false
  #stopped = false
  #timer: ReturnType<typeof setTimeout> | undefined
  #cycle: Promise<void> | undefined

  constructor(
    private readonly options: Pick<DaemonUpdateOptions, "homeDirectory" | "lease">,
    private readonly updates: Pick<DaemonUpdates, "check">,
  ) {}

  start(): void {
    if (this.#started || this.#stopped) return
    this.#started = true
    this.#schedule()
  }

  async stop(): Promise<void> {
    this.#stopped = true
    clearTimeout(this.#timer)
    this.#timer = undefined
    await this.#cycle
  }

  #schedule(): void {
    if (this.#stopped) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      if (this.#stopped) return
      // Own the whole cycle before invoking check, including a synchronous
      // callback that stops the scheduler. Admission itself has no await gap.
      this.#cycle = Promise.resolve().then(async () => {
        if (this.#stopped) return
        assertProfileLeaseHeld(this.options.lease)
        const policy = storedUpdatePolicySchema.parse(JSON.parse(readLocalProfileFile(
          join(profileDirectory(this.options.homeDirectory), "update-policy.json"), maximumUpdateMetadataBytes,
        )))
        if (policy.automaticChecks) await this.updates.check({ channel: policy.channel })
      }).catch(() => {
        // Missing, invalid or inaccessible policy never authorizes work. Do
        // not expose parser details or private policy contents in diagnostics.
        // The updater reports its own verification/network refusals in status.
      }).finally(() => {
        this.#cycle = undefined
        this.#schedule()
      })
    }, automaticUpdateCheckIntervalMs)
    this.#timer.unref()
  }
}
