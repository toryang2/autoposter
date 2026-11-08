import { DatabaseSync } from 'node:sqlite';

export const PLATFORM_IDS = ['facebook', 'reddit', 'linkedin', 'tiktok', 'x', 'threads', 'instagram'];
const PLATFORM_CHECK = `CHECK(platform IN(${PLATFORM_IDS.map((p) => `'${p}'`).join(',')}))`;

// 'awaiting_join': Claude asked to join the group and Facebook is waiting for an admin to accept.
// The worker checks again every join_recheck_hours and posts once the account is in.
const JOB_STATUSES = ['queued', 'running', 'submitted', 'pending_approval', 'awaiting_join', 'failed', 'cancelled', 'needs_check'];
const jobsTable = (name) => `CREATE TABLE IF NOT EXISTS ${name}(
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  destination_id INTEGER NOT NULL REFERENCES destinations(id),
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN(${JOB_STATUSES.map((x) => `'${x}'`).join(',')})),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  result_json TEXT,
  post_url TEXT,
  started_at TEXT,
  finished_at TEXT,
  join_requested_at TEXT,
  force_now INTEGER NOT NULL DEFAULT 0,
  UNIQUE(post_id, destination_id)
);
`;
const JOB_COLUMNS = 'id, post_id, destination_id, scheduled_at, status, attempts, last_error, result_json, post_url, started_at, finished_at';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS destinations(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'facebook' ${PLATFORM_CHECK},
  type TEXT NOT NULL CHECK(type IN('profile','page','group')),
  url TEXT NOT NULL UNIQUE,
  audience TEXT NOT NULL DEFAULT 'default' CHECK(audience IN('default','public','friends','only_me')),
  enabled INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS posts(
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS post_media(
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN('image','video')),
  size_bytes INTEGER NOT NULL
);
${jobsTable('jobs')}CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, scheduled_at);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export const DEFAULT_SETTINGS = {
  daily_cap: '10',
  group_gap_minutes: '20',
  max_attempts: '2',
  model: 'sonnet',
  job_timeout_min: '15',
  paused_until: '',
  join_recheck_hours: '6',
  join_wait_days: '14',
  join_about: "I'm interested in what this group discusses and want to follow and take part in the conversations here.",
  // The facebook.com/me URL of the only account allowed to post, for when several Chrome browsers are connected.
  // Empty: post from whichever connected browser is signed in to Facebook.
  fb_account_url: '',
  // '1' after the worker is started from the dashboard, '0' after it is stopped: the desktop app restores it on launch.
  worker_autostart: '0',
};

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // Databases created before multi-platform support get the column; existing rows become 'facebook'.
  const cols = db.prepare('PRAGMA table_info(destinations)').all().map((c) => c.name);
  if (!cols.includes('platform')) {
    db.exec(`ALTER TABLE destinations ADD COLUMN platform TEXT NOT NULL DEFAULT 'facebook' ${PLATFORM_CHECK}`);
  }
  // Databases created before 'awaiting_join' have the old status CHECK, which SQLite cannot alter:
  // rebuild the table with the same rows.
  const jobsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get()?.sql ?? '';
  if (!jobsSql.includes('awaiting_join')) {
    db.exec('PRAGMA foreign_keys = OFF');
    tx(db, () => {
      db.exec(jobsTable('jobs_new'));
      db.exec(`INSERT INTO jobs_new(${JOB_COLUMNS}) SELECT ${JOB_COLUMNS} FROM jobs`);
      db.exec('DROP TABLE jobs');
      db.exec('ALTER TABLE jobs_new RENAME TO jobs');
      db.exec('CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, scheduled_at)');
    });
    db.exec('PRAGMA foreign_keys = ON');
  }
  // Facebook groups can be posted to as one of the owner's Pages instead of their profile. NULL: as themselves.
  if (!db.prepare('PRAGMA table_info(destinations)').all().some((c) => c.name === 'post_as')) {
    db.exec('ALTER TABLE destinations ADD COLUMN post_as TEXT');
  }
  // Who posts this one job in a Facebook group, chosen in Compose. NULL: the group's own "Post as" setting.
  // '@self': the person's own profile. Anything else: the name of one of their Pages.
  if (!db.prepare('PRAGMA table_info(jobs)').all().some((c) => c.name === 'post_as')) {
    db.exec('ALTER TABLE jobs ADD COLUMN post_as TEXT');
  }
  // Optional first comment, added by Claude right after the post is live (links go here: many groups ban links in posts).
  if (!db.prepare('PRAGMA table_info(posts)').all().some((c) => c.name === 'first_comment')) {
    db.exec('ALTER TABLE posts ADD COLUMN first_comment TEXT');
  }
  // "Post now" flag: the next worker pass runs this job first, ignoring the group gap, daily cap and usage pause.
  if (!db.prepare('PRAGMA table_info(jobs)').all().some((c) => c.name === 'force_now')) {
    db.exec('ALTER TABLE jobs ADD COLUMN force_now INTEGER NOT NULL DEFAULT 0');
  }
  const insert = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v);
  return db;
}

export function getSettings(db) {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function nowIso(date = new Date()) {
  return date.toISOString();
}

// Wraps fn in BEGIN IMMEDIATE so concurrent writers serialize.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getJob(db, id) {
  return db.prepare(`
    SELECT j.*, d.name AS destination_name, d.type AS destination_type, d.url AS destination_url, d.platform AS destination_platform, d.post_as AS destination_post_as,
           d.audience AS destination_audience, d.enabled AS destination_enabled, p.body AS post_body, p.first_comment
    FROM jobs j JOIN destinations d ON d.id = j.destination_id JOIN posts p ON p.id = j.post_id
    WHERE j.id = ?`).get(id);
}

export function getPostMedia(db, postId) {
  return db.prepare('SELECT * FROM post_media WHERE post_id = ? ORDER BY id').all(postId);
}
