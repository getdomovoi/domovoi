// Ask the installed Expo SDK whether every Expo-managed package is at the
// version it bundles. Offline on purpose: online, the CLI compares against
// the newest SDK patch on the network, so a release by Expo would turn this
// red with no commit here. Offline it reads the installed expo package's own
// table, which is the contract this repository can hold.
import { spawnSync } from "node:child_process"

const result = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["expo", "install", "--check"], {
  stdio: "inherit",
  env: { ...process.env, EXPO_OFFLINE: "1" },
  shell: process.platform === "win32",
})
process.exit(result.status ?? 1)
