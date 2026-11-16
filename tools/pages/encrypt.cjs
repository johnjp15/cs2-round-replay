#!/usr/bin/env node
// Encrypt every cs2 page for the public site.
//
//   CS2_PASSWORD=... node tools/encrypt.cjs <cs2-source-dir> <output-dir>
//
// Pages are cs2/index.html and cs2/<page>/index.html. Each one must be self-contained
// (inline CSS/JS/data/images): only these HTML files are copied, and each is replaced by
// tools/lock.html carrying the page as AES-256-GCM ciphertext. The key is PBKDF2-SHA256
// of the password with the shared salt in tools/lock.json, so one password (and one
// remembered key) unlocks every page.
//
// tools/lock.json also keeps a verifier, so a mistyped password is refused instead of
// silently locking everyone out. To switch to a new password, also set CS2_NEW_PASSWORD=1.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [, , SRC, DEST] = process.argv;
if (!SRC || !DEST) {
  console.error('Usage: CS2_PASSWORD=... node tools/encrypt.cjs <cs2-source-dir> <output-dir>');
  process.exit(2);
}
const password = (process.env.CS2_PASSWORD || '').normalize('NFC');
if (!password) {
  console.error('Set CS2_PASSWORD to the password for the cs2 pages.');
  process.exit(2);
}

const cfgPath = path.join(SRC, 'tools', 'lock.json');
const cfg = fs.existsSync(cfgPath)
  ? JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  : { version: 1, salt: crypto.randomBytes(16).toString('base64'), iterations: 600000 };

const key = crypto.pbkdf2Sync(password, Buffer.from(cfg.salt, 'base64'), cfg.iterations, 32, 'sha256');
const verifier = crypto.createHmac('sha256', key).update('cs2-lock-verifier').digest('base64');
if (cfg.verifier && cfg.verifier !== verifier && process.env.CS2_NEW_PASSWORD !== '1') {
  console.error('That is not the current cs2 password, so nothing was written.');
  console.error('To change the password for every page, run again with CS2_NEW_PASSWORD=1.');
  process.exit(1);
}
cfg.verifier = verifier;
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');

const template = fs.readFileSync(path.join(SRC, 'tools', 'lock.html'), 'utf8');
if (!template.includes('__PAYLOAD__')) throw new Error('tools/lock.html has no __PAYLOAD__ marker');

const SKIP = new Set(['tools', 'node_modules']);
const pages = [];
if (fs.existsSync(path.join(SRC, 'index.html'))) pages.push('index.html');
for (const d of fs.readdirSync(SRC, { withFileTypes: true })) {
  if (!d.isDirectory() || d.name.startsWith('.') || SKIP.has(d.name)) continue;
  const rel = path.join(d.name, 'index.html');
  if (fs.existsSync(path.join(SRC, rel))) pages.push(rel);
}
if (!pages.length) throw new Error('No pages found in ' + SRC);

for (const rel of pages) {
  const html = fs.readFileSync(path.join(SRC, rel));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(html), cipher.final(), cipher.getAuthTag()]);
  const payload = JSON.stringify({ v: 1, salt: cfg.salt, iter: cfg.iterations, iv: iv.toString('base64'), ct: ct.toString('base64') });
  const out = template.replace('__PAYLOAD__', () => payload);
  fs.mkdirSync(path.dirname(path.join(DEST, rel)), { recursive: true });
  fs.writeFileSync(path.join(DEST, rel), out);
  console.log(`locked ${rel}  (${(html.length / 1024).toFixed(0)} KB -> ${(out.length / 1024).toFixed(0)} KB)`);
}
