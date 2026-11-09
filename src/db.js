import { DatabaseSync } from 'node:sqlite';

export const PLATFORM_IDS = ['facebook', 'reddit', 'linkedin', 'tiktok', 'x', 'threads', 'instagram'];
const PLATFORM_CHECK = `CHECK(platform IN(${PLATFORM_IDS.map((p) => `'${p}'`).join(',')}))`;

// 'awaiting_join': Claude asked to join the group and Facebook is waiting for an admin to accept.
// The worker checks again every join_recheck_hours and posts once the account is in.
// 'needs_login': the account's login inside Autoposter expired; the job waits and goes back to 'queued' on the next log in.
const JOB_STATUSES = ['queued', 'running', 'submitted', 'pending_approval', 'awaiting_join', 'failed', 'cancelled', 'needs_check',
  'needs_login'];
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
  post_as TEXT,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL
);
`;

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
CREATE TABLE IF NOT EXISTS accounts(
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL DEFAULT 'facebook' ${PLATFORM_CHECK},
  name TEXT NOT NULL,
  profile_url TEXT NOT NULL UNIQUE,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`;
// Login inside the desktop app, per account: 'none' (never logged in there: posts go through Chrome),
// 'connected', or 'needs_login' (the saved login stopped working).
const ACCOUNT_LOGIN_COLUMNS = {
  login_state: "TEXT NOT NULL DEFAULT 'none'",
  login_checked_at: 'TEXT',
};

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
  // Set by Setup's test automation when it passes, with the Claude account it ran on. Until then the worker
  // holds scheduled posts; "Post now" still works because the person asked for it.
  setup_verified_at: '',
  setup_verified_account: '',
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
  // Databases created before 'needs_login' (and one job per account) have the old status CHECK and UNIQUE rule,
  // which SQLite cannot alter: rebuild the table with the same rows.
  const jobsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get()?.sql ?? '';
  if (!jobsSql.includes('needs_login')) {
    db.exec('PRAGMA foreign_keys = OFF');
    tx(db, () => {
      db.exec(jobsTable('jobs_new'));
      const newCols = new Set(db.prepare('PRAGMA table_info(jobs_new)').all().map((c) => c.name));
      const cols = db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name).filter((c) => newCols.has(c)).join(', ');
      db.exec(`INSERT INTO jobs_new(${cols}) SELECT ${cols} FROM jobs`);
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
  // Which of the person's accounts posts this job. NULL: that platform's default account (Accounts page).
  if (!db.prepare('PRAGMA table_info(jobs)').all().some((c) => c.name === 'account_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL');
  }
  // A post goes to a destination at most once per account and identity (the account itself, or one of its Pages).
  const once = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'jobs_once'").get()?.sql ?? '';
  if (!once.includes('post_as')) {
    db.exec('DROP INDEX IF EXISTS jobs_once');
    db.exec("CREATE UNIQUE INDEX jobs_once ON jobs(post_id, destination_id, COALESCE(account_id, 0), COALESCE(post_as, ''))");
  }
  // The Facebook Pages each account manages. A Page has no login of its own: the account switches into it to post.
  db.exec(`CREATE TABLE IF NOT EXISTS account_pages(
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    fb_page_id TEXT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(account_id, url)
  )`);
  if (!db.prepare('PRAGMA table_info(accounts)').all().some((c) => c.name === 'pages_checked_at')) {
    db.exec('ALTER TABLE accounts ADD COLUMN pages_checked_at TEXT');
  }
  // Posts waiting for group admins are looked at again later: how many looks so far, and when the next one is due.
  const jobCols = db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
  if (!jobCols.includes('approval_checks')) db.exec('ALTER TABLE jobs ADD COLUMN approval_checks INTEGER NOT NULL DEFAULT 0');
  if (!jobCols.includes('next_check_at')) {
    db.exec('ALTER TABLE jobs ADD COLUMN next_check_at TEXT');
    // Posts already waiting from the last few days get their first look soon.
    db.prepare(`UPDATE jobs SET next_check_at = ? WHERE status = 'pending_approval' AND finished_at >= ?`)
      .run(nowIso(), nowIso(new Date(Date.now() - 3 * 86_400_000)));
  }
  const accountCols = db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name);
  for (const [col, def] of Object.entries(ACCOUNT_LOGIN_COLUMNS)) {
    if (!accountCols.includes(col)) db.exec(`ALTER TABLE accounts ADD COLUMN ${col} ${def}`);
  }
  // The old single "Facebook account" setting becomes the default Facebook account.
  const legacy = db.prepare("SELECT value FROM settings WHERE key = 'fb_account_url'").get()?.value?.trim();
  if (legacy && !db.prepare("SELECT 1 FROM accounts WHERE platform = 'facebook'").get()) {
    db.prepare("INSERT OR IGNORE INTO accounts(platform, name, profile_url, is_default, created_at) VALUES ('facebook', 'My Facebook', ?, 1, ?)")
      .run(legacy, nowIso());
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

// The account that posts a job: the one picked in Compose, else that platform's default account.
export const ACCOUNT_OF_JOB = `COALESCE(j.account_id, (SELECT x.id FROM accounts x WHERE x.platform = d.platform AND x.is_default = 1 LIMIT 1))`;

export function getJob(db, id) {
  return db.prepare(`
    SELECT j.*, d.name AS destination_name, d.type AS destination_type, d.url AS destination_url, d.platform AS destination_platform, d.post_as AS destination_post_as,
           d.audience AS destination_audience, d.enabled AS destination_enabled, p.body AS post_body, p.first_comment,
           a.id AS account_ref, a.name AS account_name, a.profile_url AS account_url, a.platform AS account_platform,
           a.login_state AS account_login_state
    FROM jobs j JOIN destinations d ON d.id = j.destination_id JOIN posts p ON p.id = j.post_id
    LEFT JOIN accounts a ON a.id = ${ACCOUNT_OF_JOB}
    WHERE j.id = ?`).get(id);
}

export function getPostMedia(db, postId) {
  return db.prepare('SELECT * FROM post_media WHERE post_id = ? ORDER BY id').all(postId);
}

/**
 * Records an account's login state inside the app. Logging in (again) puts that account's "Needs login" posts back
 * in the queue; normal pacing then spaces them out.
 */
export function setAccountLogin(db, accountId, state, now = new Date()) {
  return tx(db, () => {
    db.prepare('UPDATE accounts SET login_state = ?, login_checked_at = ? WHERE id = ?').run(state, nowIso(now), accountId);
    if (state !== 'connected') return 0;
    return Number(db.prepare(`UPDATE jobs AS j SET status = 'queued', last_error = NULL
      WHERE j.status = 'needs_login' AND (SELECT ${ACCOUNT_OF_JOB} FROM destinations d WHERE d.id = j.destination_id) = ?`)
      .run(accountId).changes);
  });
}

/**
 * Saves the Pages an account manages, as read from Facebook's "Pages you manage" list. Pages no longer listed go away.
 * pages: [{ fb_page_id, name, url }]
 */
export function savePages(db, accountId, pages, now = new Date()) {
  tx(db, () => {
    const keep = [];
    const upsert = db.prepare(`INSERT INTO account_pages(account_id, fb_page_id, name, url, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, url) DO UPDATE SET fb_page_id = excluded.fb_page_id, name = excluded.name, updated_at = excluded.updated_at
      RETURNING id`);
    for (const pg of pages) {
      keep.push(upsert.get(accountId, pg.fb_page_id ?? null, pg.name, pg.url, nowIso(now)).id);
      // A Page that was added as a profile (e.g. as an account) is a Page.
      db.prepare("UPDATE destinations SET type = 'page' WHERE type = 'profile' AND url = ?").run(pg.url);
    }
    db.prepare(`DELETE FROM account_pages WHERE account_id = ? AND id NOT IN (${keep.map(() => '?').join(',') || 'NULL'})`).run(accountId, ...keep);
    db.prepare('UPDATE accounts SET pages_checked_at = ? WHERE id = ?').run(nowIso(now), accountId);
  });
}
