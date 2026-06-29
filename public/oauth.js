// ============================================================
// oauth.js — Sign in with Apple for the nostr key-backup flow (iOS only).
//
// Preferred path is NATIVE Sign in with Apple via @capacitor-community/apple-sign-in
// (window.Capacitor.Plugins.SignInWithApple) — it returns the identity token
// directly, no redirect URI needed. A web fallback is kept for completeness (it
// requires an HTTPS return URL, since Apple rejects custom schemes for the web flow).
//
// Outcome: a stable per-account id (`sub`) from the Apple identity token.
// Client id (Services ID) comes from window.SWELLNOTES_OAUTH.apple — see
// oauth-config.example.js. If it's missing, the button is hidden.
// ============================================================

export const OAUTH = (typeof window !== 'undefined' && window.SWELLNOTES_OAUTH) || {};

// Native Sign in with Apple (ASAuthorization) needs no Services ID — it uses the
// app's bundle id + the "Sign in with Apple" capability. So the button shows in the
// iOS app unconditionally. On the web (no native plugin) it needs a configured
// Services ID + HTTPS redirect for the fallback flow.
export function appleConfigured() {
  if (typeof window !== 'undefined' && window.Capacitor) return true;
  return !!(OAUTH.apple && OAUTH.apple.clientId && OAUTH.apple.redirectUri);
}

const APPLE_AUTH = 'https://appleid.apple.com/auth/authorize';

// ---- helpers ----
function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randB64url(n = 16) { return b64url(crypto.getRandomValues(new Uint8Array(n))); }

/** Decode a JWT payload and return the `sub` claim (signature already verified by Apple). */
export function jwtSub(idToken) {
  const part = idToken.split('.')[1];
  const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
  const sub = JSON.parse(json).sub;
  if (!sub) throw new Error('id_token has no sub');
  return sub;
}

// ---- web-fallback redirect plumbing (only used if no native plugin) ----
let _pendingRedirect = null;
export function handleOAuthRedirect(url) {
  if (!_pendingRedirect) return false;
  let u; try { u = new URL(url); } catch { return false; }
  const p = new URLSearchParams(u.search.slice(1));
  const f = new URLSearchParams((u.hash || '').slice(1));
  const get = k => p.get(k) || f.get(k);
  if (!get('code') && !get('id_token') && !get('error')) return false;
  const { resolve, reject, state } = _pendingRedirect;
  _pendingRedirect = null;
  try { window.Capacitor?.Plugins?.Browser?.close(); } catch {}
  if (get('error')) { reject(new Error('OAuth error: ' + get('error'))); return true; }
  if (state && get('state') && get('state') !== state) { reject(new Error('OAuth state mismatch')); return true; }
  resolve({ idToken: get('id_token') });
  return true;
}
function openAuthUrl(url, state) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { if (_pendingRedirect) { _pendingRedirect = null; reject(new Error('Sign-in timed out')); } }, 180000);
    _pendingRedirect = { resolve: v => { clearTimeout(to); resolve(v); }, reject: e => { clearTimeout(to); reject(e); }, state };
    if (window.Capacitor?.Plugins?.Browser) window.Capacitor.Plugins.Browser.open({ url, presentationStyle: 'popover' });
    else window.location.href = url;
  });
}

// ---- Apple (Sign in with Apple) ----
export async function signInApple() {
  if (!appleConfigured()) throw new Error('Apple sign-in is not configured');
  const { clientId, redirectUri } = OAUTH.apple || {};
  const C = window.Capacitor;
  let native = C?.Plugins?.SignInWithApple;
  if (!native && typeof C?.registerPlugin === 'function') { try { native = C.registerPlugin('SignInWithApple'); } catch {} }
  if (native && typeof native.authorize === 'function') {
    const res = await native.authorize({
      clientId, redirectURI: redirectUri, scopes: 'name email',
      nonce: randB64url(), state: randB64url(),
    });
    const idToken = res?.response?.identityToken;
    if (!idToken) throw new Error('Apple sign-in returned no identity token');
    return { provider: 'apple', sub: jwtSub(idToken) };
  }
  // Web fallback (needs an HTTPS redirectUri).
  const state = randB64url();
  const url = `${APPLE_AUTH}?${new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code id_token',
    scope: 'name email', response_mode: 'fragment', state, nonce: randB64url(),
  })}`;
  const { idToken } = await openAuthUrl(url, state);
  if (!idToken) throw new Error('Apple did not return an id_token');
  return { provider: 'apple', sub: jwtSub(idToken) };
}
