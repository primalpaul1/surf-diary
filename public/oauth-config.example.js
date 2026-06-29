// Copy this file to `public/oauth-config.js` (gitignored) and fill in your id.
// Loaded before app.js; sets window.SWELLNOTES_OAUTH. If the apple block is
// missing/empty, the "Continue with Apple" button is hidden automatically.
//
// See docs/oauth-login-setup.md for how to obtain these.
window.SWELLNOTES_OAUTH = {
  apple: {
    // Services ID (NOT the app bundle id) from the Apple Developer portal,
    // configured for "Sign in with Apple".
    clientId: '',                 // e.g. 'com.swellnotes.signin'
    redirectUri: 'swellnotes://oauth/apple',
  },
};
