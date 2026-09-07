import { dirname, join } from "node:path"

// A packaged build already knows where its application is. Passing a directory
// as well makes Electron read it as a file argument, not as the app to run.
export function launchSmokeElectronArgs({ platform, ci, desktopRoot, packaged = false, debuggingLogFile, userDataDirectory }) {
  return [
    ...(platform === "linux" && ci ? ["--no-sandbox"] : []),
    "--headless",
    "--disable-gpu",
    ...(userDataDirectory ? [`--user-data-dir=${userDataDirectory}`] : []),
    ...(debuggingLogFile ? ["--remote-debugging-port=0", "--enable-logging=file", `--log-file=${debuggingLogFile}`] : []),
    ...(packaged ? [] : [desktopRoot]),
  ]
}

// Xvfb provides the X server, not an alternative proof. Without it a local
// display is usable; a headless host must name the missing prerequisite.
export function launchSmokeCommand({ platform, env, electronPath, electronArgs, xvfb }) {
  if (platform === "linux") {
    if (xvfb) return { command: xvfb, args: ["--auto-servernum", electronPath, ...electronArgs] }
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
      throw new Error("Electron smoke requires a Linux display. Install xvfb-run or provide a working DISPLAY or WAYLAND_DISPLAY.")
    }
  }
  return { command: electronPath, args: electronArgs }
}

// electron-builder names the unpacked directory after the platform and, for
// anything but the host architecture, the architecture too. Both orders are
// offered rather than guessed at, and the caller takes the one that exists.
export function packagedAppCandidates({ platform, distDirectory, productName, executableName }) {
  if (platform === "darwin") {
    return ["mac", "mac-arm64", "mac-universal"].map((directory) =>
      join(distDirectory, directory, `${productName}.app`, "Contents", "MacOS", productName))
  }
  if (platform === "win32") {
    return ["win-unpacked", "win-arm64-unpacked"].map((directory) =>
      join(distDirectory, directory, `${productName}.exe`))
  }
  return ["linux-unpacked", "linux-arm64-unpacked"].map((directory) =>
    join(distDirectory, directory, executableName))
}

export function packagedAsarPath({ platform, executablePath }) {
  // Contents/MacOS/Domovoi and Contents/Resources/app.asar are siblings one
  // level up. Every other platform keeps resources beside the executable.
  return platform === "darwin"
    ? join(dirname(dirname(executablePath)), "Resources", "app.asar")
    : join(dirname(executablePath), "resources", "app.asar")
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
  // Windows treats environment names case-insensitively. Remove aliases of
  // every isolated path before adding the canonical keys below.
  const replaced = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
    "ELECTRON_RENDERER_URL", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"]
  const inherited = Object.fromEntries(Object.entries(env).filter(([key]) =>
    !key.toUpperCase().startsWith("DOMOVOI_")
    && !replaced.includes(key.toUpperCase()),
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
