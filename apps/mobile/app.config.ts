import app from "./app.json"
import { version } from "./package.json"

// Expo evaluates this at build time, not inside the phone's JavaScript runtime.
export default { ...app.expo, version }
