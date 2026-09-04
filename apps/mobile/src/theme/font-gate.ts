// The faces ship inside the bundle, so loading them is a matter of
// milliseconds. The limit exists for the case where it is not: a font that
// never resolves must fall through to the platform face rather than hold a
// blank screen for the life of the process.
export const fontWaitLimitMs = 3000

export interface FontGateState {
  readonly loaded: boolean
  readonly failed: boolean
  readonly waitedOut: boolean
}

export function drawWithFonts(state: FontGateState): boolean {
  return state.loaded || state.failed || state.waitedOut
}
