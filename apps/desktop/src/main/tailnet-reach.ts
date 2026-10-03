import { X509Certificate } from "node:crypto"
import { isIPv4, isIPv6 } from "node:net"

import type { DaemonServiceTailnetChange } from "@getdomovoi/daemon"

import type { TailnetReachOutcome, TailnetReachReport, TailnetReachStep } from "../shared/tailnet-reach.js"
import { tailnetFiles, type TailnetReachRecord } from "./tailnet-reach-record.js"

// TailnetReach (Q404 A, J25): "Reach this machine from my tailnet". Domovoi
// reads the tailnet status and changes nothing until the switch is turned on.
// On: one certificate for this machine's own name from `tailscale cert`,
// stored in the Domovoi profile, then one restart so the daemon also answers
// on the tailnet address. Off: the files the switch wrote are deleted and the
// daemon restarts on loopback only. Never a tailnet setting, an access rule or
// a DNS entry. Loaded with import() only when Settings asks, so none of it
// counts toward the main process's startup bundle.

export type TailscaleResult = { code: number | null; stdout: string; stderr: string }

// "missing": no tailscale command where Domovoi looks for one.
export type TailscaleRun = (args: readonly string[], timeoutMs: number) => Promise<TailscaleResult | "missing">

export type TailnetReachFiles = {
  exists(path: string): Promise<boolean>
  read(path: string): Promise<Buffer>
  // A new private directory inside parent, which is made private when missing.
  privateDirectory(parent: string): Promise<string>
  move(from: string, to: string): Promise<void>
  // Owner read and write only.
  restrict(path: string): Promise<void>
  // A file; one that is already gone is not an error.
  remove(path: string): Promise<void>
  removeDirectory(path: string): Promise<void>
}

export type TailnetReachDependencies = {
  tailscale: TailscaleRun
  // <profile>/tls, where the certificate and key are stored.
  tlsDirectory: string
  display(path: string): string
  files: TailnetReachFiles
  record: {
    read(): Promise<TailnetReachRecord | undefined>
    write(record: TailnetReachRecord): Promise<void>
    remove(): Promise<void>
  }
  // Why the daemon cannot restart now (a turn running, a gate waiting, a
  // daemon this app neither started nor installed), or undefined.
  preflight(): Promise<string | undefined>
  // Applies the change to the daemon this app runs or the login service it
  // installed, and restarts it once.
  restart(change: DaemonServiceTailnetChange): Promise<{ ok: true } | { ok: false; message: string }>
  // After a restart that failed, once the settings are gone again: starts the
  // daemon as it was before the switch was touched.
  recover?(): Promise<void>
  // Why the daemon this app runs would not use the switch's settings (a
  // hand-set DOMOVOI_HOST beyond loopback), or undefined.
  conflict?(): string | undefined
  // Renewal's timers and clock. Defaults: setTimeout, unref'd, and Date.now.
  timers?: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void }
  now?(): number
}

// Renewal (Q404 follow-up): Tailscale's certificates come from Let's Encrypt
// and last 90 days. `tailscale cert --min-validity 720h` returns the one it
// holds unless that is valid for less than 30 days, so checking every 12
// hours replaces it about 30 days before it expires and leaves 30 days of
// failed tries before it lapses. The first check runs a minute after the
// module loads, which a saved record does at startup; a failure is tried
// again after an hour.
export const renewalMinimumValidity = "720h"
export const renewalCheckMs = 12 * 60 * 60_000
export const renewalRetryMs = 60 * 60_000
export const renewalFirstCheckMs = 60_000

export type TailnetRenewal = "off" | "busy" | "unchanged" | "renewed" | "failed"

const defaultTimers = {
  set: (run: () => void, ms: number): unknown => setTimeout(run, ms).unref(),
  clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const statusTimeoutMs = 10_000
// tailscale cert waits on the ACME exchange, which takes tens of seconds.
const certificateTimeoutMs = 120_000
const maximumDetailLength = 1_024

type Tailnet = { name: string; address: string; httpsCertificates: boolean }

function detail(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= maximumDetailLength ? trimmed : `${trimmed.slice(0, maximumDetailLength - 1)}…`
}

// The first line tailscale cert wrote, ending in one full stop, or its exit.
function certificateRefusal(result: TailscaleResult): string {
  const first = (result.stderr.trim().split("\n")[0] ?? "").trim().replace(/[.\s]+$/u, "").slice(0, 300)
  return `${first || `tailscale cert exited with ${result.code ?? "a signal"}`}.`
}

function tailscaleAddress(addresses: unknown): string | undefined {
  if (!Array.isArray(addresses)) return undefined
  const strings = addresses.filter((value): value is string => typeof value === "string")
  return strings.find((value) => isIPv4(value) && /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u.test(value))
    ?? strings.find((value) => isIPv6(value) && value.toLowerCase().startsWith("fd7a:115c:a1e0:"))
}

const hostName = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u

// What `tailscale status --json` says about this machine, or why there is no
// tailnet to reach.
function readTailnet(result: TailscaleResult | "missing"): Tailnet | { none: string } {
  if (result === "missing") return { none: "Domovoi found no tailscale command on this computer." }
  if (result.code !== 0) return { none: detail(result.stderr) || `tailscale status exited with ${result.code ?? "a signal"}.` }
  let parsed: unknown
  try { parsed = JSON.parse(result.stdout) } catch {
    return { none: "tailscale status did not answer in JSON." }
  }
  // Only these three fields are read, each checked for its type below.
  const status = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>
  const self = (typeof status.Self === "object" && status.Self !== null ? status.Self : {}) as Record<string, unknown>
  if (status.BackendState !== "Running") {
    return { none: `Tailscale is not running on this computer (${typeof status.BackendState === "string" ? status.BackendState.slice(0, 64) : "no state"}).` }
  }
  const name = typeof self.DNSName === "string" ? self.DNSName.replace(/\.$/u, "").toLowerCase() : ""
  const address = tailscaleAddress(self.TailscaleIPs)
  if (!hostName.test(name) || address === undefined) return { none: "Tailscale gives this computer no tailnet name and address." }
  return { name, address, httpsCertificates: Array.isArray(status.CertDomains) && status.CertDomains.includes(name) }
}

export class TailnetReach {
  #busy = false
  #renewalTimer: unknown
  #renewalFailure: { at: string; message: string } | undefined

  constructor(private readonly deps: TailnetReachDependencies) {}

  get #timers() {
    return this.deps.timers ?? defaultTimers
  }

  #schedule(ms: number | undefined): void {
    if (this.#renewalTimer !== undefined) this.#timers.clear(this.#renewalTimer)
    this.#renewalTimer = ms === undefined ? undefined : this.#timers.set(() => { void this.renew() }, ms)
  }

  #fail(message: string): "failed" {
    this.#renewalFailure = { at: new Date(this.deps.now?.() ?? Date.now()).toISOString(), message }
    return "failed"
  }

  // Starts the renewal checks when the switch is on. Called when the module
  // loads; turning the switch on or off starts or stops them as well.
  async startRenewal(): Promise<void> {
    if (await this.deps.record.read()) this.#schedule(renewalFirstCheckMs)
  }

  stopRenewal(): void {
    this.#schedule(undefined)
  }

  // One renewal check. It writes only the recorded certificate and key, and
  // restarts the daemon only when Tailscale handed back a different
  // certificate. Any failure keeps the current certificate and is reported
  // with the switch's state until a check succeeds.
  async renew(): Promise<TailnetRenewal> {
    if (this.#busy) {
      this.#schedule(renewalRetryMs)
      return "busy"
    }
    this.#busy = true
    let result: TailnetRenewal = "failed"
    try {
      result = await this.#renew()
      if (result === "unchanged" || result === "renewed" || result === "off") this.#renewalFailure = undefined
      return result
    } finally {
      this.#busy = false
      this.#schedule(result === "off" ? undefined : result === "failed" ? renewalRetryMs : renewalCheckMs)
    }
  }

  async #renew(): Promise<TailnetRenewal> {
    const record = await this.deps.record.read()
    if (!record) return "off"
    const { name, certPath, keyPath } = record
    const pending = await this.deps.files.privateDirectory(this.deps.tlsDirectory)
    try {
      const pendingCert = `${pending}/${name}.crt`
      const pendingKey = `${pending}/${name}.key`
      const issued = await this.deps.tailscale(["cert", "--cert-file", pendingCert, "--key-file", pendingKey, "--min-validity", renewalMinimumValidity, name], certificateTimeoutMs)
      if (issued === "missing") return this.#fail(`Domovoi found no tailscale command to renew the certificate for ${name}.`)
      if (issued.code !== 0) return this.#fail(`Tailscale did not renew the certificate for ${name}: ${certificateRefusal(issued)}`)
      const current = await this.deps.files.read(certPath).catch(() => undefined)
      if (current?.equals(await this.deps.files.read(pendingCert))) return "unchanged"

      const refusal = await this.deps.preflight()
      if (refusal !== undefined) return this.#fail(`A new certificate is ready, but the daemon cannot restart now: ${refusal} The current certificate stays until the next try.`)
      const previousCert = `${pending}/previous.crt`
      const previousKey = `${pending}/previous.key`
      const keptCert = current !== undefined
      const keptKey = await this.deps.files.exists(keyPath)
      if (keptCert) await this.deps.files.move(certPath, previousCert)
      if (keptKey) await this.deps.files.move(keyPath, previousKey)
      await this.deps.files.move(pendingCert, certPath)
      await this.deps.files.move(pendingKey, keyPath)
      await this.deps.files.restrict(keyPath)
      const restarted = await this.deps.restart({ set: { address: record.address, name, certPath, keyPath } })
      if (restarted.ok) return "renewed"
      if (keptCert) await this.deps.files.move(previousCert, certPath)
      if (keptKey) {
        await this.deps.files.move(previousKey, keyPath)
        await this.deps.files.restrict(keyPath)
      }
      await this.deps.recover?.()
      return this.#fail(`A new certificate is ready, but the daemon did not restart: ${restarted.message} The previous certificate was put back.`)
    } catch (cause) {
      return this.#fail(`The certificate for ${name} could not be renewed: ${detail(cause instanceof Error ? cause.message : String(cause))}`)
    } finally {
      await this.deps.files.removeDirectory(pending).catch(() => {})
    }
  }

  // The same two paths the record parser holds a record to.
  #paths(name: string): { certPath: string; keyPath: string } {
    return tailnetFiles(this.deps.tlsDirectory, name)
  }

  #stored(name: string): string {
    return `${this.deps.display(this.#paths(name).certPath)}, .key`
  }

  async #expiry(certPath: string): Promise<string | undefined> {
    try {
      const notAfter = new Date(new X509Certificate(await this.deps.files.read(certPath)).validTo)
      return Number.isNaN(notAfter.getTime()) ? undefined : notAfter.toISOString()
    } catch {
      return undefined
    }
  }

  async #onReport(record: TailnetReachRecord): Promise<TailnetReachReport> {
    const expiresAt = await this.#expiry(record.certPath)
    const ignored = this.deps.conflict?.()
    return {
      state: "on", name: record.name, address: record.address, stored: this.#stored(record.name), httpsCertificates: true,
      ...(expiresAt ? { certificateExpiresAt: expiresAt } : {}),
      ...(this.#renewalFailure ? { renewalFailed: { ...this.#renewalFailure } } : {}),
      ...(ignored ? { ignored } : {}),
    }
  }

  async status(): Promise<TailnetReachReport> {
    const record = await this.deps.record.read()
    // On, the record answers: turning it off must not depend on Tailscale.
    if (record) return this.#onReport(record)
    const tailnet = readTailnet(await this.deps.tailscale(["status", "--json"], statusTimeoutMs))
    if ("none" in tailnet) return { state: "none", detail: tailnet.none }
    const ignored = this.deps.conflict?.()
    return {
      state: "off", name: tailnet.name, address: tailnet.address, stored: this.#stored(tailnet.name), httpsCertificates: tailnet.httpsCertificates,
      ...(ignored ? { ignored } : {}),
    }
  }

  // The renderer's request, as the IPC channel passes it on unread.
  async act(action: unknown): Promise<TailnetReachReport | TailnetReachOutcome> {
    if (action === "status") return this.status()
    if (action === "on") return this.turnOn()
    if (action === "off") return this.turnOff()
    throw new Error("Desktop received an invalid tailnet action")
  }

  // Also renews: turned on again, it replaces the files it wrote before.
  turnOn(): Promise<TailnetReachOutcome> {
    return this.#exclusive("status", () => this.#turnOn())
  }

  turnOff(): Promise<TailnetReachOutcome> {
    return this.#exclusive("status", () => this.#turnOff())
  }

  async #exclusive(step: TailnetReachStep, run: () => Promise<TailnetReachOutcome>): Promise<TailnetReachOutcome> {
    if (this.#busy) return { ok: false, reason: "busy", step, message: "The switch is already changing." }
    this.#busy = true
    try {
      return await run()
    } finally {
      this.#busy = false
    }
  }

  async #refusal(step: TailnetReachStep): Promise<TailnetReachOutcome | undefined> {
    const refusal = await this.deps.preflight()
    return refusal === undefined ? undefined
      : { ok: false, reason: "refused", step, message: `The daemon cannot restart now: ${refusal} Nothing was changed.` }
  }

  async #turnOn(): Promise<TailnetReachOutcome> {
    const conflict = this.deps.conflict?.()
    if (conflict) return { ok: false, reason: "refused", step: "status", message: `${conflict} Nothing was changed.` }
    const refused = await this.#refusal("status")
    if (refused) return refused
    const tailnet = readTailnet(await this.deps.tailscale(["status", "--json"], statusTimeoutMs))
    if ("none" in tailnet) return { ok: false, reason: "none", step: "status", message: tailnet.none }
    const { name, address } = tailnet
    const httpsOff = `HTTPS certificates are off for ${name.split(".").slice(1).join(".")}.`
    if (!tailnet.httpsCertificates) return { ok: false, reason: "https-off", step: "certificate", message: httpsOff }

    const { certPath, keyPath } = this.#paths(name)
    const previous = await this.deps.record.read()
    const owned = new Set(previous ? [previous.certPath, previous.keyPath] : [])
    // tailscale cert writes into a private directory first, so a refused or
    // failed request leaves nothing in the profile. Turned on again (Renew
    // now), the files in use are set aside there too and put back, with the
    // record, if the new ones cannot be stored or the restart fails
    // (review of 049b1383, P2-2).
    const pending = await this.deps.files.privateDirectory(this.deps.tlsDirectory)
    const kept: Array<[aside: string, path: string]> = []
    try {
      const pendingCert = `${pending}/${name}.crt`
      const pendingKey = `${pending}/${name}.key`
      const issued = await this.deps.tailscale(["cert", "--cert-file", pendingCert, "--key-file", pendingKey, name], certificateTimeoutMs)
      if (issued === "missing") return { ok: false, reason: "none", step: "certificate", message: "Domovoi found no tailscale command on this computer." }
      if (issued.code !== 0) {
        const words = detail(issued.stderr)
        // No cause is read into Tailscale's words: the message carries its
        // first line as it is, and the detail the rest.
        return {
          ok: false, reason: "failed", step: "certificate",
          message: `Tailscale did not issue a certificate for ${name}: ${certificateRefusal(issued)} Nothing was stored and nothing restarted.`,
          ...(words ? { detail: words } : {}),
        }
      }
      for (const path of [certPath, keyPath]) {
        if (!owned.has(path) && await this.deps.files.exists(path)) {
          return {
            ok: false, reason: "refused", step: "store",
            message: `A file Domovoi did not write is already at ${this.deps.display(path)}. Domovoi does not replace it. Nothing was stored and nothing restarted.`,
          }
        }
      }
      try {
        for (const [path, aside] of [[certPath, `${pending}/previous.crt`], [keyPath, `${pending}/previous.key`]] as const) {
          if (owned.has(path) && await this.deps.files.exists(path)) {
            await this.deps.files.move(path, aside)
            kept.push([aside, path])
          }
        }
        await this.deps.files.move(pendingCert, certPath)
        await this.deps.files.move(pendingKey, keyPath)
        await this.deps.files.restrict(keyPath)
      } catch (cause) {
        await this.#forget([certPath, keyPath])
        await this.#putBack(kept)
        return {
          ok: false, reason: "failed", step: "store",
          message: `The certificate could not be stored in ${this.deps.display(this.deps.tlsDirectory)}. ${kept.length ? "The previous certificate was put back. " : ""}Nothing was restarted.`,
          detail: detail(cause instanceof Error ? cause.message : String(cause)),
        }
      }

      const record: TailnetReachRecord = { version: 1, name, address, certPath, keyPath }
      await this.deps.record.write(record)
      const restarted = await this.deps.restart({ set: { address, name, certPath, keyPath } })
      if (!restarted.ok) {
        await this.#forget([certPath, keyPath])
        await this.#putBack(kept)
        if (previous) await this.deps.record.write(previous)
        else await this.deps.record.remove()
        await this.deps.recover?.()
        return {
          ok: false, reason: "failed", step: "restart",
          message: previous
            ? `${restarted.message} The previous certificate was put back, and the switch stays on.`
            : `${restarted.message} The certificate and key were deleted again, and the switch stays off.`,
        }
      }
      // Review of 049b1383 (P3-b): Tailscale renamed this machine. The
      // previous name's files were the switch's own; the record named them.
      if (previous && previous.certPath !== certPath) await this.#forget([previous.certPath, previous.keyPath])
      this.#renewalFailure = undefined
      this.#schedule(renewalCheckMs)
      return { ok: true, report: await this.#onReport(record) }
    } finally {
      await this.deps.files.removeDirectory(pending).catch(() => {})
    }
  }

  // The files a change set aside, back where they were.
  async #putBack(kept: ReadonlyArray<readonly [aside: string, path: string]>): Promise<void> {
    for (const [aside, path] of kept) {
      await this.deps.files.move(aside, path)
      if (path.endsWith(".key")) await this.deps.files.restrict(path)
    }
  }

  async #turnOff(): Promise<TailnetReachOutcome> {
    const refused = await this.#refusal("delete")
    if (refused) return refused
    const record = await this.deps.record.read()
    if (record) {
      for (const path of [record.certPath, record.keyPath]) {
        try {
          await this.deps.files.remove(path)
        } catch (cause) {
          return {
            ok: false, reason: "failed", step: "delete",
            message: `${this.deps.display(path)} could not be deleted, so the switch stays on.`,
            detail: detail(cause instanceof Error ? cause.message : String(cause)),
          }
        }
      }
      await this.deps.record.remove()
    }
    this.#schedule(undefined)
    this.#renewalFailure = undefined
    const restarted = await this.deps.restart({ clear: true })
    if (!restarted.ok) {
      return {
        ok: false, reason: "failed", step: "restart",
        message: `The certificate and key were deleted, but the daemon did not restart: ${restarted.message}`,
      }
    }
    return { ok: true, report: await this.status() }
  }

  async #forget(paths: readonly string[]): Promise<void> {
    for (const path of paths) await this.deps.files.remove(path).catch(() => {})
  }
}
