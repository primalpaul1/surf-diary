// ============================================================
// auth-backup.js — orchestrates Sign in with Apple → nostr key backup (iOS only).
//
// Flow:
//   1. Sign in with Apple        → { sub }
//   2. List encrypted backups    → iCloud Keychain
//   3a. backups found  → ask PIN → decrypt all that match → choose account → log in
//   3b. none found     → ask to set a PIN → generate a fresh nostr key → encrypt → store
//
// The nostr secret key is generated locally and only ever leaves the device as a
// PIN-encrypted NIP-44 blob in the user's iCloud Keychain. No app backend involved.
// ============================================================

import { generateSecretKey, getPublicKey, nip19 } from '/nostr-bundle.js';
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt } from '/nostr-bundle.js';
import { initKeyBackup, makeBackupBlob, openBackupBlob, bytesToHex } from '/key-backup.js';
import * as oauth from '/oauth.js';
import { makeICloudBackup } from '/icloud-backup.js';

initKeyBackup({ encrypt: nip44Encrypt, decrypt: nip44Decrypt });

const PROVIDER = 'apple';

/**
 * Step 1+2. Sign in with Apple and discover whether the user already has backups.
 * @returns {Promise<{ctx, mode:'restore'|'setup', count:number}>}
 */
export async function beginSignIn(keychainPlugin) {
  const session = await oauth.signInApple();
  const ic = makeICloudBackup(keychainPlugin);
  const backups = await ic.list();                 // [{ account, blob }]
  const ctx = { provider: PROVIDER, sub: session.sub, store: ic, backups };
  return { ctx, mode: backups.length ? 'restore' : 'setup', count: backups.length };
}

function accountFromSk(skBytes) {
  const pubkey = getPublicKey(skBytes);
  return { pubkey, npub: nip19.npubEncode(pubkey), secretKey: bytesToHex(skBytes) };
}

/**
 * Step 3a. Try the PIN against every backup; return the accounts that decrypt.
 * Throws if none decrypt (wrong PIN).
 */
export async function restoreWithPin(ctx, pin) {
  const out = [];
  for (const ref of ctx.backups) {
    try {
      const sk = await openBackupBlob({ provider: ctx.provider, accountId: ctx.sub, pin, ciphertext: ref.blob });
      out.push({ ...accountFromSk(sk), _ref: ref });
    } catch { /* this blob didn't match the PIN — skip */ }
  }
  if (!out.length) throw new Error('Incorrect PIN');
  const seen = new Set();
  return out.filter(a => (seen.has(a.pubkey) ? false : seen.add(a.pubkey)));
}

/** Step 3b. Generate a fresh nostr key, encrypt with the PIN, store the backup. */
export async function createAccount(ctx, pin) {
  const sk = generateSecretKey();
  const blob = await makeBackupBlob({ provider: ctx.provider, accountId: ctx.sub, pin, skBytes: sk });
  await ctx.store.upload(blob);
  return accountFromSk(sk);
}

export const handleOAuthRedirect = oauth.handleOAuthRedirect;
export const appleConfigured = oauth.appleConfigured;
