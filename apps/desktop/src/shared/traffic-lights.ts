// macOS draws its own window buttons over a hiddenInset titlebar, at the
// position the main process asks for, and the renderer's titlebar content
// starts at the window edge. The clearance between them is derived here from
// one set of numbers rather than picked twice: the design measures its own
// mock lights at 11px with an 8px gap and starts the mark 16px after the last
// one; the real lights are 12px with an 8px gap.
export const trafficLightPosition = { x: 16, y: 14 } as const

const trafficLightDiameter = 12
const trafficLightGap = 8
const trafficLightClearance = 16

// Distance from the window's leading edge to where titlebar content may
// start. Zero where the platform draws no lights on that side.
export function titlebarLeadingInset(platform: NodeJS.Platform): number {
  if (platform !== "darwin") return 0
  return trafficLightPosition.x + trafficLightDiameter * 3 + trafficLightGap * 2 + trafficLightClearance
}
