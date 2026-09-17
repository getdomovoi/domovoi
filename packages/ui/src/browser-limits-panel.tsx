import { Button } from "./components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./components/ui/card"
import { DomovoiMark } from "./domovoi-mark"
import { cn } from "./lib/utils"
import { StatusDot, type StatusMeaning } from "./status-dot"

export type BrowserLimitTone = "same" | "conditional" | "refused" | "never"

export type BrowserLimit = {
  what: string
  state: string
  tone: BrowserLimitTone
  why: string
}

// The tone is a state a person acts on: same needs nothing, conditional has a
// step, refused was stopped by this browser, never is not this surface's job.
const meaningFor: Record<BrowserLimitTone, StatusMeaning> = {
  same: "online",
  conditional: "waiting",
  refused: "offline",
  never: "idle",
}

const stateTone: Record<BrowserLimitTone, string> = {
  same: "text-success",
  conditional: "text-warning",
  refused: "text-destructive",
  never: "text-muted-foreground",
}

// The web design's third step. Everything a browser tab cannot do is stated
// here, once, before the person hits it inside the session. The rows are
// measured by the caller against this browser; this panel only says them.
export function BrowserLimitsPanel({ rows, onContinue }: {
  rows: BrowserLimit[]
  onContinue: () => void
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <div className="mb-2 flex size-9 items-center justify-center rounded-md bg-accent text-primary">
            <DomovoiMark reduced className="size-5" />
          </div>
          <CardTitle asChild><h1>What a browser tab can and cannot do</h1></CardTitle>
          <CardDescription>
            Each difference follows from one fact: no daemon, no repository, no keychain.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul aria-label="Browser limits" className="m-0 list-none divide-y divide-border rounded-xl border border-border p-0">
            {rows.map((row) => (
              <li key={row.what} data-tone={row.tone} className="flex items-start gap-3 px-3.5 py-2.5">
                <StatusDot meaning={meaningFor[row.tone]} label={row.state} labelHidden size="inline" className="mt-1.5" />
                <span className="w-40 shrink-0 text-[12.5px] font-medium text-strong">{row.what}</span>
                <span className={cn("w-32 shrink-0 font-mono text-[10.5px] leading-5", stateTone[row.tone])}>{row.state}</span>
                <span className="min-w-0 flex-1 text-[11.5px] leading-5 text-muted-foreground">{row.why}</span>
              </li>
            ))}
          </ul>
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="button" onClick={onContinue}>Continue to the session</Button>
        </CardFooter>
      </Card>
    </main>
  )
}
