// These are admission limits, not a larger guessing allowance. Pairing codes
// still expire after five wrong guesses. A source gets fewer than five claims
// per minute so it cannot immediately burn every freshly issued code; the
// listener limit also bounds distributed sources and retained limiter state.
export const pairingClaimWindowMs = 60_000
export const maximumPairingClaimsPerSource = 3
export const maximumPairingClaimsPerListener = 30

export class PairingClaimAdmission {
  #sources = new Map<string, number[]>()
  #listener: number[] = []

  admit(source: string | undefined, now = performance.now()): boolean {
    if (!source || !Number.isFinite(now)) return false
    const cutoff = now - pairingClaimWindowMs
    this.#listener = this.#listener.filter((time) => time > cutoff)
    for (const [address, times] of this.#sources) {
      const current = times.filter((time) => time > cutoff)
      if (current.length === 0) this.#sources.delete(address)
      else this.#sources.set(address, current)
    }

    const attempts = this.#sources.get(source) ?? []
    if (
      attempts.length >= maximumPairingClaimsPerSource
      || this.#listener.length >= maximumPairingClaimsPerListener
    ) return false

    // Only admitted claims allocate source state. Each retained source owns at
    // least one of the listener's at-most-30 timestamps, even during IP churn.
    this.#listener.push(now)
    attempts.push(now)
    this.#sources.set(source, attempts)
    return true
  }
}
