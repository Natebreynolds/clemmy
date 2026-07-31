#!/usr/bin/env node
/**
 * Mints the admin credential for the licensing panel.
 *
 * Prints ADMIN_PASSWORD_HASH, ADMIN_TOTP_SECRET, ADMIN_SESSION_SECRET and an
 * otpauth:// URL to enroll in an authenticator app. Nothing is written to disk
 * or sent anywhere — copy the values into the deployment's env.
 *
 * Usage:
 *   node scripts/admin-credential.mjs --email nathan@example.com
 *   node scripts/admin-credential.mjs --email n@x.com --password 'correct horse'
 *
 * The scrypt parameters below MUST stay in sync with src/lib/admin/crypto.ts;
 * a mismatch produces a hash the app can never verify.
 */
import { randomBytes, scryptSync } from "node:crypto";
import { createInterface } from "node:readline";

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function arg(name) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index !== -1 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    return process.argv[index + 1];
  }
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : undefined;
}

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Prompts without echoing, so the password never lands in a scrollback. */
function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let first = true;
    rl._writeToOutput = (chunk) => {
      if (first) {
        rl.output.write(chunk);
        first = false;
      }
    };
    rl.question(question, (answer) => {
      rl.output.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const email = arg("email") ?? "admin@clementine.app";
  const issuer = arg("issuer") ?? "Clementine Licensing";

  let password = arg("password") ?? process.env.ADMIN_PASSWORD;
  if (!password) password = await promptHidden("Password: ");
  password = String(password);

  if (password.length < 12) {
    console.error("\nRefusing: use at least 12 characters. This password guards license issuance.");
    process.exit(1);
  }

  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize("NFKC"), salt, KEYLEN, SCRYPT);
  const passwordHash = `${salt.toString("hex")}:${hash.toString("hex")}`;

  const totpSecret = base32Encode(randomBytes(20));
  const sessionSecret = randomBytes(32).toString("hex");

  const params = new URLSearchParams({
    secret: totpSecret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  const otpauth = `otpauth://totp/${encodeURIComponent(`${issuer}:${email}`)}?${params.toString()}`;

  console.log(`
Admin credential for ${email}
${"─".repeat(60)}

Set these on the apps/web deployment:

ADMIN_EMAIL=${email}
ADMIN_PASSWORD_HASH=${passwordHash}
ADMIN_TOTP_SECRET=${totpSecret}
ADMIN_SESSION_SECRET=${sessionSecret}

Enroll the TOTP secret in your authenticator — add this URL as a manual
entry, or turn it into a QR code:

${otpauth}

Notes
  · Changing ADMIN_SESSION_SECRET signs out every existing session.
  · The TOTP secret is shown once here; it is not recoverable from the hash.
  · Verify a code from your authenticator works before closing the old session.
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
