import app from "./app.json"
import { version } from "./package.json"
import { colors } from "./src/theme/tokens.generated.js"

// Expo evaluates this at build time, not inside the phone's JavaScript runtime.
// CFBundleShortVersionString accepts only major.minor.patch. Greetings retain
// the full buildVersion, including prerelease and build metadata.
const nativeVersion = version.split(/[-+]/, 1)[0]
if (!nativeVersion || !/^\d+\.\d+\.\d+$/.test(nativeVersion)) {
  throw new Error("Mobile package version must start with major.minor.patch")
}

// The splash ground and the Android icon ground are tokens rather than brand constants, so they
// are read from the generated palette here instead of being written into app.json where they
// would drift from styles.css. The splash is the full mark at 76pt on the app background, per
// theme, with no wordmark: both themes ship because Expo picks by appearance and does not
// recolour one asset.
const splashScreen = [
  "expo-splash-screen",
  {
    image: "./assets/splash-light.png",
    imageWidth: 76,
    resizeMode: "contain",
    backgroundColor: colors.light.background,
    dark: {
      image: "./assets/splash-dark.png",
      backgroundColor: colors.dark.background,
    },
  },
]

export default {
  ...app.expo,
  version: nativeVersion,
  android: {
    ...app.expo.android,
    adaptiveIcon: { ...app.expo.android.adaptiveIcon, backgroundColor: colors.dark.card },
  },
  plugins: [splashScreen, ...app.expo.plugins],
}
