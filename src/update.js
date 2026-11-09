// Updates for the desktop app. latest.json on GitHub names the newest version. If it carries a signed code bundle the
// installed app can run, "Update now" downloads it, checks the signature, unpacks it next to the app's data and
// restarts. Otherwise the dashboard shows links to download the new installer from wherever the person bought it.
// Any network or format problem means "no update".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBundle, unpackBundle, writeBundle, MAX_BUNDLE_BYTES } from './bundle.js';
import { UPDATE_PUBLIC_KEY } from './update-key.js';

export const UPDATE_FEED = process.env.AUTOPOSTER_UPDATE_URL
  || 'https://raw.githubusercontent.com/raketbizdev/autoposter/main/latest.json';
const CACHE_MS = 6 * 60 * 60 * 1000;

export const APP_VERSION = JSON.parse(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;

// Set by the desktop app (electron/main.js). Without them, code updates are off.
const env = () => ({ updatesDir: process.env.AUTOPOSTER_UPDATES_DIR || '', shell: process.env.AUTOPOSTER_SHELL_VERSION || '' });

// 1 if a is newer than b, -1 if older, 0 if the same. Ignores anything after "-" (pre-release tags).
export function compareVersions(a, b) {
  const parts = (v) => String(v).trim().replace(/^v/, '').split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

const VERSION_RE = /^v?\d+(\.\d+)*/;
const isHttps = (u) => { try { return new URL(u).protocol === 'https:'; } catch { return false; } };

// The installed app can take this code bundle without a reinstall.
function bundleFits(feed, { shell, updatesDir }) {
  const b = feed.bundle;
  if (!updatesDir || !shell || !b || typeof b !== 'object') return false;
  if (!isHttps(b.url) || typeof b.sig !== 'string' || !b.sig) return false;
  if (b.minShell !== undefined && (typeof b.minShell !== 'string' || !VERSION_RE.test(b.minShell))) return false;
  return compareVersions(b.minShell || feed.version, shell) <= 0;
}

// Turns the feed into what the dashboard shows. Only https links with a label get through.
export function parseFeed(feed, current = APP_VERSION, opts = env()) {
  const none = { current, available: false };
  if (!feed || typeof feed !== 'object' || typeof feed.version !== 'string' || !VERSION_RE.test(feed.version)) return none;
  const links = (Array.isArray(feed.links) ? feed.links : [])
    .filter((l) => l && typeof l.label === 'string' && l.label.trim() && isHttps(l.url))
    .slice(0, 4)
    .map((l) => ({ label: l.label.trim().slice(0, 40), url: l.url }));
  const auto = bundleFits(feed, opts);
  if (!links.length && !auto) return none;
  return {
    current,
    latest: feed.version,
    available: compareVersions(feed.version, current) > 0,
    auto,
    notes: typeof feed.notes === 'string' ? feed.notes.slice(0, 500) : '',
    links,
  };
}

let cache = null; // { at, current, feed, result }

export async function checkForUpdate({ current = APP_VERSION, feedUrl = UPDATE_FEED, fetchImpl = fetch, now = Date.now(), opts = env() } = {}) {
  if (cache && now - cache.at < CACHE_MS && cache.current === current) return cache.result;
  let feed = null;
  try {
    const res = await fetchImpl(feedUrl, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
    if (res.ok) feed = await res.json();
  } catch { /* offline or blocked: no update */ }
  const result = feed ? parseFeed(feed, current, opts) : { current, available: false };
  cache = { at: now, current, feed, result };
  return result;
}

export function clearUpdateCache() { cache = null; }

async function download(url, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_BUNDLE_BYTES) throw new Error('Update is too large');
  return bytes;
}

export function readCurrent(updatesDir) {
  try { return JSON.parse(fs.readFileSync(path.join(updatesDir, 'current.json'), 'utf8')); } catch { return null; }
}

export function writeCurrent(updatesDir, data) {
  const file = path.join(updatesDir, 'current.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
  fs.renameSync(`${file}.tmp`, file);
}

let installing = null;

// Downloads, verifies and unpacks the bundle from the latest feed. The new code runs after a restart.
export function installUpdate(options = {}) {
  installing ??= doInstall(options).finally(() => { installing = null; });
  return installing;
}

async function doInstall({ current = APP_VERSION, fetchImpl = fetch, publicKey = UPDATE_PUBLIC_KEY, opts = env(), ...rest } = {}) {
  if (!opts.updatesDir || !publicKey) throw new Error('Updates are not available in this version');
  if (!cache?.feed || cache.current !== current) await checkForUpdate({ current, fetchImpl, opts, ...rest });
  const feed = cache?.feed;
  const info = feed && parseFeed(feed, current, opts);
  if (!info?.available) throw new Error('You already have the latest version');
  if (!info.auto) throw new Error('This update needs the new installer');
  const prev = readCurrent(opts.updatesDir);
  if (prev?.version === feed.version && prev.state === 'bad') {
    throw new Error('This update did not start on this computer last time. Download the new installer instead');
  }

  const bytes = await download(feed.bundle.url, fetchImpl);
  if (!verifyBundle(bytes, feed.bundle.sig, publicKey)) throw new Error('The update failed its safety check, so it was not installed');
  const m = unpackBundle(bytes);
  if (m.version !== feed.version || compareVersions(m.version, current) <= 0) throw new Error('The update does not match the expected version');
  if (compareVersions(m.minShell || m.version, opts.shell) > 0) throw new Error('This update needs the new installer');

  const dir = path.join(opts.updatesDir, m.version);
  const tmp = `${dir}.partial`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  writeBundle(m, tmp);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  const previous = prev;
  writeCurrent(opts.updatesDir, { version: m.version, state: 'new' });
  // Keep only the new version and the one running now.
  for (const name of fs.readdirSync(opts.updatesDir)) {
    if (name === 'current.json' || name === m.version || name === previous?.version) continue;
    fs.rmSync(path.join(opts.updatesDir, name), { recursive: true, force: true });
  }
  return { installed: m.version };
}

let restartHandler = null;
export function setRestartHandler(fn) { restartHandler = fn; }
export function canRestart() { return Boolean(restartHandler); }
export function restartApp() { restartHandler?.(); }
