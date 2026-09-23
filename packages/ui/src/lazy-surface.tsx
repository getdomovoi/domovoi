import { CircleStopIcon } from "lucide-react"
import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ErrorInfo,
  type LazyExoticComponent,
  type ReactNode,
  type RefObject,
} from "react"

import { Button } from "./components/ui/button"

// A surface the shell does not open on: its code loads the first time it is
// opened, and at idle once the shell has painted. Loading shows the v2 States
// loading frame, a failed load shows the failed-to-load frame with Try again,
// and focus follows the person from the control they used to the surface.

export class SurfaceLoadError extends Error {
  constructor(readonly surface: string, options?: ErrorOptions) {
    super(`${surface} did not load in this window. Nothing on the machine changed.`, options)
    this.name = "SurfaceLoadError"
  }
}

export type LazySurface<P extends object> = {
  Surface: (props: P) => ReactNode
  prefetch: () => void
}

export function lazySurface<P extends object>(name: string, load: () => Promise<ComponentType<P>>): LazySurface<P> {
  // React.lazy keeps a rejected load for good, so each Try again is a new one.
  let attempt = 0
  const attempts = new Map<number, LazyExoticComponent<ComponentType<P>>>()
  const current = () => {
    let loaded = attempts.get(attempt)
    if (!loaded) {
      loaded = lazy(() => load().then(
        (component) => ({ default: component }),
        (cause: unknown) => { throw new SurfaceLoadError(name, { cause }) },
      ))
      attempts.set(attempt, loaded)
    }
    return loaded
  }

  function Surface(props: P) {
    const [, setRetries] = useState(0)
    const region = useRef<HTMLDivElement>(null)
    const Loaded = current()
    return (
      <SurfaceLoadBoundary
        key={attempt}
        onRetry={() => {
          attempt += 1
          setRetries((retries) => retries + 1)
        }}
      >
        <div ref={region} className="contents">
          <Suspense fallback={<SurfaceLoading name={name} />}>
            <Loaded {...props} />
            <FocusSurfaceHeading region={region} />
          </Suspense>
        </div>
      </SurfaceLoadBoundary>
    )
  }

  return {
    Surface,
    prefetch: () => { void load().catch(() => undefined) },
  }
}

// After first paint, when the browser has nothing else to do. A failed
// prefetch changes nothing: opening the surface loads it again.
export function prefetchWhenIdle(
  surfaces: readonly { prefetch: () => void }[],
  schedule: (run: () => void) => () => void = scheduleIdle,
): () => void {
  return schedule(() => {
    for (const surface of surfaces) surface.prefetch()
  })
}

function scheduleIdle(run: () => void): () => void {
  if (typeof globalThis.requestIdleCallback === "function") {
    const handle = globalThis.requestIdleCallback(() => run())
    return () => globalThis.cancelIdleCallback(handle)
  }
  const handle = globalThis.setTimeout(run, 1)
  return () => globalThis.clearTimeout(handle)
}

function FocusSurfaceHeading({ region }: { region: RefObject<HTMLDivElement | null> }) {
  useEffect(() => {
    const heading = region.current?.querySelector<HTMLElement>("h1")
    if (!heading) return
    if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1
    heading.focus()
  }, [region])
  return null
}

function SurfaceLoading({ name }: { name: string }) {
  const line = useRef<HTMLParagraphElement>(null)
  useEffect(() => { line.current?.focus() }, [])
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 bg-background p-6">
      <p ref={line} role="status" tabIndex={-1} className="font-machine text-mono-xs text-faint outline-none">Opening {name}</p>
      {[0, 1, 2].map((block) => (
        <div key={block} aria-hidden className="flex flex-col gap-2">
          <span className="skeleton-bar block h-2.5 w-1/3 rounded-sm" />
          <span className="skeleton-bar block h-2 w-full rounded-sm" />
          <span className="skeleton-bar block h-2 w-2/3 rounded-sm" />
        </div>
      ))}
    </main>
  )
}

type BoundaryState = { error: Error | undefined }

class SurfaceLoadBoundary extends Component<{ children: ReactNode, onRetry: () => void }, BoundaryState> {
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
    // A surface that loaded and then failed to draw is not a load failure; the
    // workspace boundary above says what that is.
    if (!(error instanceof SurfaceLoadError)) throw error
    return (
      <main className="flex min-h-0 flex-1 items-start justify-center bg-background p-6">
        <section aria-label={`${error.surface} did not load`} className="flex w-full max-w-[620px] flex-col gap-4">
          <div className="overflow-hidden rounded-xl border border-danger-border bg-danger-background">
            <div className="flex items-center gap-3 px-4 py-3 text-danger-foreground">
              <CircleStopIcon aria-hidden className="size-4 shrink-0" />
              <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">{error.message}</h2>
            </div>
          </div>
          <div>
            <Button onClick={this.props.onRetry}>Try again</Button>
          </div>
        </section>
      </main>
    )
  }
}
