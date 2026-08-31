export function launchSmokeElectronArgs({ platform, ci, desktopRoot }) {
  return [
    ...(platform === "linux" && ci ? ["--no-sandbox"] : []),
    "--headless",
    "--disable-gpu",
    desktopRoot,
  ]
}
