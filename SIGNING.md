# Signing & notarizing the macOS build

The default `npm run build:mac` produces an **unsigned** app — fine for local
testing, but macOS Gatekeeper warns users ("Apple could not verify…"). To ship
a build that opens cleanly, it must be **signed with an Apple Developer ID
Application certificate** and **notarized** by Apple.

This is the one-time guide for whoever has the Apple Developer account doing the
signed build. The project is already configured (hardened runtime + entitlements
in [apps/desktop/electron-builder.yml](apps/desktop/electron-builder.yml) and
apps/desktop/build/entitlements.mac.plist); you only supply
the certificate and notarization credentials.

## What you need

1. **An active Apple Developer account** ($99/yr).
2. A **Developer ID Application** certificate in your login keychain. Create it
   in Xcode (Settings → Accounts → Manage Certificates → +) or from the Apple
   Developer portal, then double-click the downloaded `.cer` to install it. Verify:
   ```sh
   security find-identity -p codesigning -v | grep "Developer ID Application"
   ```
   electron-builder picks this up automatically — no config needed.
3. **Notarization credentials.** Easiest is an App Store Connect **API key**
   (App Store Connect → Users and Access → Integrations → Keys → generate one
   with "Developer" access; download the `AuthKey_XXXX.p8` once).

## Build it (on your Mac)

```sh
git clone https://github.com/keithagroves/codeswim
cd codeswim
npm ci

# Notarization credentials (API-key method, recommended):
export APPLE_API_KEY="/absolute/path/AuthKey_ABCD1234.p8"
export APPLE_API_KEY_ID="ABCD1234"          # the key ID
export APPLE_API_ISSUER="aaaa-bbbb-cccc-…"  # the issuer UUID from the Keys page

npm run build:mac:signed
```

(Alternatively, the Apple ID method: `export APPLE_ID=…`,
`APPLE_APP_SPECIFIC_PASSWORD=…`, `APPLE_TEAM_ID=…` — an app-specific password is
generated at appleid.apple.com, **not** your normal password.)

`build:mac:signed` signs every binary in the bundle (including the bundled
`opencode` helper), uploads to Apple for notarization, waits, and staples the
ticket. It produces a DMG under `apps/desktop/dist/`.

The app's bundle id is `com.keithagroves.codeswim`; it does **not** need to match
your team — any valid Developer ID can sign it.

## Verify before sending it out

```sh
spctl -a -vvv -t install "apps/desktop/dist/mac-arm64/codeswim.app"   # → "accepted, source=Notarized Developer ID"
xcrun stapler validate "apps/desktop/dist/mac-arm64/codeswim.app"      # → "The validate action worked!"
```

## Publishing the result

- **Simplest:** hand the notarized `apps/desktop/dist/codeswim-<version>.dmg` back to Keith,
  who attaches it to the GitHub release.
- **Or publish directly:** append `--publish always` to the build command with a
  `GH_TOKEN` env var that has write access to `keithagroves/codeswim`.

## Doing it in CI instead (optional, later)

To sign on GitHub Actions rather than a laptop, add these repo secrets and an env
block to the macOS job in .github/workflows/release.yml:

- `CSC_LINK` — base64 of the exported `.p12` (`base64 -i cert.p12 | pbcopy`)
- `CSC_KEY_PASSWORD` — the `.p12` export password
- Notarization: `APPLE_API_KEY` (base64 of the `.p8`), `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER`

Then switch that job's command to `npm run build:mac:signed --workspace @codeswim/desktop -- --publish always`.
This is left unconfigured on purpose so unsigned CI builds keep working until the
secrets exist.
