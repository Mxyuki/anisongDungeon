/**
 * Encrypts app/data/library.json into library/library.enc, the password-protected song library
 * that can be published on GitHub. Hosts who know the password get it decrypted by the launcher
 * (launcher/serve.ps1, Unlock-Library). Run with: npm run encrypt-library
 * The password is read from LIBRARY_PASSWORD, or asked for (hidden).
 *
 * File format (all binary):
 *   "ADLIB1" | iterations (uint32 BE) | salt (16) | iv (16) | ciphertext | hmac (32)
 *   plaintext  = gzip(library.json)
 *   keys       = PBKDF2-SHA256(password, salt, iterations, 64 bytes): AES key = first 32, MAC key = last 32
 *   ciphertext = AES-256-CBC (PKCS7)
 *   hmac       = HMAC-SHA256(MAC key, every byte before it)   (encrypt-then-MAC)
 */
import { createCipheriv, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const MAGIC = Buffer.from('ADLIB1', 'ascii');
const ITERATIONS = 600_000;
const MIN_PASSWORD_LENGTH = 8;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = process.argv[2] ?? join(ROOT, 'app', 'data', 'library.json');
const TARGET = process.argv[3] ?? join(ROOT, 'library', 'library.enc');

/** Reads a line without echoing it. */
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (text) => {
      if (text.includes(question)) rl.output.write(text);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function readPassword() {
  if (process.env.LIBRARY_PASSWORD) return process.env.LIBRARY_PASSWORD;
  const password = await askHidden('Library password: ');
  const confirm = await askHidden('Repeat the password: ');
  if (password !== confirm) throw new Error('The passwords do not match.');
  return password;
}

const password = await readPassword();
if (password.length < MIN_PASSWORD_LENGTH) {
  throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters (the encrypted file is public).`);
}

const salt = randomBytes(16);
const iv = randomBytes(16);
const keys = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, ITERATIONS, 64, 'sha256');
const cipher = createCipheriv('aes-256-cbc', keys.subarray(0, 32), iv);
const ciphertext = Buffer.concat([cipher.update(gzipSync(readFileSync(SOURCE), { level: 9 })), cipher.final()]);

const iterations = Buffer.alloc(4);
iterations.writeUInt32BE(ITERATIONS);
const body = Buffer.concat([MAGIC, iterations, salt, iv, ciphertext]);
const mac = createHmac('sha256', keys.subarray(32)).update(body).digest();

mkdirSync(dirname(TARGET), { recursive: true });
writeFileSync(TARGET, Buffer.concat([body, mac]));
console.log(`Encrypted ${SOURCE} → ${TARGET} (${Math.round((body.length + mac.length) / 1024)} KB).`);
