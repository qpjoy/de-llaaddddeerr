# macOS Signing and Notarization

For customer delivery, macOS builds must be Developer ID signed, notarized, and
stapled. A DMG can be copied without signing, but a downloaded unsigned or
unnotarized app keeps the quarantine attribute and Gatekeeper blocks normal
launch. Asking users to run `xattr -rd com.apple.quarantine ...` is only a
manual bypass for testing or emergency support.

## Required Release Path

1. Build `MX Launcher.app` with hardened runtime enabled.
2. Sign the app with `Developer ID Application`.
3. Notarize the signed app or DMG through Apple's notary service.
4. Staple the notarization ticket.
5. Ship the notarized DMG for drag-to-Applications install.

## electron-builder Inputs

`desktop/electron-builder.yml` sets:

- `mac.target: dmg, zip`
- `mac.hardenedRuntime: true`
- `mac.notarize: true`
- `mac.entitlements` and `mac.entitlementsInherit`
- `dmg.sign: true`

CI needs one of the supported Apple credential flows, for example:

```bash
export CSC_LINK=/secure/certs/developer-id-application.p12
export CSC_KEY_PASSWORD='...'
export APPLE_ID='release@example.com'
export APPLE_APP_SPECIFIC_PASSWORD='...'
export APPLE_TEAM_ID='TEAMID1234'
pnpm --dir electron-dock/mx-launcher/desktop package:mac:dmg
```

App Store Connect API key credentials are also acceptable if the CI keychain
flow prefers them.

## Local Development

Unsigned or ad-hoc signed builds are fine for local smoke tests, but they are
not customer artifacts. The release checklist should fail a macOS customer build
if notarization is skipped.
