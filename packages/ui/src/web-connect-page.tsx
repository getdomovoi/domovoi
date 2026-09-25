import { pairingCodeSchema } from "@getdomovoi/protocol"
import { QrCodeIcon } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "./components/ui/button"
import { Input } from "./components/ui/input"
import { DomovoiMark } from "./domovoi-mark"

// The first screen of a browser tab, from Domovoi Web v2 (2026-09-23, J26).
// A tab holds no daemon, so it pairs with one by typing the code the machine
// shows in Settings under Phone and tablet. The code is the daemon's own word
// code (ND1); the credential the daemon hands back lives in this tab only.
// What the daemon answers is drawn as an outcome card; what it does not say,
// the page does not invent: every bad code gets the same refusal on purpose.

export type PairingOutcome = {
  tone: "ok" | "danger" | "plain"
  pill: string
  title: string
  mono: string
  body: string
  action?: { label: string; run: () => void } | undefined
}

const tones: Record<PairingOutcome["tone"], { card: string; dot: string; pill: string }> = {
  ok: { card: "border-ok-border bg-ok-background text-ok-foreground", dot: "bg-success", pill: "bg-success/15 text-ok-dim" },
  danger: { card: "border-danger-border bg-danger-background text-danger-foreground", dot: "bg-destructive", pill: "bg-destructive/15 text-danger-dim" },
  plain: { card: "border-border bg-card text-foreground", dot: "bg-faint", pill: "bg-muted text-muted-foreground" },
}

export function isWebCode(value: string): boolean {
  return pairingCodeSchema.safeParse(value.trim()).success
}

export function WebConnectPage({
  host,
  secure,
  reopened = false,
  initialCode = "",
  fromUrl = false,
  reached = false,
  pending,
  outcome,
  onPair,
  onOpenLimits,
  onUseCredential,
}: {
  // The address the page dials, which is all a tab knows before it pairs.
  host: string
  secure: boolean
  reopened?: boolean
  initialCode?: string
  fromUrl?: boolean
  // The daemon answered over this address, so the browser checked its
  // certificate. Until then the page has nothing to say about it.
  reached?: boolean
  pending: boolean
  outcome?: PairingOutcome | undefined
  onPair: (code: string) => void
  onOpenLimits: () => void
  onUseCredential?: (() => void) | undefined
}) {
  const [code, setCode] = useState(initialCode)
  // A code from the address bar is locked until the daemon has answered it;
  // after that the field is the person's again.
  const [filledFromUrl, setFilledFromUrl] = useState(fromUrl)
  useEffect(() => { if (outcome) setFilledFromUrl(false) }, [outcome])
  const ready = isWebCode(code)
  const facts = [
    { text: `This tab talks only to the daemon at ${host}.`, tone: "bg-info" },
    ...(secure && reached ? [{ text: "The certificate is the one the browser checked for this name.", tone: "bg-success" }] : []),
    { text: "The credential lives in this tab only. Close the tab and you pair again.", tone: "bg-info" },
    { text: "Previews open in a sandboxed frame that cannot reach this page.", tone: "bg-success" },
    { text: "This page and the daemon must speak the same protocol version. After a daemon update, reload.", tone: "bg-info" },
  ]
  const tone = outcome ? tones[outcome.tone] : undefined

  return (
    <main className="flex min-h-dvh items-start justify-center bg-background p-6 text-foreground">
      <div className="flex w-full max-w-[520px] flex-col gap-5 pt-8">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <DomovoiMark reduced className="size-5 text-primary" />
            <h1 className="m-0 text-[20px] font-semibold tracking-[-0.015em]">{reopened ? "Pair this browser again with" : "Connect this browser to"}</h1>
          </div>
          <span className="font-machine text-[13px] text-strong">{host}</span>
          <p className="m-0 text-[13px] leading-[1.6] text-muted-foreground">
            {filledFromUrl ? "Opened from the QR on the machine. Check the machine name above, then pair." : "Type the web code shown on the machine, in Settings under Phone and tablet."}
          </p>
        </div>

        {reopened ? (
          <div className="flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 text-[12px]">
            <div className="flex flex-wrap items-center gap-2">
              <span aria-hidden className="size-1.5 rounded-full bg-info" />
              <span>This tab has no credential</span>
              <span className="font-machine text-[10.5px] text-faint">sessionStorage · cleared when the last tab closed</span>
            </div>
            <p className="m-0 text-muted-foreground">Domovoi keeps a browser credential for one tab session, so a reopened tab pairs again. Nothing on the machine stopped.</p>
          </div>
        ) : null}

        <form
          className="flex flex-col gap-3 rounded-lg border bg-card p-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (ready && !pending) onPair(code.trim())
          }}
        >
          <div className="flex items-baseline gap-2">
            <label htmlFor="web-code" className="text-[12.5px] font-medium">Web code</label>
            <span className="font-machine text-[10.5px] text-faint">Works once, for 180 seconds</span>
          </div>
          <Input
            id="web-code"
            aria-label="Web code"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            readOnly={filledFromUrl || Boolean(outcome)}
            disabled={pending}
            className="h-11 font-machine text-[15px] tracking-wide"
            placeholder="word-word-word-00"
            value={code}
            onChange={(event) => setCode(event.target.value.toLowerCase())}
          />
          {filledFromUrl ? (
            <p className="m-0 flex items-center gap-2 text-[11.5px] text-muted-foreground">
              <QrCodeIcon className="size-4" />
              Filled from the QR on the machine. Removed from the address bar when this page loaded.
            </p>
          ) : null}
          {!outcome ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={!ready || pending}>{pending ? "Pairing this browser" : "Pair this browser"}</Button>
              <span className="text-[11.5px] text-muted-foreground">{ready ? "Pairs this tab only" : "Locked until the code is complete"}</span>
              <span className="flex-1" />
              <button type="button" className="text-[11.5px] text-muted-foreground underline-offset-2 hover:underline" onClick={onOpenLimits}>What a browser tab can and cannot do</button>
            </div>
          ) : null}
        </form>

        {outcome && tone ? (
          <div className={`flex flex-col gap-2 rounded-lg border px-4 py-3 ${tone.card}`} role="status">
            <div className="flex flex-wrap items-center gap-2">
              <span aria-hidden className={`size-[7px] rounded-full ${tone.dot}`} />
              <span className="text-[13px] font-medium">{outcome.title}</span>
              <span className="flex-1" />
              <span className={`rounded-full px-2 py-0.5 font-machine text-[10.5px] ${tone.pill}`}>{outcome.pill}</span>
            </div>
            <span className="font-machine text-[10.5px] opacity-80">{outcome.mono}</span>
            <p className="m-0 text-[12px] leading-[1.55]">{outcome.body}</p>
            <div className="flex flex-wrap items-center gap-3">
              {outcome.action ? <Button type="button" size="sm" variant={outcome.tone === "ok" ? "default" : "outline"} onClick={outcome.action.run}>{outcome.action.label}</Button> : null}
              <span className="flex-1" />
              <button type="button" className="text-[11.5px] underline-offset-2 hover:underline" onClick={onOpenLimits}>What a browser tab can and cannot do</button>
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <span id="tab-trust" className="text-[10.5px] tracking-[0.13em] text-faint">HOW THIS TAB IS TRUSTED</span>
          <ul aria-labelledby="tab-trust" className="m-0 flex list-none flex-col gap-1 p-0 text-[11.5px] text-muted-foreground">
            {facts.map((fact) => (
              <li key={fact.text} className="flex items-start gap-2">
                <span aria-hidden className={`mt-[6px] size-1.5 shrink-0 rounded-full ${fact.tone}`} />
                <span>{fact.text}</span>
              </li>
            ))}
          </ul>
        </div>

        {onUseCredential ? (
          <button type="button" className="self-start text-[11.5px] text-faint underline-offset-2 hover:underline" onClick={onUseCredential}>
            Paste the daemon credential instead
          </button>
        ) : null}
      </div>
    </main>
  )
}
