import { join } from "node:path"

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
  if (Number.isSafeInteger(configured) && configured > 0 && configured <= 2_147_483_647) return configured
  // The smoke includes production startup, authenticated RPC and shutdown,
  // not only renderer readiness. The parent bounds the entire child lifetime.
  return platform === "win32" ? 90_000 : 60_000
}

export function launchSmokeEnvironment({ env, profileRoot, timeoutMs }) {
  const inherited = Object.fromEntries(Object.entries(env).filter(([key]) =>
    !key.toUpperCase().startsWith("DOMOVOI_")
    && !["ELECTRON_RENDERER_URL", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"].includes(key.toUpperCase()),
  ))
  return {
    ...inherited,
    HOME: profileRoot, USERPROFILE: profileRoot,
    APPDATA: join(profileRoot, "config"), LOCALAPPDATA: join(profileRoot, "data"),
    XDG_CACHE_HOME: join(profileRoot, "cache"), XDG_CONFIG_HOME: join(profileRoot, "config"),
    XDG_DATA_HOME: join(profileRoot, "data"),
    DOMOVOI_DESKTOP_LAUNCH_SMOKE: "1", DOMOVOI_LAUNCH_SMOKE_PROFILE: profileRoot,
    DOMOVOI_LAUNCH_SMOKE_TIMEOUT_MS: String(timeoutMs),
    DOMOVOI_HOST: "127.0.0.1", DOMOVOI_PORT: "0",
  }
}
