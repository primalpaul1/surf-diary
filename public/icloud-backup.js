// ============================================================
// icloud-backup.js — store the encrypted key blob in the user's iCloud Keychain
// (synchronizable items, end-to-end encrypted by Apple, synced across the user's
// devices). Mirrors wisp-ios KeychainBackupService. Backed by the native
// KeychainPlugin (save/load/clear/list).
//
// Each backup is one generic-password item:
//   account = "swellnotes_bk_apple_<uuid>",  value = NIP-44 blob (text)
// ============================================================

const PREFIX = 'swellnotes_bk_apple_';

function uuid() {
  return (crypto.randomUUID ? crypto.randomUUID()
    : [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join(''));
}

/**
 * Build an iCloud backup store over a resolved native Keychain plugin handle
 * ({ save, load, clear, list }).
 */
export function makeICloudBackup(keychain) {
  if (!keychain) throw new Error('Keychain plugin unavailable');
  return {
    /** → [{ account, blob }] for every backup synced to this device. */
    async list() {
      const r = await keychain.list({ prefix: PREFIX });
      return (r?.items || [])
        .map(i => ({ account: i.account, blob: i.value }))
        .filter(i => i.blob);
    },
    /** Store a new encrypted blob; returns its keychain account id. */
    async upload(blobText) {
      const account = PREFIX + uuid();
      await keychain.save({ key: account, value: blobText });
      return account;
    },
    /** Remove a backup by account id. */
    async remove(account) {
      await keychain.clear({ key: account });
    },
  };
}
