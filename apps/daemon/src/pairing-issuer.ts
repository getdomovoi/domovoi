// Ruling Q354 A: the one connection that issued the open client code, the only
// place that code's outcome goes. It holds at most one connection, and lets it
// go when the code ends (an outcome, a replacing code or running out its time)
// or the connection closes, so it never keeps a closed socket (security review
// r1 note).
export class PairingIssuerSlot<Socket> {
  #held: { pairingId: string, socket: Socket, expiry: ReturnType<typeof setTimeout> } | undefined

  // The pairing id this slot holds an issuer for, if any.
  get current(): string | undefined {
    return this.#held?.pairingId
  }

  set(pairingId: string, socket: Socket, ttlMs: number): void {
    this.clear()
    const expiry = setTimeout(() => {
      if (this.#held?.pairingId === pairingId) this.#held = undefined
    }, ttlMs)
    expiry.unref?.()
    this.#held = { pairingId, socket, expiry }
  }

  // The issuer of this code, or undefined for any other. An outcome that ends
  // the code also lets the issuer go.
  issuer(pairingId: string, codeEnded: boolean): Socket | undefined {
    const held = this.#held
    if (held?.pairingId !== pairingId) return undefined
    if (codeEnded) this.clear()
    return held.socket
  }

  forget(socket: Socket): void {
    if (this.#held?.socket === socket) this.clear()
  }

  clear(): void {
    if (this.#held) clearTimeout(this.#held.expiry)
    this.#held = undefined
  }
}
