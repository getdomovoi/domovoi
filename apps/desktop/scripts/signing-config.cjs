const { join } = require("node:path")
const { verifyMacApplication, verifyWindowsFiles } = require("./signing-verify.cjs")

const appleKeys = ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]
const certificateKeys = ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"]
const azureKeys = [
  "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET",
  "AZURE_SIGNING_ENDPOINT", "AZURE_SIGNING_ACCOUNT", "AZURE_SIGNING_PROFILE",
]
const unsupportedAppleKeys = ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_KEYCHAIN", "APPLE_KEYCHAIN_PROFILE"]
const publisherKey = "DOMOVOI_WIN_PUBLISHER_NAME"
const requiredKey = "DOMOVOI_DESKTOP_REQUIRE_SIGNING"
const present = (env, key) => typeof env[key] === "string" && env[key].trim().length > 0
const any = (env, keys) => keys.some((key) => present(env, key))

function requireKeys(env, keys, description) {
  const missing = keys.filter((key) => !present(env, key))
  if (missing.length) throw new Error(`${description}: set ${missing.join(", ")}. Partial signing configuration cannot produce a release.`)
}

function signingConfiguration(environment, hostPlatform, verification = { verifyMacApplication, verifyWindowsFiles }) {
  const env = { ...environment }
  if (present(env, requiredKey) && env[requiredKey] !== "true") {
    throw new Error(`${requiredKey} must be true or unset`)
  }
  if (any(env, unsupportedAppleKeys)) {
    throw new Error("This packaging path uses APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID. Remove the other Apple notarization method before building.")
  }
  const macSigned = any(env, [...appleKeys, "CSC_NAME"])
  const azure = any(env, azureKeys)
  const certificate = any(env, certificateKeys)
  const winSigned = azure || certificate || present(env, publisherKey)
  if (macSigned) {
    requireKeys(env, appleKeys, "macOS signing and notarization")
    if (!/^[A-Z0-9]{10}$/u.test(env.APPLE_TEAM_ID)) throw new Error("APPLE_TEAM_ID must be the ten-character Apple Developer team identifier")
    if (env.CSC_NAME === "-" || env.CSC_IDENTITY_AUTO_DISCOVERY === "false") {
      throw new Error("Configured macOS signing cannot use an ad-hoc identity or disable identity discovery")
    }
  }
  if (azure && certificate) throw new Error("Choose Azure signing or WIN_CSC_LINK, not both")
  if (winSigned) {
    requireKeys(env, azure ? [...azureKeys, publisherKey] : [...certificateKeys, publisherKey], "Windows signing")
  }
  if (azure && !/^https:\/\/[a-z0-9-]+\.codesigning\.azure\.net\/?$/u.test(env.AZURE_SIGNING_ENDPOINT)) {
    throw new Error("AZURE_SIGNING_ENDPOINT must be the HTTPS regional codesigning.azure.net endpoint, without credentials, query or fragment")
  }
  if (macSigned || winSigned) {
    if (env.GITHUB_EVENT_NAME?.startsWith("pull_request") || present(env, "CSC_FOR_PULL_REQUEST")) {
      throw new Error("Signing is refused for pull requests. Use the protected main-branch signing build.")
    }
  }
  const signed = hostPlatform === "darwin" ? macSigned : hostPlatform === "win32" && winSigned
  if (env[requiredKey] === "true" && !signed) {
    throw new Error(`${requiredKey}=true requires complete signing credentials on a native macOS or Windows host. See docs/desktop-signing.md.`)
  }
  const verifiedApplications = new Set()
  return {
    mac: macSigned ? {
      forceCodeSigning: true,
      type: "distribution",
      ...(present(env, "CSC_NAME") ? { identity: env.CSC_NAME } : {}),
      hardenedRuntime: true,
      notarize: true,
    } : {
      // Explicit ad-hoc signing makes Apple Silicon development builds runnable.
      // It asserts no publisher identity and is never a signed release.
      identity: "-", forceCodeSigning: false, hardenedRuntime: false, notarize: false,
    },
    win: {
      forceCodeSigning: winSigned,
      signExecutable: winSigned,
      ...(azure ? {
        signtoolOptions: null,
        azureSignOptions: {
          publisherName: env[publisherKey],
          endpoint: env.AZURE_SIGNING_ENDPOINT,
          codeSigningAccountName: env.AZURE_SIGNING_ACCOUNT,
          certificateProfileName: env.AZURE_SIGNING_PROFILE,
          fileDigest: "SHA256",
          timestampDigest: "SHA256",
          timestampRfc3161: "http://timestamp.acs.microsoft.com",
        },
      } : certificate ? {
        signtoolOptions: {
          publisherName: env[publisherKey],
          signingHashAlgorithms: ["sha256"],
          rfc3161TimeStampServer: "http://timestamp.digicert.com",
        },
      } : {}),
    },
    beforePack(context) {
      if (context.electronPlatformName !== hostPlatform) {
        throw new Error("Package Domovoi on the target platform so its native dependencies and signing tools are real, not cross-host substitutes")
      }
    },
    async afterSign(context) {
      if (!signed) return
      const name = context.packager.appInfo.productFilename
      const path = join(context.appOutDir, hostPlatform === "darwin" ? `${name}.app` : `${name}.exe`)
      if (hostPlatform === "darwin") await verification.verifyMacApplication(path, env.APPLE_TEAM_ID)
      else await verification.verifyWindowsFiles([path], env[publisherKey])
      verifiedApplications.add(path)
    },
    async afterAllArtifactBuild(context) {
      if (!signed) return []
      // electron-builder can skip afterSign when it did not sign. A hook that
      // never ran is not evidence. Refuse before any artifact upload can start.
      if (verifiedApplications.size === 0) throw new Error("Signing was configured but no application passed signature verification")
      if (hostPlatform === "win32") {
        const installers = context.artifactPaths.filter((path) => path.endsWith(".exe"))
        if (installers.length === 0) throw new Error("Signed Windows build produced no NSIS installer to verify")
        await verification.verifyWindowsFiles(installers, env[publisherKey])
      } else if (![".dmg", ".zip"].every((extension) => context.artifactPaths.some((path) => path.endsWith(extension)))) {
        throw new Error("Signed macOS build must produce both DMG and ZIP artifacts from the verified, stapled application")
      }
      return []
    },
  }
}

module.exports = { signingConfiguration }
