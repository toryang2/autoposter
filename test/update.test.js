import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareVersions, parseFeed, checkForUpdate, clearUpdateCache, installUpdate, readCurrent, writeCurrent, APP_VERSION } from '../src/update.js';
import { packBundle, unpackBundle, verifyBundle, safeRelPath } from '../src/bundle.js';

const LINKS = [{ label: 'Download from Gumroad', url: 'https://app.gumroad.com/library' }];
const fakeFetch = (body, { ok = true, calls = [] } = {}) => async (url) => { calls.push(url); return { ok, json: async () => body }; };

beforeEach(clearUpdateCache);

test('compareVersions', () => {
  assert.equal(compareVersions('1.1.0', '1.0.0'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('v2.0.0', '10.0.0'), -1);
  assert.equal(compareVersions('1.2.0-beta', '1.2.0'), 0);
});

test('parseFeed: newer version with links is available, bad input is not', () => {
  const r = parseFeed({ version: '1.1.0', notes: 'Faster posting', links: LINKS }, '1.0.0');
  assert.deepEqual(r, { current: '1.0.0', latest: '1.1.0', available: true, auto: false, notes: 'Faster posting', links: LINKS });
  assert.equal(parseFeed({ version: '1.0.0', links: LINKS }, '1.0.0').available, false);
  assert.equal(parseFeed({ version: '0.9.0', links: LINKS }, '1.0.0').available, false);
  assert.equal(parseFeed({ version: '1.1.0', links: [] }, '1.0.0').available, false);
  assert.equal(parseFeed({ version: '1.1.0', links: [{ label: 'x', url: 'javascript:alert(1)' }] }, '1.0.0').available, false);
  assert.equal(parseFeed({ version: '1.1.0', links: [{ label: 'x', url: 'http://insecure.example' }] }, '1.0.0').available, false);
  assert.equal(parseFeed({ version: 'latest', links: LINKS }, '1.0.0').available, false);
  assert.equal(parseFeed(null, '1.0.0').available, false);
});

test('checkForUpdate: caches, and network or HTTP errors mean no update', async () => {
  const calls = [];
  const f = fakeFetch({ version: '9.0.0', links: LINKS }, { calls });
  assert.equal((await checkForUpdate({ current: '1.0.0', fetchImpl: f, now: 0 })).available, true);
  await checkForUpdate({ current: '1.0.0', fetchImpl: f, now: 1000 });
  assert.equal(calls.length, 1);
  clearUpdateCache();
  assert.equal((await checkForUpdate({ current: '1.0.0', fetchImpl: fakeFetch({}, { ok: false }) })).available, false);
  clearUpdateCache();
  const boom = async () => { throw new Error('offline'); };
  assert.deepEqual(await checkForUpdate({ current: '1.0.0', fetchImpl: boom }), { current: '1.0.0', available: false });
});

test('APP_VERSION comes from package.json', () => {
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+/);
});

// ---- code updates
const keys = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'pem' }), priv: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
};
const APP_FILES = { 'src/server.js': 'export const v = 2;', 'package.json': '{"version":"1.2.0"}', 'web/dist/index.html': '<p>hi' };
const BUNDLE_URL = 'https://github.com/raketbizdev/autoposter/releases/download/v1.2.0/autoposter-1.2.0.bundle';

function fakeServer({ feed, bytes }) {
  return async (url) => {
    if (url === BUNDLE_URL) return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
    return { ok: true, json: async () => feed };
  };
}

function scenario({ files = APP_FILES, version = '1.2.0', minShell = '1.1.0', signWith, feedVersion = version } = {}) {
  const k = keys();
  const { bytes, sig } = packBundle({ version, minShell, files }, signWith || k.priv);
  const feed = { version: feedVersion, links: LINKS, bundle: { url: BUNDLE_URL, sig, minShell } };
  const updatesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoposter-upd-'));
  const opts = { updatesDir, shell: '1.1.0' };
  return { k, bytes, sig, feed, opts, updatesDir, fetchImpl: fakeServer({ feed, bytes }) };
}

test('bundle: signature check, round trip and path safety', () => {
  const k = keys();
  const { bytes, sig } = packBundle({ version: '1.2.0', minShell: '1.1.0', files: APP_FILES }, k.priv);
  assert.equal(verifyBundle(bytes, sig, k.pub), true);
  assert.equal(verifyBundle(bytes, sig, keys().pub), false);
  const tampered = Buffer.from(bytes); tampered[20] ^= 1;
  assert.equal(verifyBundle(tampered, sig, k.pub), false);
  assert.equal(Buffer.from(unpackBundle(bytes).files['src/server.js'], 'base64').toString(), 'export const v = 2;');
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'a\\b', 'a//b', './a', '']) assert.equal(safeRelPath(bad), false, bad);
  assert.equal(safeRelPath('node_modules/express/index.js'), true);
  const evil = packBundle({ version: '1.2.0', files: { ...APP_FILES, '../evil.js': 'x' } }, k.priv);
  assert.throws(() => unpackBundle(evil.bytes), /Bad path/);
});

test('parseFeed: auto only when the shell is new enough and updates are on', () => {
  const { feed } = scenario();
  assert.equal(parseFeed(feed, '1.1.0', { updatesDir: '/x', shell: '1.1.0' }).auto, true);
  assert.equal(parseFeed(feed, '1.0.0', { updatesDir: '/x', shell: '1.0.0' }).auto, false);
  assert.equal(parseFeed(feed, '1.1.0', { updatesDir: '', shell: '1.1.0' }).auto, false);
  assert.equal(parseFeed({ ...feed, bundle: { ...feed.bundle, url: 'http://x/y' } }, '1.1.0', { updatesDir: '/x', shell: '1.1.0' }).auto, false);
});

test('installUpdate: unpacks a signed bundle and marks it new', async () => {
  const s = scenario();
  const r = await installUpdate({ current: '1.1.0', fetchImpl: s.fetchImpl, publicKey: s.k.pub, opts: s.opts, now: 0 });
  assert.deepEqual(r, { installed: '1.2.0' });
  assert.equal(fs.readFileSync(path.join(s.updatesDir, '1.2.0', 'src', 'server.js'), 'utf8'), 'export const v = 2;');
  assert.deepEqual(readCurrent(s.updatesDir), { version: '1.2.0', state: 'new' });
  assert.equal(fs.existsSync(path.join(s.updatesDir, '1.2.0.partial')), false);
});

test('installUpdate: refuses a wrong signature, a version mismatch, an old shell and a bundle that failed before', async () => {
  const wrongKey = scenario({ signWith: keys().priv });
  await assert.rejects(installUpdate({ current: '1.1.0', fetchImpl: wrongKey.fetchImpl, publicKey: wrongKey.k.pub, opts: wrongKey.opts, now: 0 }), /safety check/);
  assert.deepEqual(fs.readdirSync(wrongKey.updatesDir), []);

  clearUpdateCache();
  const mismatch = scenario({ version: '1.1.5', feedVersion: '1.2.0' });
  await assert.rejects(installUpdate({ current: '1.1.0', fetchImpl: mismatch.fetchImpl, publicKey: mismatch.k.pub, opts: mismatch.opts, now: 0 }), /expected version/);

  clearUpdateCache();
  const oldShell = scenario({ minShell: '1.2.0' });
  await assert.rejects(installUpdate({ current: '1.1.0', fetchImpl: oldShell.fetchImpl, publicKey: oldShell.k.pub, opts: oldShell.opts, now: 0 }), /new installer/);

  clearUpdateCache();
  const failed = scenario();
  writeCurrent(failed.updatesDir, { version: '1.2.0', state: 'bad' });
  await assert.rejects(installUpdate({ current: '1.1.0', fetchImpl: failed.fetchImpl, publicKey: failed.k.pub, opts: failed.opts, now: 0 }), /did not start/);

  clearUpdateCache();
  const latest = scenario();
  await assert.rejects(installUpdate({ current: '1.2.0', fetchImpl: latest.fetchImpl, publicKey: latest.k.pub, opts: latest.opts, now: 0 }), /latest version/);
});
