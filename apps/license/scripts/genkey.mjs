/**
 * Mints the Ed25519 signing keypair for the license server.
 *
 * Run once, put the private key in the Railway variable, and bake the public
 * key into the daemon and the relay. The private key must never enter the
 * repository or any client bundle — it is the only thing standing between an
 * attacker and minting their own licenses.
 *
 *   node scripts/genkey.mjs
 */
import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');

const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

console.log('# Railway variable (license service) — keep secret:');
console.log(`LICENSE_SIGNING_KEY_PEM="${pem.trim().replace(/\n/g, '\\n')}"`);
console.log();
console.log('# Bake this public key into the daemon and relay:');
console.log(pub);
