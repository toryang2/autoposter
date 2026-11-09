// Code-update bundles: the app's code (src/, web/dist/, package.json, production node_modules) as one signed file.
// Format: gzip(JSON { format, version, minShell, files: { "relative/path": base64 } }), signed with Ed25519.
// The desktop shell (electron/) is not in it; shell changes still ship as a new installer.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const BUNDLE_FORMAT = 1;
export const MAX_BUNDLE_BYTES = 60 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;

export function packBundle({ version, minShell, files }, privateKeyPem) {
  const manifest = { format: BUNDLE_FORMAT, version, minShell, files: {} };
  for (const [rel, data] of Object.entries(files)) manifest.files[rel] = Buffer.from(data).toString('base64');
  const bytes = zlib.gzipSync(Buffer.from(JSON.stringify(manifest)), { level: 9 });
  const sig = crypto.sign(null, bytes, crypto.createPrivateKey(privateKeyPem)).toString('base64');
  return { bytes, sig };
}

export function verifyBundle(bytes, sig, publicKeyPem) {
  try { return crypto.verify(null, bytes, crypto.createPublicKey(publicKeyPem), Buffer.from(String(sig), 'base64')); } catch { return false; }
}

// A path inside the bundle must stay inside the folder it is unpacked into.
export function safeRelPath(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.includes('\\')) return false;
  if (path.posix.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return false;
  const norm = path.posix.normalize(rel);
  return norm === rel && !norm.split('/').some((s) => s === '..' || s === '.' || s === '');
}

// Call only after verifyBundle. Throws on anything unexpected.
export function unpackBundle(bytes) {
  const json = zlib.gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED_BYTES });
  const m = JSON.parse(json.toString('utf8'));
  if (m?.format !== BUNDLE_FORMAT || typeof m.version !== 'string' || !m.files || typeof m.files !== 'object') {
    throw new Error('Unknown update format');
  }
  for (const rel of Object.keys(m.files)) if (!safeRelPath(rel)) throw new Error(`Bad path in update: ${rel}`);
  if (!m.files['src/server.js'] || !m.files['package.json']) throw new Error('Update is missing app files');
  return m;
}

export function writeBundle(manifest, dir) {
  for (const [rel, b64] of Object.entries(manifest.files)) {
    const dest = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
  }
}
