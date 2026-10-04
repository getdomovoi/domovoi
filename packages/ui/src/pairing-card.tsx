import { encodePairingPayload, phoneAndTabletPromise, type ClientKind } from "@getdomovoi/protocol"
import { CheckIcon, CopyIcon, GlobeIcon, LockIcon, QrCodeIcon, RotateCwIcon, SmartphoneIcon, TabletIcon } from "lucide-react"
import qrcode from "qrcode-generator"
import { useEffect, useMemo, useState } from "react"

import { Button } from "./components/ui/button"
import { useCommandLinkView } from "./command-links.js"
import { printedCommand } from "./printed-command.js"
import { pairingAddressOf, type IssuedPairingCode, type PairingAddressReport } from "./pairing-address.js"
import type { TailnetReachController } from "./tailnet-reach-card.js"

export type { IssuedPairingCode, PairingAddressReport } from "./pairing-address.js"

// The pairing card for Settings > Phone and tablet, from PairingCard in the
// 2026-09-23 desktop design. The desktop asks its own daemon for the same code
// `domovoid pair` prints. A code lives 180 seconds and asking for another
// cancels it. The QR carries the address and the code, never a credential,
// and only a phone or tablet gets one; a browser is told where to type the
// code (Q399). When a phone could not reach or trust the daemon, the card says so instead
// of drawing a QR. What the card cannot know stays undrawn: nothing tells the
// window that issued a code that a device redeemed or was refused it, so the
// paired receipt and the refusals stay in the design.

type Kind = "phone" | "tablet" | "browser"

// The browser's line depends on whether the daemon's owner set the web app
// address, so it is chosen where the code is drawn.
const kinds: Record<Kind, { label: string; noun: string; client: ClientKind; Icon: typeof SmartphoneIcon; how: string }> = {
  phone: { label: "Phone", noun: "a phone", client: "phone", Icon: SmartphoneIcon, how: "Scan it with the Domovoi app, or paste the code." },
  tablet: { label: "Tablet", noun: "a tablet", client: "tablet", Icon: TabletIcon, how: "Scan it with the Domovoi app, or paste the code." },
  browser: { label: "Web browser", noun: "a browser", client: "web", Icon: GlobeIcon, how: "Open Domovoi in the browser on that device and type the code." },
}

const browserAddressHow = "Open this address in the browser on that device, then type the code."

type Problem = { title: string; mono: string; still: string; next: string; refusal?: string; action?: { label: string; primary: boolean; run: () => void } }

// The daemon's problem text is shared with `domovoid pair`, which ends it with
// "then run this again"; the card has its own next step, so the tail goes.
// With the desktop's tailnet switch (Q404 A), the design's two actions lead
// to it: a loopback daemon to the setting, a missing certificate to
// Tailscale, which turning the switch on (or renewing) asks for.
function problemFor(report: PairingAddressReport, kind: Kind, tailnet: TailnetReachController | undefined): Problem | undefined {
  const noun = kinds[kind].noun
  if ("problem" in report) {
    const name = tailnet?.report && tailnet.report.state !== "none" ? tailnet.report.name : "this machine's name"
    if (tailnet?.running?.direction === "on") {
      return { title: "Asking Tailscale for a certificate", mono: `tailscale cert ${name}`, still: "The daemon restarts once the certificate is stored.", next: "The code button comes back when the certificate arrives." }
    }
    if (tailnet?.failure?.outcome.reason === "https-off") {
      return { title: "No code: HTTPS certificates are off for this tailnet", mono: name, still: "Domovoi stopped and changed nothing.", next: "A tailnet admin turns on HTTPS Certificates on the DNS page of the Tailscale admin console.", action: { label: "Try again", primary: false, run: () => void tailnet.turnOn() } }
    }
    return {
      title: `No code: ${noun} would not trust this daemon`, mono: report.problem.replace(/,? then run this again\.$/u, "."), still: "Sessions and this window are unaffected.",
      ...(tailnet
        ? { next: "Ask Tailscale for one. The key stays on this machine.", action: { label: "Get it from Tailscale", primary: true, run: () => void tailnet.turnOn() } }
        : { next: "Give the daemon a certificate for its tailnet name, then show a code." }),
      // Review of 049b1383 (P3-d): why the last request did not get one.
      ...(tailnet?.failure?.direction === "on" ? { refusal: tailnet.failure.outcome.message } : {}),
    }
  }
  if (report.loopback) {
    // A browser on this machine can reach loopback; the one that cannot is
    // elsewhere (ruled 2026-09-23).
    const who = kind === "browser" ? "a browser on another device" : noun
    const name = tailnet?.report && tailnet.report.state !== "none" ? tailnet.report.name : "this machine's name"
    if (tailnet?.running?.direction === "on") {
      return { title: "Making this machine reachable from your tailnet", mono: `tailscale cert ${name}`, still: "The daemon restarts once the certificate is stored.", next: "The code button comes back when the service has restarted." }
    }
    if (tailnet?.failure?.outcome.reason === "https-off") {
      return { title: "No code: HTTPS certificates are off for this tailnet", mono: name, still: "Domovoi stopped and changed nothing.", next: "A tailnet admin turns on HTTPS Certificates on the DNS page of the Tailscale admin console.", action: { label: "Go to the setting", primary: false, run: tailnet.reveal } }
    }
    if (tailnet?.report?.state === "none") {
      return { title: "No code: there is no tailnet on this machine", mono: tailnet.report.detail, still: "Sessions and this window are unaffected.", next: "Domovoi does not set one up for you. Bring Tailscale up, then come back." }
    }
    if (tailnet?.report?.state === "off") {
      return { title: `No code: ${who} cannot reach this machine yet`, mono: "not reachable from your tailnet", still: "Sessions and this window are unaffected.", next: "Turn on Reach this machine from my tailnet, then show a code.", action: { label: "Go to the setting", primary: true, run: tailnet.reveal } }
    }
    return {
      title: `No code: ${who} cannot reach this daemon`, mono: "listening on 127.0.0.1 only", still: "Sessions and this window are unaffected.", next: "Let the daemon answer on your tailnet, then show a code.",
      ...(tailnet ? { action: { label: "Go to the tailnet setting", primary: true, run: tailnet.reveal } } : {}),
    }
  }
  return undefined
}

// What a phone or tablet QR carries: the domovoi-pair payload, the address
// the app dials and the code. A browser gets no QR (Q399): a phone camera
// scanning one opens the phone's own pairing, which greets as a phone, spends
// the web code and leaves an extra device.
function pairingPayloadText(issued: IssuedPairingCode): string | undefined {
  const address = pairingAddressOf(issued)
  if ("problem" in address) return undefined
  return encodePairingPayload({ v: 1, url: address.url, code: issued.code, ...(address.label ? { label: address.label } : {}) })
}

function dialedAddressLabel(issued: IssuedPairingCode): string {
  const address = pairingAddressOf(issued)
  return "problem" in address ? "" : address.label ?? address.url
}

function QrSymbol({ text, label }: { text: string; label: string }) {
  const modules = useMemo(() => {
    const code = qrcode(0, "M")
    code.addData(text)
    code.make()
    const size = code.getModuleCount()
    const cells: string[] = []
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (code.isDark(y, x)) cells.push(`M${x} ${y}h1v1h-1z`)
    return { size, path: cells.join("") }
  }, [text])
  const quiet = 4
  const span = modules.size + quiet * 2
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${span} ${span}`} className="size-[165px] shrink-0 rounded-[calc(var(--radius)-3px)] bg-white" shapeRendering="crispEdges">
      <path transform={`translate(${quiet} ${quiet})`} d={modules.path} fill="oklch(0.16 0.004 285)" />
    </svg>
  )
}

function countdown(expiresAt: string, now: number): number {
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000))
}

export function PairingCard({
  connected,
  readOnly = false,
  inAppDaemon = false,
  onIssueCode,
  onCopy,
  tailnet,
}: {
  connected: boolean
  // A watching window can see the card and ask for nothing.
  readOnly?: boolean
  inAppDaemon?: boolean
  onIssueCode: (client: ClientKind) => Promise<IssuedPairingCode>
  onCopy: (text: string) => Promise<void>
  // The desktop's tailnet switch, the one the Settings card draws.
  tailnet?: TailnetReachController
}) {
  const [kind, setKind] = useState<Kind>("phone")
  // Q336 A: the printed command names what runs on this machine.
  const links = useCommandLinkView()
  const [issued, setIssued] = useState<IssuedPairingCode | null>(null)
  // The kind the shown code was issued for; the picker can move on without it.
  const [issuedKind, setIssuedKind] = useState<Kind>("phone")
  const [replaced, setReplaced] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const left = issued ? countdown(issued.expiresAt, now) : 0
  const live = issued !== null && left > 0
  useEffect(() => {
    if (!live) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [live])

  const show = async () => {
    setPending(true)
    setError("")
    try {
      const asked = kind
      const next = await onIssueCode(kinds[asked].client)
      setReplaced(issued !== null && countdown(issued.expiresAt, Date.now()) > 0)
      setIssued(next)
      setIssuedKind(asked)
      setNow(Date.now())
      setCopied(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The daemon did not issue a code")
    } finally {
      setPending(false)
    }
  }

  const address = issued ? pairingAddressOf(issued) : undefined
  const problem = address ? problemFor(address, issuedKind, tailnet) : undefined
  const expired = issued !== null && left === 0
  const codeShown = issued !== null && !expired && !problem && address !== undefined && !("problem" in address)
  const qrText = issued && issuedKind !== "browser" ? pairingPayloadText(issued) : undefined
  const webAppUrl = issued && issuedKind === "browser" ? issued.webAppUrl : undefined
  const grants = phoneAndTabletPromise.map((line) => ({ text: line.text, tone: line.tone === "granted" ? "bg-success" : "bg-info" }))

  const copy = async () => {
    if (!issued || !address || "problem" in address) return
    // The phone and tablet apps take the payload, address and code together.
    // A browser is already at the address, and its connect page takes the
    // word code alone, so that is what a browser's Copy hands over.
    await onCopy(issuedKind === "browser" ? issued.code : pairingPayloadText(issued) ?? issued.code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex size-[165px] shrink-0 items-center justify-center rounded-[calc(var(--radius)-3px)] border border-dashed text-faint">
          {codeShown && qrText ? (
            <QrSymbol text={qrText} label={`Pairing code for ${dialedAddressLabel(issued)}`} />
          ) : codeShown ? (
            <div className="flex flex-col items-center gap-2 px-3 text-center text-[11px]">
              <GlobeIcon className="size-6" />
              <span>No QR for a browser. Type the code there.</span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-[11px]">
              {readOnly ? <LockIcon className="size-6" /> : <QrCodeIcon className="size-6" />}
              <span>{readOnly ? "Locked for this window" : expired ? "Expired" : problem ? "No code shown" : "The code shows here"}</span>
            </div>
          )}
        </div>
        <div className="flex min-w-[240px] flex-1 flex-col gap-3">
          {!codeShown ? (
            <>
              <div role="group" aria-label="Device kind" className="inline-flex self-start gap-0.5 rounded-[calc(var(--radius)-2px)] border p-0.5">
                {(Object.keys(kinds) as Kind[]).map((id) => {
                  const { label, Icon } = kinds[id]
                  return (
                    <Button key={id} type="button" variant={id === kind ? "secondary" : "ghost"} size="sm" disabled={readOnly} aria-pressed={id === kind} onClick={() => setKind(id)}>
                      <Icon data-icon="inline-start" />
                      {label}
                    </Button>
                  )
                })}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" disabled={readOnly || !connected || pending || tailnet?.running !== undefined} onClick={() => void show()}>
                  {readOnly ? <LockIcon data-icon="inline-start" /> : <QrCodeIcon data-icon="inline-start" />}
                  {expired || problem ? "Show another" : "Show a pairing code"}
                </Button>
                <span className="text-[11px] text-muted-foreground">A code lasts 180 seconds. Showing another cancels it.</span>
              </div>
              {readOnly ? (
                <div className="flex flex-col gap-1">
                  <span className="text-[11.5px] text-warn-dim">Locked: this window is watching only, and only a full client can ask for a code.</span>
                  {/* The daemon's refusal of a watching credential (Q347 A). */}
                  <span className="font-machine text-[10.5px] text-faint">device.issueCode refused · watching-only credential</span>
                </div>
              ) : (
                <div className="flex flex-wrap items-baseline gap-2 text-[11px] text-muted-foreground">
                  <span>The same code as</span>
                  <span className="font-machine text-foreground">{printedCommand(`domovoid pair --client ${kinds[kind].client}`, links)}</span>
                </div>
              )}
            </>
          ) : null}

          {codeShown && issued ? (
            <div className="flex flex-col gap-2">
              <span className="text-[12px]">{webAppUrl ? browserAddressHow : kinds[issuedKind].how}</span>
              {webAppUrl ? <span className="break-all font-machine text-[11px] text-foreground">{webAppUrl}</span> : null}
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md bg-code px-3 py-2 font-machine text-[15px] tracking-wide text-strong">{issued.code}</span>
                <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
                  {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-machine text-[11px] text-muted-foreground">{`${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left`}</span>
                <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => void show()}>
                  <RotateCwIcon data-icon="inline-start" />
                  Show another
                </Button>
                {replaced ? <span className="text-[11px] text-muted-foreground">The previous code no longer works.</span> : null}
              </div>
              {qrText ? (
                <div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
                  <span>The QR holds this address and the code, never a credential:</span>
                  <span className="font-machine text-foreground">{dialedAddressLabel(issued)}</span>
                </div>
              ) : null}
              {kind === "browser" ? (
                <span className="text-[11px] text-muted-foreground">A certificate warning means the address is not this machine's full tailnet name, or its certificate lapsed. Do not click through.</span>
              ) : null}
            </div>
          ) : null}

          {issued && (problem || expired) ? (
            <div className="flex flex-col gap-1.5 rounded-md border px-3 py-2 text-[11.5px]">
              <span className="font-medium text-foreground">{problem ? problem.title : "The code expired"}</span>
              <span className="font-machine text-[10.5px] text-faint">{problem ? problem.mono : `${issued.code} · 180s`}</span>
              <span className="text-muted-foreground">{problem ? problem.still : "No device paired with it."}</span>
              <span className="text-muted-foreground">{problem ? problem.next : "Show another code to try again."}</span>
              {problem?.refusal ? <span role="alert" className="text-destructive">{problem.refusal}</span> : null}
              {problem?.action ? (
                <Button type="button" size="sm" variant={problem.action.primary ? "default" : "outline"} className="mt-1 self-start" onClick={problem.action.run}>{problem.action.label}</Button>
              ) : null}
            </div>
          ) : null}
          {error ? <p role="alert" className="m-0 text-[11.5px] text-destructive">{error}</p> : null}
        </div>
      </div>

      <div className="flex flex-col gap-1.5 border-t pt-3">
        <span id="pairing-grants" className="text-[10.5px] tracking-[0.13em] text-faint">A PAIRED DEVICE CAN</span>
        <ul aria-labelledby="pairing-grants" className="m-0 flex list-none flex-col gap-1 p-0 text-[11.5px]">
          {grants.map((line) => (
            <li key={line.text} className="flex items-start gap-2">
              <span aria-hidden className={`mt-[6px] size-1.5 shrink-0 rounded-full ${line.tone}`} />
              <span>{line.text}</span>
            </li>
          ))}
        </ul>
        {inAppDaemon ? <p className="m-0 text-[11px] text-muted-foreground">While the daemon runs inside this app, quitting the app disconnects every paired device.</p> : null}
      </div>
    </div>
  )
}
