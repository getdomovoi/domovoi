# Mobile store readiness

Status: preparation only, 2026-10-11. M2 starts with desktop and web invite-beta
surfaces. Native store distribution follows separately. This document does not
close SHIP-PLAN S4.4 or the TestFlight part of S4.5, and authorizes no account,
certificate, upload, listing or release operation.

## What exists

`apps/mobile` contains the native client and its Vitest/Jest suites. Its package
build exports the iOS application through Expo; that export is not a signed
archive, installed-device proof, store upload or review result.
`apps/mobile/app.json` declares iOS and Android application identifiers, a
configured Apple team identifier, camera pairing permission copy and photo
attachment permissions. Configuration is not evidence of account ownership,
certificate access or accepted privacy disclosures.

The current milestone can use the web client without claiming a store release.
Do not promise hosted relay access before the relay and endpoint acceptance gates
pass. See [internal release channels](internal-release-channels.md) for the
separate daemon, desktop and mobile delivery boundaries.

## Owner and evidence checklist

fetzy is the release decision owner. A person with verified account authority must
be named for each vendor operation before it begins. Do not put account secrets,
private signing material, tester email lists or reviewer credentials in this tree.
Record dated evidence references in restricted release records instead.

| Gate | Preparation that can happen locally | Evidence still required |
| --- | --- | --- |
| Account authority | Compare configured app identifiers to the intended release identity | Owner-verified developer account/team access and named release operator |
| Signing custody | Inventory needed signing and recovery operations without generating keys | Owner-approved certificate/key custody, restricted access and recovery record |
| Native artifacts | Record source commit, version, dependency lock and build inputs | Signed installable iOS/Android artifact with digest and platform verification |
| Device acceptance | Write a synthetic pairing, attach, approve/deny, disconnect and resume walkthrough | Dated real-device runs, supported OS/device scope and recorded failures |
| Privacy and permissions | Inventory application and dependency data flows, including pairing, selected attachments, diagnostics and relay metadata | Owner-approved accurate disclosures, permission copy and policy links for the actual shipped configuration |
| Beta audience | Define an invite cohort and support/removal process | Authorized tester group, accepted build and a successful install/update proof |
| Review and listing | Prepare screenshots and descriptions from the actual release build | Owner-approved submission, platform review outcome and explicit publication approval |
| Recovery | Document lost-device revocation, signing-key loss and withdrawing a bad build | Operator rehearsal and a recovery path that does not disclose endpoint secrets |

Privacy preparation must distinguish application content on the execution machine
from metadata visible to a hosted relay. Inspect actual dependency behavior before
making collection claims. Camera and photo permission strings describe intent;
they do not prove retention, transmission or deletion behavior. A store form is
not a substitute for the architecture's external review gate.

## Sequence after explicit release authorization

1. Verify the intended account, identifiers, supported devices and operator.
2. Confirm signing custody and build the exact reviewed source revision.
3. Verify the signed artifact and install it on real test devices. Preserve
   failures as evidence; an exported JavaScript bundle does not pass this step.
4. Reconcile privacy answers and screenshots with that artifact and its enabled
   services. Resolve missing evidence before submission.
5. Upload only through the separately authorized beta workflow, verify tester
   installation and update behavior, and record the resulting build identity.
6. Seek a separate publication decision after review and beta acceptance. A beta
   upload is not public launch authorization.

TestFlight distributes beta builds through App Store Connect; internal and
external tester workflows have distinct requirements. Consult the current
[Apple TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)
when planning that operation. Android testing tracks and internal app sharing are
separate mechanisms; select the intended one explicitly using the current
[Google Play testing guide](https://support.google.com/googleplay/android-developer/answer/9845334).
These links were checked on 2026-10-11. Account-specific eligibility and review
requirements must be verified by the release operator when the operation begins.

No store account, certificate, privacy submission, uploaded build, accepted review
or native release proof is established by this readiness document.
