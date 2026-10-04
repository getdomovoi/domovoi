import { createPrivateKey, X509Certificate } from "node:crypto"
import { isIPv4, isIPv6 } from "node:net"

import type { DaemonServiceTailnetChange } from "@getdomovoi/daemon"
import type { TailnetListenerStatus } from "@getdomovoi/protocol"

import type { TailnetReachOutcome, TailnetReachReport, TailnetReachRetained, TailnetReachStep } from "../shared/tailnet-reach.js"
import { tailnetFiles, tailnetName, type TailnetReachRecord } from "./tailnet-reach-record.js"

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
  // renamed runs once the file is at to, before anything after the rename
  // that can still fail (the flush), so the caller knows it moved.
  move(from: string, to: string, renamed?: () => void): Promise<void>
  // Owner read and write only.
  restrict(path: string): Promise<void>
  // Codex review round 1 (P2-4): who a file is, as device:inode:mark, or
  // undefined when nothing is at path; and the mark the switch sets on each
  // file it writes, which a file put there later does not carry.
  identity(path: string): Promise<string | undefined>
  mark(path: string): Promise<void>
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
    // Where the record is saved, named when it cannot be deleted (Q418 A).
    path: string
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
  // Why the switch cannot clear the tailnet listener of the daemon this app
  // runs (DOMOVOI_TAILNET_* set by hand in its environment), or undefined.
  handSet?(): string | undefined
  // A pending directory the sweep at load left because it holds previous
  // files: from a change that could not put them back, or from one cut off
  // before it finished. The sweep cannot tell which.
  setAside?(): Promise<string | undefined>
  // Codex review round 1 (P2-5): the checks an issued certificate and key
  // pass before they replace anything (default tailnetMaterialCheck), and the
  // daemon's tailnet.status after a restart, read from the daemon this window
  // reaches; undefined when there is none to ask.
  check?(cert: Buffer, key: Buffer, name: string, now: number): { notAfter: string } | { refused: string }
  listener(): Promise<TailnetListenerStatus | undefined>
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
// Review of PR #713 (P3): the whole status read, from the record and the
// executable lookup to the notes, answers within the subprocess's own timeout
// plus the 5 seconds the assembly gives each daemon read, so a subprocess
// timeout still answers in its own words and only a stall outside it reaches
// this. The renderer's 120 second deadline for automatic reads stays above it.
const statusDeadlineMs = statusTimeoutMs + 5_000
// Q436 B: past the deadline the switch is not known, not off and not without a
// tailnet, so the read refuses in the words the card's own deadline uses.
const statusUnanswered = "The desktop did not answer."
// The refusal at that deadline, told apart from a read that failed. Its name
// stays Error, so the bridge cuts Electron's prefix from it as from any other.
class StatusUnanswered extends Error {
  constructor() {
    super(statusUnanswered)
  }
}
// tailscale cert waits on the ACME exchange, which takes tens of seconds.
const certificateTimeoutMs = 120_000
const maximumDetailLength = 1_024

// Codex review round 6 (P3-2) and round 7 (P3-3, Q419 A): what a turn-off
// says when the restart fails after the record was deleted but the files set
// aside could not be: the record is gone, the files remain in the named
// directory, and the restart failed in its own words.
function restartFailedWithRetainedFiles(directory: string, why: string): string {
  return `The setting was removed, but the certificate and key in ${directory} could not be deleted, and the daemon did not restart: ${why}`
}

type Tailnet = { name: string; address: string; httpsCertificates: boolean }

function detail(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= maximumDetailLength ? trimmed : `${trimmed.slice(0, maximumDetailLength - 1)}…`
}

// A further sentence, or nothing, after a message.
function sentence(text: string): string {
  return text ? ` ${text}` : ""
}

// The first line tailscale cert wrote, ending in one full stop, or its exit.
function certificateRefusal(result: TailscaleResult): string {
  const first = (result.stderr.trim().split("\n")[0] ?? "").trim().replace(/[.\s]+$/u, "").slice(0, 300)
  return `${first || `tailscale cert exited with ${result.code ?? "a signal"}`}.`
}

// Codex review round 1 (P2-5): what tailscale cert wrote is used only when the
// certificate reads as X.509, has not expired, names this machine, and the key
// belongs to it. The answer is its notAfter, as the daemon reports it in
// tailnet.status, or why not, as a clause after "was not used:".
export function tailnetMaterialCheck(cert: Buffer, key: Buffer, name: string, now: number): { notAfter: string } | { refused: string } {
  let certificate: X509Certificate
  try {
    certificate = new X509Certificate(cert)
  } catch {
    return { refused: "it is not a certificate Domovoi can read." }
  }
  const notAfter = new Date(certificate.validTo)
  if (Number.isNaN(notAfter.getTime())) return { refused: "it is not a certificate Domovoi can read." }
  if (notAfter.getTime() <= now) return { refused: `it expired on ${notAfter.toISOString().slice(0, 10)}.` }
  if (certificate.checkHost(name) === undefined) return { refused: `it is not for ${name}.` }
  let privateKey
  try {
    privateKey = createPrivateKey(key)
  } catch {
    return { refused: "the key could not be read." }
  }
  let belongs: boolean
  try {
    belongs = certificate.checkPrivateKey(privateKey)
  } catch {
    belongs = false
  }
  return belongs ? { notAfter: notAfter.toISOString() } : { refused: "the key does not belong to it." }
}

function tailscaleAddress(addresses: unknown): string | undefined {
  if (!Array.isArray(addresses)) return undefined
  const strings = addresses.filter((value): value is string => typeof value === "string")
  return strings.find((value) => isIPv4(value) && /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u.test(value))
    ?? strings.find((value) => isIPv6(value) && value.toLowerCase().startsWith("fd7a:115c:a1e0:"))
}


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
  if (!tailnetName(name) || address === undefined) return { none: "Tailscale gives this computer no tailnet name and address." }
  return { name, address, httpsCertificates: Array.isArray(status.CertDomains) && status.CertDomains.includes(name) }
}

export class TailnetReach {
  #busy = false
  #renewalTimer: unknown
  #renewalFailure: { at: string; message: string } | undefined
  // Where a change in this session left previous files it could not put back.
  #keptPending: string | undefined
  // Where a turn-off in this session set the files aside, deleted the record,
  // and then could not delete them (Q417 A).
  #undeletedPending: string | undefined
  // Counts each start and end of a change or renewal, so a status read in
  // flight is shared only with reads from the same stretch.
  #generation = 0
  // The status read in flight, from when it starts until it settles. Later
  // reads of the same generation wait on it, each under its own deadline,
  // instead of starting another that stalls on the same dependency.
  #inFlight: { generation: number; work: Promise<TailnetReachReport> } | undefined

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
    this.#changing(true)
    let result: TailnetRenewal = "failed"
    try {
      result = await this.#renew()
      if (result === "unchanged" || result === "renewed" || result === "off") this.#renewalFailure = undefined
      return result
    } finally {
      this.#changing(false)
      this.#schedule(result === "off" ? undefined : result === "failed" ? renewalRetryMs : renewalCheckMs)
    }
  }

  async #renew(): Promise<TailnetRenewal> {
    const record = await this.deps.record.read()
    if (!record) return "off"
    const { name, certPath, keyPath } = record
    const failed = (cause: unknown, after = "") =>
      this.#fail(`The certificate for ${name} could not be renewed: ${detail(cause instanceof Error ? cause.message : String(cause))}${sentence(after)}`)
    // Codex review round 1 (P2-4): only over files that are still the ones
    // the switch wrote. A file that is gone is replaced; a different one is
    // left alone.
    for (const [path, recorded] of [[certPath, record.certIdentity], [keyPath, record.keyIdentity]] as const) {
      let found: string | undefined
      try {
        found = await this.deps.files.identity(path)
      } catch (cause) {
        return failed(cause)
      }
      if (found !== undefined && found !== recorded) return this.#fail(`${this.deps.display(path)} is not the file the switch wrote, so Domovoi does not renew over it.`)
    }
    // Round 4 review (P3-1): a directory that cannot be made (a full disk, a
    // profile it may not write) is a failed renewal like any other.
    let pending: string
    try {
      pending = await this.deps.files.privateDirectory(this.deps.tlsDirectory)
    } catch (cause) {
      return failed(cause)
    }
    const swap = this.#swap(pending, [certPath, keyPath])
    let recorded = false
    let restarting = false
    try {
      const pendingCert = `${pending}/${name}.crt`
      const pendingKey = `${pending}/${name}.key`
      const issued = await this.deps.tailscale(["cert", "--cert-file", pendingCert, "--key-file", pendingKey, "--min-validity", renewalMinimumValidity, name], certificateTimeoutMs)
      if (issued === "missing") return this.#fail(`Domovoi found no tailscale command to renew the certificate for ${name}.`)
      if (issued.code !== 0) return this.#fail(`Tailscale did not renew the certificate for ${name}: ${certificateRefusal(issued)}`)
      const current = await this.deps.files.read(certPath).catch(() => undefined)
      if (current?.equals(await this.deps.files.read(pendingCert))) return "unchanged"
      const checked = await this.#checked(pendingCert, pendingKey, name)
      if ("refused" in checked) return this.#fail(`Tailscale's new certificate for ${name} was not used: ${checked.refused} The current certificate stays.`)

      const refusal = await this.deps.preflight()
      if (refusal !== undefined) return this.#fail(`A new certificate is ready, but the daemon cannot restart now: ${refusal} The current certificate stays until the next try.`)
      await swap.place(pendingCert, pendingKey, certPath, keyPath)
      // The new files are new files: marked, and their identities recorded.
      const renewed = await this.#marked(record)
      recorded = true
      await this.deps.record.write(renewed)
      restarting = true
      const change: DaemonServiceTailnetChange = { set: { address: record.address, name, certPath, keyPath } }
      const restarted = await this.deps.restart(change)
      if (restarted.ok) {
        const problem = await this.#taken(checked.notAfter, "the new certificate")
        if (problem === undefined) {
          swap.commit()
          return "renewed"
        }
        // The daemon restarted on loopback without the new certificate on the
        // tailnet: the previous pair goes back, and the daemon restarts on it.
        const undone = await swap.undo()
        await this.deps.record.write(record)
        const back = await this.deps.restart(change).catch(() => ({ ok: false as const }))
        if (!back.ok) await this.deps.recover?.()
        return this.#fail(`${problem}${sentence(undone)}`)
      }
      const undone = await swap.undo()
      await this.deps.record.write(record)
      await this.deps.recover?.()
      return this.#fail(`A new certificate is ready, but the daemon did not restart: ${restarted.message}${sentence(undone)}`)
    } catch (cause) {
      // Round 3 re-review (P2): anything else that throws, from a file that
      // was never written to a restart that could not even be asked, is a
      // failed renewal like the others: put back, recovered, reported. renew
      // runs from a timer, so nothing may escape it.
      const undone = await swap.undo()
      if (recorded) await this.deps.record.write(record).catch(() => {})
      if (restarting) await this.deps.recover?.().catch(() => {})
      return failed(cause, undone)
    } finally {
      if (swap.removable()) await this.deps.files.removeDirectory(pending).catch(() => {})
    }
  }

  // Re-review of 10dba4a2 (P3-1): replacing the switch's files sets the ones
  // in use aside in pending and moves the new ones in. undo deletes only the
  // paths a new file was moved into and moves the previous files back; when
  // that fails the previous files stay in pending, which is then kept, and
  // the line says where they are.
  //
  // Round 3 re-review (P2): pending is removed only when it holds nothing of
  // the files in use: nothing was set aside, the change committed, or undo put
  // everything back. undo runs at most once.
  //
  // Codex review round 1 (P2-1): a move renames and then flushes, and the
  // flush can fail after the rename. Each move is counted from the rename on
  // (the renamed callback), so a file moved by a move that then failed is
  // still put back, or deleted, and pending is kept while it holds a previous
  // file. Undo tries every previous file, not only those before a failure.
  #swap(pending: string, owned: readonly string[]) {
    // The previous files now in pending, and how many were ever set aside.
    const aside: Array<[aside: string, path: string]> = []
    let setAside = 0
    const placed: string[] = []
    let committed = false
    let undone: Promise<string> | undefined
    const undo = async (): Promise<string> => {
      await this.#forget(placed)
      for (const entry of [...aside]) {
        const [from, path] = entry
        await this.deps.files.move(from, path, () => { aside.splice(aside.indexOf(entry), 1) }).catch(() => {})
        if (!aside.includes(entry) && path.endsWith(".key")) await this.deps.files.restrict(path).catch(() => {})
      }
      if (aside.length) {
        this.#keptPending = pending
        return `The previous certificate and key could not be put back and are in ${this.deps.display(pending)}.`
      }
      return setAside ? "The previous certificate was put back." : ""
    }
    // An owned file at path, moved into pending as previous.crt or .key.
    const putAside = async (path: string): Promise<void> => {
      const previous = `${pending}/previous.${path.endsWith(".key") ? "key" : "crt"}`
      if (owned.includes(path) && await this.deps.files.exists(path)) {
        await this.deps.files.move(path, previous, () => { aside.push([previous, path]); setAside += 1 })
      }
    }
    return {
      commit: () => { committed = true },
      committed: () => committed,
      removable: () => committed || aside.length === 0,
      setAside: putAside,
      place: async (newCert: string, newKey: string, certPath: string, keyPath: string): Promise<void> => {
        await putAside(certPath)
        await putAside(keyPath)
        await this.deps.files.move(newCert, certPath, () => { placed.push(certPath) })
        await this.deps.files.move(newKey, keyPath, () => { placed.push(keyPath) })
        await this.deps.files.restrict(keyPath)
      },
      // The sentence that says what became of the previous files.
      undo: (): Promise<string> => (undone ??= undo()),
      kept: () => setAside > 0,
      stranded: () => undone !== undefined && aside.length > 0,
    }
  }

  // Codex review round 1 (P2-5): the issued pair, read from pending, and the
  // checks it passes or why not.
  async #checked(pendingCert: string, pendingKey: string, name: string): Promise<{ notAfter: string } | { refused: string }> {
    const cert = await this.deps.files.read(pendingCert)
    const key = await this.deps.files.read(pendingKey)
    return (this.deps.check ?? tailnetMaterialCheck)(cert, key, name, this.deps.now?.() ?? Date.now())
  }

  // Undefined once the restarted daemon reports it serves the certificate
  // that expires at notAfter on the tailnet, or has it and waits for the
  // address (Tailscale not up yet, retrying). Otherwise the sentence that says
  // it did not take it, or that Domovoi could not find out.
  async #taken(notAfter: string, what: string): Promise<string | undefined> {
    let status: TailnetListenerStatus | undefined
    try {
      status = await this.deps.listener()
    } catch (cause) {
      return `Domovoi could not confirm that the daemon took ${what} for the tailnet (${detail(cause instanceof Error ? cause.message : String(cause))}).`
    }
    if (status === undefined) return `Domovoi could not confirm that the daemon took ${what} for the tailnet: this window reaches no daemon.`
    if (status.state !== "off" && status.certificateExpiresAt === notAfter && (status.state === "listening" || status.retrying)) return undefined
    const why = status.state === "refused" ? status.reason
      : status.state === "off" ? "it reports no tailnet listener."
        : "it serves another certificate on the tailnet."
    return `The daemon did not take ${what} for the tailnet: ${why}`
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
    return {
      state: "on", name: record.name, address: record.address, stored: this.#stored(record.name), httpsCertificates: true,
      ...(expiresAt ? { certificateExpiresAt: expiresAt } : {}),
      ...(this.#renewalFailure ? { renewalFailed: { ...this.#renewalFailure } } : {}),
      ...await this.#notes(),
    }
  }

  // What the switch alone does not say: about the daemon inside this app, and
  // about previous files a change left in a pending directory (round 3
  // re-review, P3-3). Round 4 review (P3-3): one this session could not put
  // back is named apart from one the sweep found at load, and each only while
  // it still holds previous files.
  // Q417 A: and one a turn-off could not remove once the record was gone.
  async #notes(): Promise<{ ignored?: string; handSet?: string } & TailnetReachRetained> {
    const ignored = this.deps.conflict?.()
    const handSet = this.deps.handSet?.()
    return { ...(ignored ? { ignored } : {}), ...(handSet ? { handSet } : {}), ...await this.#retained() }
  }

  // Codex review round 6 (P3-1): the directories still holding files, said
  // with every state. Turning off does not need Tailscale, so neither does
  // naming what it could not delete.
  async #retained(): Promise<TailnetReachRetained> {
    if (this.#keptPending !== undefined && !(await this.#holdsPrevious(this.#keptPending))) this.#keptPending = undefined
    if (this.#undeletedPending !== undefined && !(await this.#holdsPrevious(this.#undeletedPending))) this.#undeletedPending = undefined
    const kept = this.#keptPending
    const undeleted = this.#undeletedPending
    const found = await this.deps.setAside?.()
    const setAside = found !== undefined && found !== kept && found !== undeleted && await this.#holdsPrevious(found) ? found : undefined
    return {
      ...(kept ? { kept: this.deps.display(kept) } : {}), ...(setAside ? { setAside: this.deps.display(setAside) } : {}),
      ...(undeleted ? { undeleted: this.deps.display(undeleted) } : {}),
    }
  }

  // The swap sets files in use aside under these two names only.
  async #holdsPrevious(directory: string): Promise<boolean> {
    // An exists that refuses (tls became a link) answers no, so the switch's
    // state still answers.
    for (const file of ["previous.crt", "previous.key"]) if (await this.deps.files.exists(`${directory}/${file}`).catch(() => false)) return true
    return false
  }

  // Review of PR #713 (P3): answers by statusDeadlineMs, or refuses when the
  // read has not settled by then (Q436 B). What the read answers later goes
  // nowhere for this call. The deadline cancels nothing: the executable
  // lookup, the file reads and the tailscale process, which keeps its own
  // timeout, run on until they settle.
  status(): Promise<TailnetReachReport> {
    const generation = this.#generation
    const work = this.#inFlight?.generation === generation ? this.#inFlight.work : this.#started(generation)
    return new Promise((resolve, reject) => {
      const deadline = this.#timers.set(() => reject(new StatusUnanswered()), statusDeadlineMs)
      work.then(
        (report) => { this.#timers.clear(deadline); resolve(report) },
        (cause: unknown) => { this.#timers.clear(deadline); reject(cause) },
      )
    })
  }

  // Codex review of PR #722 (P3-1): a read is registered when it starts, so a
  // read that overlaps it joins it before any deadline fires, and only its own
  // settling frees the slot. A read from an earlier generation is replaced in
  // the slot, not shared, and its settling leaves the newer one in place.
  #started(generation: number): Promise<TailnetReachReport> {
    const entry = { generation, work: this.#status() }
    this.#inFlight = entry
    const release = () => { if (this.#inFlight === entry) this.#inFlight = undefined }
    entry.work.then(release, release)
    return entry.work
  }

  async #status(): Promise<TailnetReachReport> {
    const record = await this.deps.record.read()
    // On, the record answers: turning it off must not depend on Tailscale.
    if (record) return this.#onReport(record)
    const tailnet = readTailnet(await this.deps.tailscale(["status", "--json"], statusTimeoutMs))
    if ("none" in tailnet) return { state: "none", detail: tailnet.none, ...await this.#retained() }
    return {
      state: "off", name: tailnet.name, address: tailnet.address, stored: this.#stored(tailnet.name), httpsCertificates: tailnet.httpsCertificates,
      ...await this.#notes(),
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

  // Codex review of PR #722 (P3-2), Q439 B: the status after a turn-off is
  // read once the change has ended and released the switch, as a public read
  // under the deadline in the generation after the change, so the card's own
  // read after the change joins it instead of starting a second one that
  // stalls on the same dependency. Past the deadline the turn-off is still
  // done: it answers so, with the files it could not delete, and no state it
  // did not read. Trade-off: a turn-on can start while that read is pending.
  // It is its own change: it starts a new generation, so no read after it is
  // handed this one, and its own answer comes from its own record. This
  // turn-off's answer is then the state as read just after the turn-off.
  async turnOff(): Promise<TailnetReachOutcome> {
    const changed = await this.#exclusive("status", () => this.#turnOff())
    if (!("done" in changed)) return changed
    try {
      return { ok: true, report: await this.status() }
    } catch (cause) {
      // A read that failed, not one past its deadline, is thrown as before.
      if (!(cause instanceof StatusUnanswered)) throw cause
      return { ok: true, statusUnanswered: true, ...(changed.undeleted === undefined ? {} : { undeleted: this.deps.display(changed.undeleted) }) }
    }
  }

  async #exclusive<T>(step: TailnetReachStep, run: () => Promise<T>): Promise<T | TailnetReachOutcome> {
    if (this.#busy) return { ok: false, reason: "busy", step, message: "The switch is already changing." }
    this.#changing(true)
    try {
      return await run()
    } finally {
      this.#changing(false)
    }
  }

  // A status read in flight from before a change, or from during one, is not
  // shared with a read after it.
  #changing(busy: boolean): void {
    this.#busy = busy
    this.#generation += 1
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
    // Codex review round 1 (P2-4): the previous files are the switch's only
    // while they carry the identities it recorded.
    const owned = previous ? await this.#owned(previous) : new Set<string>()
    // tailscale cert writes into a private directory first, so a refused or
    // failed request leaves nothing in the profile. Turned on again (Renew
    // now), the files in use are set aside there too and put back, with the
    // record, if the new ones cannot be stored or the restart fails
    // (review of 049b1383, P2-2).
    // Codex review round 1 (P2-2): the directory cannot be made when tls is
    // a link or not a directory; nothing is changed then.
    let pending: string
    try {
      pending = await this.deps.files.privateDirectory(this.deps.tlsDirectory)
    } catch (cause) {
      return {
        ok: false, reason: "failed", step: "store",
        message: `The certificate could not be stored in ${this.deps.display(this.deps.tlsDirectory)}. Nothing was stored and nothing restarted.`,
        detail: detail(cause instanceof Error ? cause.message : String(cause)),
      }
    }
    const swap = this.#swap(pending, [...owned])
    let recorded = false
    let restarting = false
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
      const checked = await this.#checked(pendingCert, pendingKey, name)
      if ("refused" in checked) {
        return {
          ok: false, reason: "failed", step: "certificate",
          message: `Tailscale's certificate for ${name} was not used: ${checked.refused} Nothing was stored and nothing restarted.`,
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
      let record: TailnetReachRecord
      try {
        await swap.place(pendingCert, pendingKey, certPath, keyPath)
        record = await this.#marked({ version: 1, name, address, certPath, keyPath })
      } catch (cause) {
        const undone = await swap.undo()
        return {
          ok: false, reason: "failed", step: "store",
          message: `The certificate could not be stored in ${this.deps.display(this.deps.tlsDirectory)}. ${undone ? `${undone} ` : ""}Nothing was restarted.`,
          detail: detail(cause instanceof Error ? cause.message : String(cause)),
        }
      }

      recorded = true
      await this.deps.record.write(record)
      restarting = true
      const restarted = await this.deps.restart({ set: { address, name, certPath, keyPath } })
      // Codex review round 1 (P2-5): a restart counts once the daemon says
      // it serves the new certificate on the tailnet.
      const problem = restarted.ok ? await this.#taken(checked.notAfter, "the certificate") : restarted.message
      if (problem !== undefined) {
        const undone = await swap.undo()
        if (previous) await this.deps.record.write(previous)
        else await this.deps.record.remove()
        if (restarted.ok) {
          // It restarted without it: restart again on what was there before.
          const back = await this.deps.restart(previous
            ? { set: { address: previous.address, name: previous.name, certPath: previous.certPath, keyPath: previous.keyPath } }
            : { clear: true }).catch(() => ({ ok: false as const }))
          if (!back.ok) await this.deps.recover?.()
        } else {
          await this.deps.recover?.()
        }
        return {
          ok: false, reason: "failed", step: "restart",
          message: swap.stranded() ? `${problem} ${undone}`
            : previous ? `${problem} ${swap.kept() ? "The previous certificate was put back" : "The previous certificate stays in use"}, and the switch stays on.`
              : `${problem} The certificate and key were deleted again, and the switch stays off.`,
        }
      }
      // Review of 049b1383 (P3-b): Tailscale renamed this machine. The
      // previous name's files were the switch's own; the record named them.
      swap.commit()
      if (previous && previous.certPath !== certPath) await this.#forgetOwned(previous)
      this.#renewalFailure = undefined
      this.#schedule(renewalCheckMs)
      return { ok: true, report: await this.#onReport(record) }
    } catch (cause) {
      // Round 3 re-review (P2): a throw after the swap, from writing the
      // record to a restart that could not even be asked, puts everything
      // back as a failed restart does, and is answered, not thrown.
      if (swap.committed()) throw cause
      const undone = await swap.undo()
      if (recorded) await (previous ? this.deps.record.write(previous) : this.deps.record.remove()).catch(() => {})
      if (restarting) await this.deps.recover?.().catch(() => {})
      return {
        ok: false, reason: "failed", step: restarting ? "restart" : recorded ? "store" : "certificate",
        message: `Turning it on stopped: ${detail(cause instanceof Error ? cause.message : String(cause))}${sentence(undone)}`,
      }
    } finally {
      if (swap.removable()) await this.deps.files.removeDirectory(pending).catch(() => {})
    }
  }

  // A refusal or failure, or done: the record is gone and the daemon
  // restarted, with the pending directory holding files it could not delete.
  async #turnOff(): Promise<TailnetReachOutcome | { done: true; undeleted?: string }> {
    const refused = await this.#refusal("delete")
    if (refused) return refused
    const record = await this.deps.record.read()
    // The pending directory holding files this turn-off could not delete.
    let undeleted: string | undefined
    if (record) {
      // Codex review round 1 (P2-4): nothing is deleted unless both files
      // are gone or still the ones the switch wrote.
      const present: string[] = []
      for (const [path, recorded] of [[record.certPath, record.certIdentity], [record.keyPath, record.keyIdentity]] as const) {
        let found: string | undefined
        try {
          found = await this.deps.files.identity(path)
        } catch (cause) {
          return {
            ok: false, reason: "failed", step: "delete",
            message: `${this.deps.display(path)} could not be deleted, so the switch stays on.`,
            detail: detail(cause instanceof Error ? cause.message : String(cause)),
          }
        }
        if (found !== undefined && found !== recorded) {
          return {
            ok: false, reason: "refused", step: "delete",
            message: `${this.deps.display(path)} is not the file the switch wrote. Domovoi deletes only files it wrote, so nothing was deleted and the switch stays on. Move that file away, then turn the switch off again.`,
          }
        }
        if (found !== undefined) present.push(path)
      }
      const forgotten = await this.#forgetRecorded(present)
      if ("ok" in forgotten) return forgotten
      undeleted = forgotten.undeleted
    }
    this.#schedule(undefined)
    this.#renewalFailure = undefined
    const restarted = await this.deps.restart({ clear: true })
    if (!restarted.ok) {
      // Codex review round 6 (P3-2): with files it could not delete, the
      // answer names their directory, so the deletion is not drawn as done.
      return undeleted === undefined ? {
        ok: false, reason: "failed", step: "restart",
        message: `The certificate and key were deleted, but the daemon did not restart: ${restarted.message}`,
      } : {
        ok: false, reason: "failed", step: "restart", undeleted: this.deps.display(undeleted),
        message: restartFailedWithRetainedFiles(this.deps.display(undeleted), restarted.message),
      }
    }
    // Done; turnOff reads the status once the switch is released.
    return { done: true, ...(undeleted === undefined ? {} : { undeleted }) }
  }

  // Review of PR #713 (P2): turning off sets the switch's files aside in a
  // pending directory, deletes the record, and only then deletes the files.
  // When a file cannot be set aside, or the record cannot be deleted, the
  // files go back, so the switch stays on as it was: both files and the
  // record. A file that cannot be put back stays in pending, and the switch's
  // state says where, as for a change that turned on. A record that cannot be
  // deleted is named as a file is (Q418 A), once the files are back.
  //
  // The answer is the refusal, or the record is gone and the answer names the
  // pending directory when the files set aside could not be deleted.
  async #forgetRecorded(present: readonly string[]): Promise<TailnetReachOutcome | { undeleted?: string }> {
    const stays = (path: string, cause: unknown): TailnetReachOutcome => ({
      ok: false, reason: "failed", step: "delete",
      message: `${this.deps.display(path)} could not be deleted, so the switch stays on.`,
      detail: detail(cause instanceof Error ? cause.message : String(cause)),
    })
    if (!present.length) {
      try {
        await this.deps.record.remove()
      } catch (cause) {
        return stays(this.deps.record.path, cause)
      }
      return {}
    }
    let pending: string
    try {
      pending = await this.deps.files.privateDirectory(this.deps.tlsDirectory)
    } catch (cause) {
      return stays(present[0]!, cause)
    }
    const swap = this.#swap(pending, present)
    let retained: string | undefined
    try {
      for (const path of present) {
        try {
          await swap.setAside(path)
        } catch (cause) {
          await swap.undo()
          return stays(path, cause)
        }
      }
      try {
        await this.deps.record.remove()
      } catch (cause) {
        await swap.undo()
        return stays(this.deps.record.path, cause)
      }
      swap.commit()
    } finally {
      // Q417 A: once the record is gone the switch is off, and files it could
      // not delete are named at once.
      if (swap.removable()) await this.deps.files.removeDirectory(pending).catch(() => { if (swap.committed()) retained = this.#undeletedPending = pending })
    }
    return retained === undefined ? {} : { undeleted: retained }
  }

  async #forget(paths: readonly string[]): Promise<void> {
    for (const path of paths) await this.deps.files.remove(path).catch(() => {})
  }

  // Codex review round 1 (P2-4): the record's paths whose files carry the
  // identities it holds. One that cannot be read is not owned.
  async #owned(record: TailnetReachRecord): Promise<Set<string>> {
    const owned = new Set<string>()
    for (const [path, recorded] of [[record.certPath, record.certIdentity], [record.keyPath, record.keyIdentity]] as const) {
      if (await this.deps.files.identity(path).catch(() => undefined) === recorded) owned.add(path)
    }
    return owned
  }

  // Deletes the record's files that are still the switch's, read again just
  // before.
  async #forgetOwned(record: TailnetReachRecord): Promise<void> {
    await this.#forget([...await this.#owned(record)])
  }

  // Marks the two files just placed as the switch's (a mark a file put there
  // later does not carry) and gives the record that names them.
  async #marked(base: Omit<TailnetReachRecord, "certIdentity" | "keyIdentity">): Promise<TailnetReachRecord> {
    const identities: string[] = []
    for (const path of [base.certPath, base.keyPath]) {
      await this.deps.files.mark(path)
      const identity = await this.deps.files.identity(path)
      if (identity === undefined) throw new Error(`${this.deps.display(path)} was gone before it could be recorded.`)
      identities.push(identity)
    }
    return { version: 1, name: base.name, address: base.address, certPath: base.certPath, keyPath: base.keyPath, certIdentity: identities[0]!, keyIdentity: identities[1]! }
  }
}
