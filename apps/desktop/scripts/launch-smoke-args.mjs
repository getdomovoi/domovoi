export function launchSmokeElectronArgs({ platform, ci, desktopRoot }) {
  return [
    ...(platform === "linux" && ci ? ["--no-sandbox"] : []),
    "--headless",
    "--disable-gpu",
    desktopRoot,
  ]
}

// Electron cold start on a Windows CI runner is far slower than on Linux or
// macOS, so a single budget either flakes there or hides a hang elsewhere.
export function launchSmokeTimeoutMs({ platform, env }) {
  const configured = Number(env?.DOMOVOI_LAUNCH_SMOKE_TIMEOUT_MS)
  if (Number.isFinite(configured) && configured > 0) return configured
  return platform === "win32" ? 60_000 : 15_000
}
