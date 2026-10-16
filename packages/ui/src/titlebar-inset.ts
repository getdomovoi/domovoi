import { createContext, useContext, type CSSProperties } from "react"

import type { DesktopWindowBridge, WorkspaceWindowDecoration } from "./desktop-platform"

// Pixels a titlebar row leaves at its leading edge for the OS-drawn window
// buttons (the macOS traffic lights). Only a desktop window that draws its
// own decoration has them over its content: the system frame draws its own
// titlebar above the page, and the web has no window buttons at all.
export function titlebarLeadingInset(
  bridge: DesktopWindowBridge | undefined,
  decoration: WorkspaceWindowDecoration,
): number {
  return bridge && decoration === "domovoi" ? bridge.titlebarLeadingInset ?? 0 : 0
}

// A full-window surface drawn over the shell (setup, preview fullscreen) puts
// its header row where the shell's titlebar was, under the same window
// buttons. The shell provides its inset here; outside a desktop shell, the
// web included, it is 0.
export const TitlebarLeadingInset = createContext(0)

export function useTitlebarLeadingInset(): number {
  return useContext(TitlebarLeadingInset)
}

// The inset replaces a row's own leading padding, as the titlebar does.
export function titlebarInsetStyle(inset: number): CSSProperties | undefined {
  return inset > 0 ? { paddingLeft: inset } : undefined
}
