# Sign in with Apple (nostr key backup) — setup

Swellnotes (iOS) lets non-nostr users sign up with **Apple**, the same way the Wisp
client does: **non-custodial, no app backend.** A nostr keypair is generated
on-device, encrypted with the user's **PIN**, and the encrypted blob is stored in
the user's **own iCloud Keychain**. Apple never sees the key; we never see the key.

This doc is for wiring up the credentials. The code is already in place.

## How it works (model)

```
1. User taps "Continue with Apple"  → Sign in with Apple → stable account id (`sub`)
2. PIN  →  key = PBKDF2-HMAC-SHA256(PIN, salt = HMAC-SHA256("swellnotes-apple-backup", sub), 600k)
3. nsec (random, on-device) → NIP-44 v2 encrypt with `key` → blob
4. blob → user's iCloud Keychain (synchronizable, end-to-end encrypted by Apple)
   Recovery on a new device = same Apple login + the synced blob + the PIN.
```

The PIN is the real secret; Apple only provides a stable salt + iCloud sync.
Signing is **local** (the nsec lives in the iOS Keychain after login) — no NIP-46.

## Files

| File | Role |
|---|---|
| `public/key-backup.js` | Crypto: PBKDF2 + per-account salt + NIP-44 encrypt/decrypt. **Tested** in `test/key-backup.test.mjs`. |
| `public/oauth.js` | Sign in with Apple (native plugin preferred, web fallback). |
| `public/icloud-backup.js` | iCloud Keychain store (via native `KeychainPlugin`). |
| `public/auth-backup.js` | Orchestrator: sign-in → list → restore-with-PIN / setup-new. |
| `public/oauth-config.js` | **Gitignored.** Your Services ID (copy from `oauth-config.example.js`). |
| `ios/App/App/KeychainPlugin.swift` | Synchronizable keychain save/load/clear/**list**. |
| app UI | Landing button + PIN modal + account chooser (`index.html`, `app.js`, `styles.css`). |

Run the crypto test: `node test/key-backup.test.mjs`

## Apple setup

Apple's **web** Sign in flow requires an **HTTPS** return URL (custom schemes like
`swellnotes://` are rejected), so on iOS use **native** Sign in with Apple:

1. Install the native plugin and sync:
   ```
   npm i @capacitor-community/apple-sign-in
   npx cap sync ios
   ```
   `oauth.js#signInApple` auto-detects `Capacitor.Plugins.SignInWithApple`.
2. Apple Developer portal:
   - Enable the **Sign in with Apple** capability for the App ID `com.swellnotes.app`.
   - Create a **Services ID** (e.g. `com.swellnotes.signin`).
3. Add the entitlement to `ios/App/App/App.entitlements`:
   ```xml
   <key>com.apple.developer.applesignin</key>
   <array><string>Default</string></array>
   ```
   (Not added by default — it needs the capability enabled on your provisioning
   profile, or device builds fail to sign.)
4. Put the Services ID in `public/oauth-config.js` → `apple.clientId`.

## Notes / caveats

- **Test on a real device.** Sign in with Apple and iCloud Keychain don't work
  properly in the simulator. Use a signed build on your iPhone (signed into iCloud).
- **The "Continue with Apple" button auto-hides** when `apple.clientId` is empty
  (Wisp behavior). The placeholder id in `oauth-config.js` only makes it render for
  UI work — sign-in fails until a real id + the native plugin/entitlement exist.
- **PIN entropy:** a 4–8 digit PIN (~13–26 bits) + 600k-iter KDF + iCloud access
  control is the security model. Consider offering a longer passphrase option.
- **Device-build note:** the current `capacitor.config.json` has a live-reload
  `server.url` pointing at the dev machine. Remove it before building for a device
  or TestFlight so the bundled assets load.
