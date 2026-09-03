import { readFileSync } from "node:fs"
import type { ComponentType } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { demoWorkspace } from "@getdomovoi/protocol"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { TooltipProvider } from "./components/ui/tooltip"
import { TerminalPane, type TerminalControls } from "./terminal-pane"
import * as Workspace from "./workspace-shell"

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8")

type Oklch = readonly [number, number, number]

function linearRgb([lightness, chroma, hue]: Oklch): readonly [number, number, number] {
  const angle = hue * Math.PI / 180
  const a = chroma * Math.cos(angle)
  const b = chroma * Math.sin(angle)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  const clamp = (value: number) => Math.max(0, Math.min(1, value))
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

function contrast(left: Oklch, right: Oklch): number {
  const luminance = (color: Oklch) => {
    const [red, green, blue] = linearRgb(color)
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
  }
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a)
  return (values[0]! + 0.05) / (values[1]! + 0.05)
}

describe("shared workspace accessibility contract", () => {
  it("names session navigation, search, and non-color session state", () => {
    const SessionsSidebar = (Workspace as unknown as {
      SessionsSidebar?: ComponentType<{
        snapshot: typeof demoWorkspace
        onCollapse: () => void
        onActivate: (sessionId: string) => void
        onNewSession: () => void
        onOpenProviderSettings: () => void
      }>
    }).SessionsSidebar

    expect(SessionsSidebar).toBeTypeOf("function")
    const Sidebar = SessionsSidebar as NonNullable<typeof SessionsSidebar>
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <Sidebar
          snapshot={demoWorkspace}
          onCollapse={vi.fn()}
          onActivate={vi.fn()}
          onNewSession={vi.fn()}
          onOpenProviderSettings={vi.fn()}
        />
      </TooltipProvider>,
    )

    expect(markup).toMatch(/<aside[^>]*aria-label="Sessions"/)
    expect(markup).toContain('aria-label="Search sessions, files, and skills"')
    expect(markup).toContain("<h2")
    expect(markup).toContain("Status: active")
    expect(markup).toContain("Status: waiting")
  })

  it("exposes machine connectivity without relying on its dot", () => {
    const connected = renderToStaticMarkup(
      <Workspace.AppBar
        snapshot={demoWorkspace}
        connected
        emergencyStopPending={false}
        emergencyStopOutcome={null}
        emergencyStopError={null}
        onOpenProject={vi.fn()}
        onPauseAll={vi.fn()}
      />,
    )
    const disconnected = renderToStaticMarkup(
      <Workspace.AppBar
        snapshot={demoWorkspace}
        connected={false}
        emergencyStopPending={false}
        emergencyStopOutcome={null}
        emergencyStopError={null}
        onOpenProject={vi.fn()}
        onPauseAll={vi.fn()}
      />,
    )

    expect(connected).toContain("Connected to ")
    expect(disconnected).toContain("Disconnected from ")
  })

  it("uses a real heading for the workspace empty state", () => {
    const snapshot = structuredClone(demoWorkspace)
    snapshot.activeSessionId = null
    snapshot.project = null
    const markup = renderToStaticMarkup(
      <Workspace.Thread
        snapshot={snapshot}
        connected
        onResolve={vi.fn(async () => {})}
        onSetRuntime={vi.fn(async () => {})}
        onForkSession={vi.fn(async () => {})}
        onListModels={vi.fn(async () => [])}
        onNewSession={vi.fn()}
        onSend={vi.fn(async () => {})}
        onCheckpoint={vi.fn(async () => {})}
        onRestoreCheckpoint={vi.fn(async () => {})}
        onPauseSession={vi.fn(async () => {})}
        onArchiveSession={vi.fn(async () => {})}
      />,
    )

    expect(markup).toContain("<h1")
    expect(markup).toContain("No project is open</h1>")
  })

  it("does not announce static information as an urgent alert", () => {
    const information = renderToStaticMarkup(
      <Alert><AlertTitle>Recorded event</AlertTitle><AlertDescription>Existing history.</AlertDescription></Alert>,
    )
    const failure = renderToStaticMarkup(
      <Alert variant="destructive"><AlertTitle>Failed</AlertTitle></Alert>,
    )

    expect(information).not.toContain('role="alert"')
    expect(failure).toContain('role="alert"')
  })

  it("keeps keyboard focus when responsive panels replace their triggers", () => {
    const restoreFocusAfterUpdate = (Workspace as unknown as {
      restoreFocusAfterUpdate?: (
        target: { current: { focus(): void } | null },
        schedule?: (callback: () => void) => void,
      ) => void
    }).restoreFocusAfterUpdate
    const focus = vi.fn()

    expect(restoreFocusAfterUpdate).toBeTypeOf("function")
    restoreFocusAfterUpdate?.({ current: { focus } }, (callback) => callback())
    expect(focus).toHaveBeenCalledOnce()
  })

  it("announces dynamic terminal status changes politely", () => {
    const controls = {
      clientId: "browser-test",
      create: vi.fn(),
      claim: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    } as unknown as TerminalControls
    const markup = renderToStaticMarkup(
      <TerminalPane
        connected={false}
        controls={controls}
        machineName="test-machine"
        sessionId="session-test"
      />,
    )

    expect(markup).toMatch(/<span[^>]*role="status"[^>]*>Terminal status: disconnected\./)
  })
})

describe("adaptive accessibility styles", () => {
  it("meets AA contrast for small metadata and warning text in both themes", () => {
    const lightBackground = styles.match(/:root[\s\S]*?--background:\s*oklch\(([^)]+)\)/)?.[1]
    const darkBackground = styles.match(/\.dark\s*\{[\s\S]*?--background:\s*oklch\(([^)]+)\)/)?.[1]
    const lightFaint = styles.match(/:root[\s\S]*?--faint:\s*oklch\(([^)]+)\)/)?.[1]
    const darkFaint = styles.match(/\.dark\s*\{[\s\S]*?--faint:\s*oklch\(([^)]+)\)/)?.[1]
    const lightWarnForeground = styles.match(/:root[\s\S]*?--warn-fg:\s*oklch\(([^)]+)\)/)?.[1]
    const lightWarnBackground = styles.match(/:root[\s\S]*?--warn-bg:\s*oklch\(([^)]+)\)/)?.[1]
    const darkWarnForeground = styles.match(/\.dark\s*\{[\s\S]*?--warn-fg:\s*oklch\(([^)]+)\)/)?.[1]
    const darkWarnBackground = styles.match(/\.dark\s*\{[\s\S]*?--warn-bg:\s*oklch\(([^)]+)\)/)?.[1]
    const parse = (value: string | undefined): Oklch => {
      expect(value).toBeTruthy()
      return value!.trim().split(/\s+/u).map(Number) as unknown as Oklch
    }

    expect(contrast(parse(lightBackground), parse(lightFaint))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(parse(darkBackground), parse(darkFaint))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(parse(lightWarnForeground), parse(lightWarnBackground))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(parse(darkWarnForeground), parse(darkWarnBackground))).toBeGreaterThanOrEqual(4.5)
  })

  it("provides intentional reduced-motion and forced-colors alternatives", () => {
    const block = (selector: string): string => {
      const start = styles.indexOf(selector)
      expect(start).toBeGreaterThanOrEqual(0)
      const open = styles.indexOf("{", start)
      let depth = 0
      for (let index = open; index < styles.length; index += 1) {
        const character = styles[index]
        if (character === "{") depth += 1
        else if (character === "}") {
          depth -= 1
          if (depth === 0) return styles.slice(open + 1, index)
        }
      }
      throw new Error(`styles.css never closes the ${selector} block`)
    }

    expect(styles).toContain("--danger-bg: oklch")
    expect(styles).toContain("--danger-fg: oklch")

    const reducedMotion = block("@media (prefers-reduced-motion: reduce)")
    for (const declaration of [
      "--tw-enter-scale: 1",
      "--tw-exit-translate-y: 0",
      "animation-duration: 80ms",
      "transition-duration: 80ms",
    ]) {
      expect(reducedMotion).toContain(declaration)
    }

    const forcedColors = block("@media (forced-colors: active)")
    for (const declaration of [
      "outline: 2px solid Highlight !important",
      "outline-color: Highlight",
      "outline-offset: 2px",
    ]) {
      expect(forcedColors).toContain(declaration)
    }
  })
})
