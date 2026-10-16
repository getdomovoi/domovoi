import { CircleStopIcon } from "lucide-react"
import { Component, useContext, useState, type ErrorInfo, type ReactNode } from "react"

import { Button } from "./components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "./components/ui/dialog"
import type { DesktopFirstRunDialogProps } from "./desktop-first-run"
import { browserDesktopFirstRunStorage, rememberDesktopFirstRunDismissed } from "./desktop-first-run-persistence"
import { DialogLoading, lazyDialog, SurfaceCodeReload, SurfaceLoadError, useDrawnOnceOpen, type LazyDialog } from "./lazy-surface"
import { titlebarInsetStyle, useTitlebarLeadingInset } from "./titlebar-inset"

// First-run setup opens only in the desktop app, on its first launch or from
// Settings, so its code is not part of what a launch loads: the web never
// asks for it, and the desktop loads it when setup opens. It is not fetched
// at idle either, since most launches never open it. Until the code lands a
// full-window frame with the setup's name stands in for it (DialogLoading),
// and closing that frame skips setup exactly as Skip for now does, so a skip
// made while it loads is remembered and holds when the code arrives.
//
// Setup opens over the shell at launch, so a load that fails is caught here
// rather than by the workspace's boundary: an open setup says it did not load
// and offers Try again and Skip for now, and a closed one draws nothing.

const surface = "Setup"
const frameClassName = "flex h-dvh max-h-none max-w-none flex-col gap-4 rounded-none bg-background p-6 sm:max-w-none"
// The loading frame's title sits in a row the size of setup's own header,
// which covers the shell's titlebar: it starts past the macOS window buttons
// and drags the window, as that header does.
const loadingFrameClassName = "flex h-dvh max-h-none max-w-none flex-col gap-0 rounded-none bg-background p-0 sm:max-w-none"
const loadingHeaderClassName = "electron-drag h-[46px] shrink-0 justify-center border-b px-3.5"

// React.lazy keeps a rejected load for good, so each Try again is a new one.
let attempt = 0
const attempts = new Map<number, LazyDialog<DesktopFirstRunDialogProps>>()
function currentAttempt(): LazyDialog<DesktopFirstRunDialogProps> {
  let dialog = attempts.get(attempt)
  if (!dialog) {
    dialog = lazyDialog(async () => {
      try {
        return (await import("./desktop-first-run")).DesktopFirstRunDialog
      } catch (cause: unknown) {
        throw new SurfaceLoadError(surface, { cause })
      }
    })
    attempts.set(attempt, dialog)
  }
  return dialog
}

export function DesktopFirstRunDialog(props: DesktopFirstRunDialogProps) {
  const drawn = useDrawnOnceOpen(props.open)
  const [, setRetries] = useState(0)
  // What had focus when setup opened, read as the open is drawn and before
  // any frame takes focus. The loading frame and the loaded dialog each give
  // focus back on their own; the frame that says setup did not load replaced
  // them, so it gives focus back to this.
  const [opened, setOpened] = useState<{ open: boolean; from: HTMLElement | null }>({ open: false, from: null })
  if (props.open !== opened.open) setOpened({ open: props.open, from: props.open ? focusedElement() : opened.from })
  // The web reloads the page after a failed chunk; the desktop loads again.
  const reload = useContext(SurfaceCodeReload)
  const titlebarInset = useTitlebarLeadingInset()
  if (!drawn) return null
  const skip = () => {
    rememberDesktopFirstRunDismissed(browserDesktopFirstRunStorage())
    props.onSkip()
  }
  const retry = () => {
    if (reload) return reload()
    attempt += 1
    setRetries((retries) => retries + 1)
  }
  const Loaded = currentAttempt().Dialog
  return (
    <SetupLoadBoundary key={attempt} open={props.open} restoreFocusTo={opened.from} onSkip={skip} onRetry={retry}>
      <Loaded
        {...props}
        loading={(
          <DialogLoading
            open={props.open}
            onOpenChange={(next) => { if (!next) skip() }}
            title="Domovoi setup"
            showCloseButton={false}
            className={loadingFrameClassName}
            headerClassName={loadingHeaderClassName}
            headerStyle={titlebarInsetStyle(titlebarInset)}
            bodyClassName="p-6"
          />
        )}
      />
    </SetupLoadBoundary>
  )
}

function focusedElement(): HTMLElement | null {
  return typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null
}

type BoundaryProps = {
  open: boolean
  restoreFocusTo: HTMLElement | null
  onSkip: () => void
  onRetry: () => void
  children: ReactNode
}
type BoundaryState = { error: Error | undefined }

class SetupLoadBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: undefined }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    if (error instanceof SurfaceLoadError) console.error(error.message, error.cause, info.componentStack)
  }

  override render() {
    const { error } = this.state
    if (!error) return this.props.children
    // Setup that loaded and then failed to draw is not a load failure; the
    // workspace boundary above says what that is.
    if (!(error instanceof SurfaceLoadError)) throw error
    const { open, restoreFocusTo, onSkip, onRetry } = this.props
    return (
      <Dialog open={open} onOpenChange={(next) => { if (!next) onSkip() }}>
        <DialogContent
          showCloseButton={false}
          aria-describedby={undefined}
          className={frameClassName}
          onCloseAutoFocus={(event) => {
            if (!restoreFocusTo?.isConnected) return
            event.preventDefault()
            restoreFocusTo.focus()
          }}
        >
          <section className="flex w-full max-w-[620px] flex-col gap-4 self-center pt-10">
            <div className="overflow-hidden rounded-xl border border-danger-border bg-danger-background">
              <div className="flex items-center gap-3 px-4 py-3 text-danger-foreground">
                <CircleStopIcon aria-hidden className="size-4 shrink-0" />
                <DialogTitle asChild><h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">{error.message}</h2></DialogTitle>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {/* Only the person's click loads again, never the failure itself,
                  so a build that keeps failing cannot reload in a loop. */}
              <Button onClick={onRetry}>Try again</Button>
              <Button variant="ghost" onClick={onSkip}>Skip for now</Button>
            </div>
          </section>
        </DialogContent>
      </Dialog>
    )
  }
}
