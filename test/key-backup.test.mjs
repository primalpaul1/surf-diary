// Node test for the Wisp-style key backup crypto. Run: node test/key-backup.test.mjs
import { webcrypto } from 'node:crypto';
import * as nostr from 'nostr-tools';
import assert from 'node:assert';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const kb = await import('../public/key-backup.js');
kb.initKeyBackup({ encrypt: nostr.nip44.v2.encrypt, decrypt: nostr.nip44.v2.decrypt });

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log('  ✓', msg); pass++; };

const sk = nostr.generateSecretKey();              // Uint8Array(32)
const skHex = kb.bytesToHex(sk);
const accountId = 'apple-user-001122334455';        // stable Apple `user` id

// 1. round-trip with correct PIN
const blob = await kb.makeBackupBlob({ provider: 'apple', accountId, pin: '4271', skBytes: sk });
ok(typeof blob === 'string' && blob.length > 40, 'encrypt produces a NIP-44 blob string');
const back = await kb.openBackupBlob({ provider: 'apple', accountId, pin: '4271', ciphertext: blob });
ok(kb.bytesToHex(back) === skHex, 'correct PIN decrypts to the original secret key');

// 2. wrong PIN must fail
let threw = false;
try { await kb.openBackupBlob({ provider: 'apple', accountId, pin: '0000', ciphertext: blob }); } catch { threw = true; }
ok(threw, 'wrong PIN throws (NIP-44 MAC rejects)');

// 3. wrong accountId (salt) must fail
threw = false;
try { await kb.openBackupBlob({ provider: 'apple', accountId: 'someone-else', pin: '4271', ciphertext: blob }); } catch { threw = true; }
ok(threw, 'different account id (salt) throws');

// 4. determinism: same inputs -> same derived key (so a second device recovers)
const k1 = await kb.deriveBackupKey({ pin: '4271', context: kb.SALT_CONTEXT.apple, accountId });
const k2 = await kb.deriveBackupKey({ pin: '4271', context: kb.SALT_CONTEXT.apple, accountId });
ok(kb.bytesToHex(k1) === kb.bytesToHex(k2) && k1.length === 32, 'key derivation is deterministic (32 bytes)');

// 5. fresh nonce per encryption, still decrypts
const blob2 = await kb.makeBackupBlob({ provider: 'apple', accountId, pin: '4271', skBytes: sk });
ok(blob2 !== blob, 'each encryption uses a fresh nonce (ciphertext differs)');
const back2 = await kb.openBackupBlob({ provider: 'apple', accountId, pin: '4271', ciphertext: blob2 });
ok(kb.bytesToHex(back2) === skHex, 'second blob also decrypts to the original key');

console.log(`\nALL ${pass} ASSERTIONS PASSED`);
