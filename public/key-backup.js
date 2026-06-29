// ============================================================
// key-backup.js — Wisp-style non-custodial nostr key backup
// ------------------------------------------------------------
// The nostr secret key is generated locally, then encrypted with a key
// derived from the user's PIN (the real secret) salted by a stable OAuth
// account id. The encrypted blob is stored in the user's OWN cloud
// (iCloud Keychain) — never on our server, never readable by us or by Apple.
//
// Recipe (matches barrydeen/wisp-ios BackupCrypto.swift):
//   salt = HMAC-SHA256(key = providerContext, msg = oauthAccountId)
//   key  = PBKDF2-HMAC-SHA256(password = PIN, salt, 600_000 iters, 32 bytes)
//   blob = NIP-44 v2 encrypt( plaintext = hex(privkey32), conversationKey = key )
//
// nip44 is injected (not imported) so this same module runs in the browser
// (via /nostr-bundle.js) and under node (via nostr-tools) for testing.
// ============================================================

let _nip44 = null;
/** @param {{encrypt:(pt:string,key:Uint8Array)=>string, decrypt:(ct:string,key:Uint8Array)=>string}} nip44 */
export function initKeyBackup(nip44) { _nip44 = nip44; }

const PBKDF2_ITERS = 600_000;

// Provider-specific salt context (distinct string per provider, in case more are
// ever added — keeps blobs from cross-decrypting).
export const SALT_CONTEXT = {
  apple: 'swellnotes-apple-backup',
};

const _enc = new TextEncoder();
const _subtle = () => globalThis.crypto.subtle;

export function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}
export function hexToBytes(hex) {
  if (hex.length % 2) throw new Error('bad hex length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = parseInt(hex.substr(i * 2, 2), 16);
    if (Number.isNaN(b)) throw new Error('bad hex');
    out[i] = b;
  }
  return out;
}

// salt = HMAC-SHA256(key = context, msg = accountId)  -> 32 bytes
async function perAccountSalt(context, accountId) {
  const key = await _subtle().importKey('raw', _enc.encode(context), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await _subtle().sign('HMAC', key, _enc.encode(accountId));
  return new Uint8Array(sig);
}

/**
 * Derive the 32-byte backup key from the PIN + provider context + OAuth account id.
 * @param {{pin:string, context:string, accountId:string}} args
 * @returns {Promise<Uint8Array>} 32-byte key, used directly as the NIP-44 conversation key
 */
export async function deriveBackupKey({ pin, context, accountId }) {
  if (!pin) throw new Error('pin required');
  if (!context) throw new Error('context required');
  if (!accountId) throw new Error('accountId required');
  const salt = await perAccountSalt(context, accountId);
  const baseKey = await _subtle().importKey('raw', _enc.encode(pin), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await _subtle().deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    baseKey, 256
  );
  return new Uint8Array(bits);
}

/** Encrypt a 32-byte secret key into a NIP-44 v2 blob using the derived key. */
export function encryptNsec(skBytes, key32) {
  if (!_nip44) throw new Error('initKeyBackup() not called');
  if (!(skBytes instanceof Uint8Array) || skBytes.length !== 32) throw new Error('skBytes must be 32 bytes');
  if (!(key32 instanceof Uint8Array) || key32.length !== 32) throw new Error('key32 must be 32 bytes');
  return _nip44.encrypt(bytesToHex(skBytes), key32);
}

/** Decrypt a NIP-44 v2 blob back into the 32-byte secret key. Throws on wrong PIN/blob. */
export function decryptNsec(ciphertext, key32) {
  if (!_nip44) throw new Error('initKeyBackup() not called');
  const hex = _nip44.decrypt(ciphertext, key32);
  const sk = hexToBytes(hex);
  if (sk.length !== 32) throw new Error('decrypted key is not 32 bytes');
  return sk;
}

/**
 * Full convenience: encrypt a secret key for a given OAuth identity + PIN.
 * @param {{provider:'apple', accountId:string, pin:string, skBytes:Uint8Array}} a
 */
export async function makeBackupBlob({ provider, accountId, pin, skBytes }) {
  const context = SALT_CONTEXT[provider];
  if (!context) throw new Error('unknown provider: ' + provider);
  const key = await deriveBackupKey({ pin, context, accountId });
  return encryptNsec(skBytes, key);
}

/** Full convenience: try to decrypt a blob with an OAuth identity + PIN. Returns 32-byte sk or throws. */
export async function openBackupBlob({ provider, accountId, pin, ciphertext }) {
  const context = SALT_CONTEXT[provider];
  if (!context) throw new Error('unknown provider: ' + provider);
  const key = await deriveBackupKey({ pin, context, accountId });
  return decryptNsec(ciphertext, key);
}
