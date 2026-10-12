# Desktop signing and notarization

This is the credential and proof contract for the existing electron-builder **26.15.3**
packaging path. Do not copy v27 signing keys into this configuration. Nothing here publishes
an npm package, creates a release, or enables publication. The first alpha is `0.1.0-alpha.0`.

## Behavior

Every `pnpm package:desktop` command and its `:mac`, `:win` and `:linux` variants loads
`apps/desktop/electron-builder.cjs`, extending the existing YAML layout. Package on the target
OS, with its own platform dependencies. Cross-host packaging is refused before packing.

- No signing credentials: a development build. macOS uses explicit ad-hoc signing, not a
  trusted publisher identity, and disables notarization and hardened runtime. Windows is
  unsigned. Linux packaging is unchanged.
- Any part of the selected signing credentials: require the complete set before packing.
  A missing field is an error naming the field, never a reason to silently skip signing.
- Complete credentials: mandatory signing. macOS requires distribution signing, hardened
  runtime and notarization together. The existing entitlements apply to the app and helpers.
  Windows selects either Azure or PFX signing, refuses both together, and uses SHA-256 with
  a timestamp. A bad password, unavailable signer or rejected notarization fails the build.
- `DOMOVOI_DESKTOP_REQUIRE_SIGNING=true`: also refuse completely absent credentials. The
  protected build always sets this. Unset it for unsigned development, rather than setting
  `false`. A certificate-free local build is not a release candidate.
- No configured signing on PRs, including `pull_request_target`. Never use
  `CSC_FOR_PULL_REQUEST` to give untrusted code signing authority.

After signing, macOS verifies nested signatures with `codesign`, checks Developer ID Application
and the expected team, and validates the stapled application ticket with `xcrun stapler`.
Windows checks `Get-AuthenticodeSignature` for `Valid`, the expected publisher and a timestamp
on the app executable and every NSIS installer. Skipping the signing hook fails the final
artifact check. Failed builds do not upload artifacts. Verification commands share a two-minute
budget per verification phase, including late-result checks.

The notarization ticket is stapled to the **application**, which is then put in the DMG and ZIP.
This does not claim a separate notarization ticket stapled to the DMG container. No Linux
publisher signature or Windows SmartScreen reputation is created by this configuration.

## Opening an unsigned build

Without credentials the macOS app is ad-hoc signed, with no publisher identity, no hardened
runtime and no notarization (`apps/desktop/scripts/signing-config.cjs`), and the Windows NSIS
installer and the app it installs are unsigned. That is every M1 build. Both operating systems
can warn before the first launch.

This section was written on 2026-10-11 from Apple's and Microsoft's own pages, linked below, not
from a run on either OS. Each "Record" line is something the maintainer must still capture on
real hardware, in the [M1 acceptance walk](m1-acceptance-walk.md#1-packaged-desktop-and-its-service).
Until those runs exist, the exact dialogs, and whether one appears at all for a given copy, are
unverified.

This page does not suggest turning Gatekeeper, SmartScreen or Smart App Control off, or removing
a file's download mark. The walk records the path each vendor documents for opening one app.

### macOS

Apple: "When a user downloads and opens an app, a plug-in, or an installer package from outside
the App Store, Gatekeeper verifies that the software is from an identified developer, is
notarized by Apple to be free of known malicious content, and hasn't been altered." It also asks
for approval before downloaded software opens for the first time
([Gatekeeper and runtime protection](https://support.apple.com/guide/security/gatekeeper-and-runtime-protection-sec5599b66df/web)).
A Domovoi build passes none of the first two checks, so a downloaded copy is expected to be
refused at first launch.

From macOS Sequoia (15) on, Control-click and Open no longer gets past Gatekeeper; the person
has to go to System Settings, Privacy & Security
([Apple Developer news, 2024-08-06](https://developer.apple.com/news/?id=saqachfa)). Apple's
steps ([Open a Mac app from an unknown developer](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac)):

1. Open Domovoi from Applications once, so macOS refuses it. Dismiss the warning; do not move
   the app to the Bin.
2. Choose Apple menu, System Settings, then Privacy & Security in the sidebar.
3. Go to Security and choose "Open", then choose "Open Anyway". Apple says the button is there
   for about an hour after the refused open. Record the buttons your Mac showed.
4. Enter your login password, then choose OK.

macOS then keeps the app as an exception, and it opens like any other app from then on.

Record:

- the macOS version and whether the Mac is Apple silicon or Intel;
- whether the DMG had a download mark: `xattr -p com.apple.quarantine <file>.dmg` prints the
  attribute, or says it has none. A package built on the same Mac was not downloaded. Whether
  Gatekeeper refuses such a copy is not stated on Apple's pages above;
- the refusal dialog's title, text and buttons, word for word;
- what "Privacy & Security" showed under Security, and which buttons you chose;
- whether the app, its daemon and the login service then started (section 1 of the walk).

### Windows

Microsoft: SmartScreen checks a downloaded app or installer "against a list of files that are
well known and downloaded frequently. If the file isn't on that list, Microsoft Defender
SmartScreen shows a warning, advising caution." Reputation also attaches to "the digital signature
used to sign a file", and an item with no reputation "presents a warning to the user"
([SmartScreen overview](https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/)).
An unsigned installer has no signature to carry reputation, so a downloaded copy is expected to
be warned about. The same page says SmartScreen "protects against malicious files from the
internet". A downloaded file carries a `Zone.Identifier` stream with the value `3`
([Unblock-File](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/unblock-file));
`Get-Item <file>.exe -Stream Zone.Identifier` shows whether the installer has one.

Microsoft's own description of the warning is an archived 2013 post from Windows 8: the dialog
has a "More Info" option and a "Run Anyway" button, and a file without a valid signature shows
an unknown publisher
([archived post](https://learn.microsoft.com/en-us/archive/blogs/smondal/windows-smartscreen-prevented-an-unrecognized-app-from-running-running-this-app-might-put-your-pc-at-risk)).
No current Microsoft page found while writing this quotes the Windows 10 or 11 dialog. To go on,
choose "More info", check that the file name is the installer you built or downloaded, then
choose "Run anyway".

Smart App Control, on Windows 11, is stricter: "If the app is unsigned, or the signature is
invalid, Smart App Control will consider it untrusted and block it for your protection." and
"There is currently no way to bypass Smart App Control protection for individual apps."
([Smart App Control FAQ](https://support.microsoft.com/en-us/windows/smart-app-control-frequently-asked-questions-285ea03d-fa88-4d56-882e-6698afdb7003)).
On a machine where it is on, an unsigned Domovoi installer may not run at all. Record that as
blocked rather than turning Smart App Control off.

The installer is per user (`perMachine: false` in `apps/desktop/electron-builder.yml`). That it
then asks for no administrator approval is inference, not a run.

Record:

- the Windows edition and version, and whether Smart App Control was on;
- whether the installer had a `Zone.Identifier` stream;
- each dialog's title, text, the publisher it named and its buttons, word for word, for the
  installer and for the first launch of the installed app;
- whether a User Account Control prompt appeared;
- whether the app, its daemon and the login service then started (section 1 of the walk).

## Maintainer setup, shared

Do these steps deliberately. Neither credentials nor native account access exists in the
implementation environment, and no signing workflow was dispatched during implementation.

1. Merge the configuration and wait for the ordinary CI verdict on main.
2. In GitHub repository Settings, Environments, create **`desktop-macos`** and
   **`desktop-windows`**. Restrict each to the selected branch **`main`**, require a reviewer,
   and disable administrator bypass. If preventing self-review, arrange another reviewer.
   These are separate from the existing **`npm`** environment and its credentials.
3. Populate only the relevant platform's environment secrets and variables below. Do not put
   private keys or passwords in source files, arguments, repository-wide environment variables,
   build artifacts, or logs. The workflow passes them only to the packaging step, not dependency
   installation. P12/PFX secrets are base64 encodings of the encrypted file, not certificate
   text and not a URL. Keep an encrypted backup and revoke compromised credentials at the vendor.
4. When ready to spend signing authority, run **Actions, desktop-signing, Run workflow**,
   choose **main** and one platform, then approve its environment. This is a deliberate signing
   and native proof run, not automatic release publication. It verifies the exact commit's full
   CI verdict before requesting the environment. It does not use `RELEASE_PUBLISHING`.

The build produces the native runner's default architecture, not a universal Mac binary or a
Windows ARM64 proof. The gate can wait up to 45 minutes for CI; the gate job is bounded at 55
minutes. The native job is bounded at 60 minutes, including a 50-minute packaging step for
downloads, signing and vendor waits. Timeout is failure. Local packaging uses the builder's
own signing/notarization waits; the CI job limit is not a promised local command deadline.

Successful artifacts are retained for 14 days under `desktop-<platform>-<commit>`. Only DMG,
ZIP and EXE files upload, not keychains, intermediate trees or effective configuration.
Attaching approved installers to a public release is a separate maintainer step. This workflow
has read-only repository permissions and cannot publish a release.

## Apple: three different things

1. **Signing certificate and private key.** Join the paid Apple Developer Program. The team's
   Account Holder creates a **Developer ID Application** certificate using a CSR generated on
   a trusted Mac. Import the downloaded certificate into that Mac's keychain with the private
   key that created the CSR. Export the identity, including that private key, as an encrypted
   `.p12`. A `.cer` without its private key cannot sign. Apple Development, Apple Distribution
   and Mac App Store certificates are not substitutes. Developer ID **Installer** is for PKG
   installers, not our DMG/ZIP app distribution. [Apple certificate instructions](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/).
2. **Notarization authentication.** Use an Apple account with access to that developer team,
   with two-factor authentication enabled. Generate an **app-specific password** for this CI
   use. It authenticates uploads to Apple's notary service, not code signatures. It is neither
   the `.p12` password nor the normal Apple account password. Changing the account password
   revokes app-specific passwords. This path intentionally uses Apple ID authentication;
   API-key and keychain-profile notarization variants are refused, not silently substituted.
   [Apple app-specific passwords](https://support.apple.com/en-us/102654).
3. **Team identifier.** Copy the ten-character **Team ID** from Apple Developer account
   membership details. It identifies the team whose certificate must sign the app and which
   team the notarization request uses. It is not a certificate, private key, password, bundle ID
   or App Store Connect issuer ID. The bundle ID remains `sh.domovoi.desktop`.
   [Apple Developer ID and notarization](https://developer.apple.com/developer-id/).

In GitHub environment **`desktop-macos`**:

| Kind | Name | Exact content and process mapping |
| --- | --- | --- |
| Secret | `MAC_CSC_LINK` | Base64 of encrypted Developer ID Application `.p12`, passed as `CSC_LINK` |
| Secret | `MAC_CSC_KEY_PASSWORD` | That `.p12` export password, passed as `CSC_KEY_PASSWORD` |
| Secret | `APPLE_ID` | The Apple account email used for notarization |
| Secret | `APPLE_APP_SPECIFIC_PASSWORD` | Its dedicated app-specific password |
| Variable | `APPLE_TEAM_ID` | Ten-character Developer team ID |

On a trusted local Mac, use the process names in the table. `CSC_LINK` can instead be an
absolute path to the encrypted `.p12`. The builder imports it into a temporary keychain.
Do not pass credentials as CLI arguments or set debug output that might disclose tool inputs.
Xcode command-line tools must provide `codesign`, `notarytool` and `stapler`. Apple's service
must accept the complete bundled software, including native helpers and provider executables.

## Windows: choose one signer

For a new public signing identity, **Azure Artifact Signing** (formerly Trusted Signing) is the
supported cloud path. It is a paid Azure service with identity validation, not an Apple-style
notary upload and not a downloadable private certificate. Fetzy must confirm eligibility and
choose the signing identity. Individual developers are currently limited to the US and Canada;
organization availability differs. Follow the service's current eligibility rules, not an
assumption based on the project's npm organization. [Microsoft setup and eligibility](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart).

1. Obtain an Azure subscription and Microsoft Entra tenant. Register `Microsoft.CodeSigning`.
2. Create an Artifact Signing account, complete public identity validation, and create an
   active **Public Trust** certificate profile. Private Trust and Public Trust Test are not
   release identities. Record its region endpoint, account name, profile name and certificate
   subject Common Name. The displayed publisher is the validated identity, not an arbitrary
   `Domovoi` label. [Trust models](https://learn.microsoft.com/en-us/azure/artifact-signing/concept-trust-models).
3. Create an Entra application/service principal with a short-lived client secret. Assign
   **Artifact Signing Certificate Profile Signer** at that certificate profile's scope.
   Subscription Owner or Contributor alone does not grant signing. Record the tenant ID,
   application/client ID, and the **secret value**, not the secret ID. This v26 integration
   uses service-principal environment authentication, not GitHub OIDC.
   [Signing roles](https://learn.microsoft.com/en-us/azure/artifact-signing/concept-resources-roles).

In GitHub environment **`desktop-windows`**, Azure mode:

| Kind | Name | Exact content |
| --- | --- | --- |
| Secret | `AZURE_CLIENT_SECRET` | Entra application's client-secret value |
| Variable | `AZURE_TENANT_ID` | Entra directory/tenant ID |
| Variable | `AZURE_CLIENT_ID` | Application/client ID, not object ID |
| Variable | `AZURE_SIGNING_ENDPOINT` | Regional HTTPS endpoint, e.g. `https://eus.codesigning.azure.net` |
| Variable | `AZURE_SIGNING_ACCOUNT` | Artifact Signing account name |
| Variable | `AZURE_SIGNING_PROFILE` | Active Public Trust certificate profile name |
| Variable | `WINDOWS_PUBLISHER_NAME` | Exact certificate Common Name, passed as `DOMOVOI_WIN_PUBLISHER_NAME` |

Leave `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` absent in Azure mode. Electron-builder 26.15.3
uses `win.azureSignOptions` and the PowerShell `TrustedSigning` module. It installs that module
at build time, so PowerShell Gallery, Microsoft signing endpoints and the timestamp service
must be reachable. That vendor-tool download remains a dependency/reproducibility limit,
not something this branch has independently frozen or verified. The complete service-principal
environment is required before invoking it; the native negative-credential proof below must
confirm refusal at the vendor boundary. Do not add v27's `ExcludeCredentials` metadata option:
the v26 adapter forwards it as an unsupported PowerShell parameter.
[Pinned-major builder integration](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/),
[PowerShell module parameter contract](https://www.powershellgallery.com/packages/TrustedSigning/0.5.0/Content/TrustedSigning.psm1).

**Existing PFX alternative:** if a publisher already holds a usable Authenticode `.pfx`/`.p12`
and its private key, put its base64 bytes in secret **`WIN_CSC_LINK`**, its password in secret
**`WIN_CSC_KEY_PASSWORD`**, and its exact Common Name in variable **`WINDOWS_PUBLISHER_NAME`**.
Leave every Azure field absent. This does not promise that fetzy can buy a new exportable PFX.
Public CA code-signing private keys now require hardware-backed protection. A USB token or a
different CA's cloud HSM needs its own runner/provider integration and is not wired by this
branch. Do not upload a public `.cer`, fabricate a PFX from it, or buy an EV certificate solely
to avoid SmartScreen. Signing identifies the publisher; it does not guarantee immediate
SmartScreen reputation. [Microsoft's code-signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options).

## Required native proof before declaring this complete

Linux tests exercise the real v26 configuration loader/schema, missing credential refusals,
hook accounting, verification command order, wrong team, signer failure, shared deadlines and
workflow admission. Native tool results in those tests are injected. They are not signatures.
The actual unsigned Linux packaging path produced AppImage and deb files; its packaged-app smoke
loaded the PTY and keyring from the archive, exercised the worker, started the production daemon
and printed `DOMOVOI_DESKTOP_LAUNCH_SMOKE_OK`. That proves development packaging survived this
configuration change, not signing on another OS. No Apple or Microsoft signing request was sent,
and neither native signing target has been built by this branch. The workflow itself has not run.
The roadmap item therefore stays open.

For macOS, retain a real successful `DOMOVOI_MAC_SIGNATURE_OK` log line. It follows Developer ID
Application verification for the right team and `stapler validate` success. Download the archive
onto a clean Mac. Verify
the extracted app with `codesign --verify --deep --strict`, `xcrun stapler validate` and
`spctl --assess --type execute --verbose`. Open the DMG/ZIP distribution through Finder so
quarantine and Gatekeeper are exercised. Confirm the native PTY, keyring worker and production
daemon actually run with the hardened runtime, and that the daemon starts the person's own
installed agent CLIs from outside the app. The app bundles no agent binary, so signing never
re-signs one. A green submit alone does not prove these behaviors.

For Windows, retain the successful `DOMOVOI_AUTHENTICODE_OK` lines for the application and
installer, then verify the downloaded EXE with `Get-AuthenticodeSignature` on a clean machine.
Install, launch, exercise the production daemon/native modules and uninstall. Record actual
UAC publisher and SmartScreen behavior, without calling a reputation warning a signing failure.
Test a deliberately incorrect credential on each protected native path before trusting the
failure policy operationally. Until these runs exist, native packaging, key import, cloud
admission, notarization acceptance, timestamping, Gatekeeper and SmartScreen remain unproven.
