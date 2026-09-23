export type ComposerPlatform = "darwin" | "other"

export function composerPlatform(): ComposerPlatform {
  if (typeof navigator === "undefined") return "other"
  return /Mac|iPhone|iPad/u.test(navigator.platform) ? "darwin" : "other"
}

export function sendHint(platform: ComposerPlatform): string {
  return platform === "darwin"
    ? "↵ to send · ⇧↵ for a new line"
    : "Enter to send · Shift+Enter for a new line"
}

export function composerPlaceholder(state: { offline: boolean; working: boolean }): string {
  if (state.offline) return "Cannot send, the daemon is not answering"
  return state.working ? "Steer it while it works" : "Reply, or steer the plan"
}
