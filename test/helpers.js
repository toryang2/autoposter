import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '../src/config.js';
import { openDb, nowIso } from '../src/db.js';

export function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autoposter-test-'));
  const p = paths(home);
  const db = openDb(p.db);
  // Most tests run as if Setup's test automation already passed; the readiness tests clear it.
  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('setup_verified_at', ?)").run(nowIso());
  return { home, p, db };
}

export function addDestination(db, { name = 'Dest', type = 'page', url, audience = 'default', enabled = 1 } = {}) {
  url ??= `https://www.facebook.com/${name.replace(/\W/g, '')}${Math.random().toString(36).slice(2, 7)}`;
  return db.prepare(`INSERT INTO destinations(name, type, url, audience, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *`)
    .get(name, type, url, audience, enabled, nowIso());
}

export function addJob(db, destinationId, scheduledAt, body = 'Hello') {
  const post = db.prepare('INSERT INTO posts(body, created_at) VALUES (?, ?) RETURNING id').get(body, nowIso());
  return db.prepare('INSERT INTO jobs(post_id, destination_id, scheduled_at) VALUES (?, ?, ?) RETURNING *')
    .get(post.id, destinationId, scheduledAt.toISOString());
}

export const FAKE_CLAUDE = fileURLToPath(new URL(process.platform === 'win32' ? './fake-claude.cmd' : './fake-claude.cjs', import.meta.url));
