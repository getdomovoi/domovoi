import app from "./app.json"
import { version } from "./package.json"

// Expo evaluates this at build time, not inside the phone's JavaScript runtime.
// CFBundleShortVersionString accepts only major.minor.patch. Greetings retain
// the full buildVersion, including prerelease and build metadata.
const nativeVersion = version.split(/[-+]/, 1)[0]
if (!nativeVersion || !/^\d+\.\d+\.\d+$/.test(nativeVersion)) {
  throw new Error("Mobile package version must start with major.minor.patch")
}
export default { ...app.expo, version: nativeVersion }
