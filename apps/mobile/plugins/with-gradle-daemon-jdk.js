const fs = require("node:fs")
const path = require("node:path")
const { withDangerousMod } = require("expo/config-plugins")

// AGP runs prefab, while configuring CMake for native modules, with the
// Gradle daemon's own java, and fails the build on any line prefab writes to
// stderr. JDK 24 and later print a restricted-method warning there, so a
// daemon on Android Studio's bundled JDK 25 cannot configure
// react-native-worklets. Gradle's daemon JVM criteria pin the daemon to
// JDK 17, the version React Native builds against, whatever JAVA_HOME the
// wrapper was started with. Gradle looks for a matching JDK among the local
// installs, including the ones it provisioned under ~/.gradle/jdks.
module.exports = function withGradleDaemonJdk(config) {
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const file = path.join(config.modRequest.platformProjectRoot, "gradle", "gradle-daemon-jvm.properties")
      fs.writeFileSync(file, "toolchainVersion=17\n")
      return config
    },
  ])
}
