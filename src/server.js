import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import os from 'node:os';
import { spawnNodeScript, findClaude, claudeAuthStatus, openTerminal, CLAUDE_INSTALL_COMMAND, claudeLoginCommand, IN_ELECTRON, findClaudeExtension } from './platform.js';
import { testChromeConnection } from './runner.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths as getPaths, PORT, HOST, LIMITS } from './config.js';
import { openDb, getSettings, setSetting, nowIso, tx, DEFAULT_SETTINGS } from './db.js';
import { PLATFORMS, isPlatformUrl, mediaProblem } from './platforms.js';
import { postedToday } from './worker.js';
import { cleanPostUrl } from './runner.js';

const AUDIENCES = new Set(['default', 'public', 'friends', 'only_me']);

// "Post as": empty means the person's own profile; otherwise the name of one of their Facebook Pages. Groups only.
function postAsValue(platform, type, value) {
  const name = String(value ?? '').trim();
  if (!name) return null;
  if (platform !== 'facebook' || type !== 'group') throw new HttpError(400, 'Posting as a Page is only for Facebook groups');
  if (name.length > 100) throw new HttpError(400, 'The Page name is too long');
  return name;
}
const NUMERIC_SETTINGS = { daily_cap: [1, 200], group_gap_minutes: [0, 1440], max_attempts: [1, 5], job_timeout_min: [3, 60],
  join_recheck_hours: [1, 48], join_wait_days: [1, 60] };
const MODELS = new Set(['sonnet', 'opus', 'haiku']);
const PAID_PLANS = new Set(['pro', 'max', 'team', 'enterprise']);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function safeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80) || 'file';
}

function mediaKind(mimetype) {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  return null;
}

export function workerPid(lockFile) {
  try {
    const pid = Number(fs.readFileSync(lockFile, 'utf8'));
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function workerAlive(lockFile) {
  return workerPid(lockFile) !== null;
}

const LAUNCHD_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.autoposter.worker.plist');

// Starts the worker as its own detached process, so it outlives a dashboard restart.
export function startWorker(p, args = []) {
  spawnNodeScript(path.join(p.root, 'src', 'worker.js'), args,
    { cwd: p.root, logFile: path.join(p.logs, 'worker.log'), env: { AUTOPOSTER_HOME: p.home } });
}

async function waitFor(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return check();
}

const JOB_SELECT = `SELECT j.id, j.post_id, j.destination_id, j.scheduled_at, j.status, j.attempts, j.last_error,
  j.post_url, j.started_at, j.finished_at, j.force_now, j.post_as, d.name AS destination_name, d.type AS destination_type, d.url AS destination_url,
  d.platform AS destination_platform, d.post_as AS destination_post_as, d.archived AS destination_archived, p.body AS post_body, p.first_comment FROM jobs j JOIN destinations d ON d.id = j.destination_id JOIN posts p ON p.id = j.post_id`;

export function createApp(db, p) {
  const app = express();
  app.use(express.json());

  const upload = multer({
    dest: path.join(p.media, 'tmp'),
    limits: { fileSize: LIMITS.maxFileBytes, files: LIMITS.maxFiles },
  });

  // ---- destinations
  app.get('/api/destinations', (req, res) => {
    res.json(db.prepare('SELECT * FROM destinations WHERE archived = 0 ORDER BY type, name').all());
  });

  app.post('/api/destinations', (req, res) => {
    const { name, platform = 'facebook', type, url, audience = 'default', post_as: postAsRaw } = req.body ?? {};
    const pf = PLATFORMS[platform];
    if (!name?.trim()) throw new HttpError(400, 'Name is required');
    if (!pf) throw new HttpError(400, 'Unknown platform');
    if (!pf.types.includes(type)) throw new HttpError(400, `${pf.label} destinations can be: ${pf.types.join(', ')}`);
    if (!isPlatformUrl(platform, url)) throw new HttpError(400, `URL must be an https://${pf.hosts[0]} link`);
    if (!AUDIENCES.has(audience)) throw new HttpError(400, 'Invalid audience');
    const keepAudience = platform === 'facebook' && type === 'profile';
    const postAs = postAsValue(platform, type, postAsRaw);
    const existing = db.prepare('SELECT id, archived FROM destinations WHERE url = ?').get(url);
    if (existing && !existing.archived) throw new HttpError(409, 'That destination already exists');
    if (existing) {
      db.prepare('UPDATE destinations SET name = ?, platform = ?, type = ?, audience = ?, post_as = ?, enabled = 1, archived = 0 WHERE id = ?')
        .run(name.trim(), platform, type, keepAudience ? audience : 'default', postAs, existing.id);
      return res.status(201).json(db.prepare('SELECT * FROM destinations WHERE id = ?').get(existing.id));
    }
    const row = db.prepare(`INSERT INTO destinations(name, platform, type, url, audience, post_as, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING *`).get(name.trim(), platform, type, url, keepAudience ? audience : 'default', postAs, nowIso());
    res.status(201).json(row);
  });

  app.patch('/api/destinations/:id', (req, res) => {
    const d = db.prepare('SELECT * FROM destinations WHERE id = ? AND archived = 0').get(req.params.id);
    if (!d) throw new HttpError(404, 'Destination not found');
    const { name = d.name, enabled = d.enabled, audience = d.audience } = req.body ?? {};
    if (!AUDIENCES.has(audience)) throw new HttpError(400, 'Invalid audience');
    const postAs = req.body && 'post_as' in req.body ? postAsValue(d.platform, d.type, req.body.post_as) : d.post_as;
    res.json(db.prepare('UPDATE destinations SET name = ?, enabled = ?, audience = ?, post_as = ? WHERE id = ? RETURNING *')
      .get(String(name).trim() || d.name, enabled ? 1 : 0, audience, postAs, d.id));
  });

  // Removing cancels queued jobs. Destinations with history are archived so the log stays intact.
  app.delete('/api/destinations/:id', (req, res) => {
    const id = Number(req.params.id);
    tx(db, () => {
      db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE destination_id = ? AND status IN ('queued','awaiting_join')")
        .run(nowIso(), id);
      const used = db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE destination_id = ?').get(id).n;
      if (used) db.prepare('UPDATE destinations SET archived = 1, enabled = 0 WHERE id = ?').run(id);
      else db.prepare('DELETE FROM destinations WHERE id = ?').run(id);
    });
    res.status(204).end();
  });

  // ---- posts
  app.post('/api/posts', upload.array('media', LIMITS.maxFiles), (req, res) => {
    const files = req.files ?? [];
    const cleanup = () => files.forEach((f) => fs.rmSync(f.path, { force: true }));
    try {
      const body = String(req.body.body ?? '');
      const firstComment = String(req.body.first_comment ?? '').trim() || null;
      if (firstComment && firstComment.length > 2000) throw new HttpError(400, 'The first comment must be 2000 characters or less');
      const whoRaw = String(req.body.post_as ?? '').trim();
      if (whoRaw.length > 100) throw new HttpError(400, 'The Page name is too long');
      const who = whoRaw || null; // null: each group's own setting; '@self': yourself; otherwise a Page name
      const scheduledAt = new Date(req.body.scheduled_at);
      const destinationIds = [].concat(req.body.destination_ids ?? []).map(Number).filter(Boolean);
      if (!body.trim() && !files.length) throw new HttpError(400, 'Write some text or attach media');
      if (Number.isNaN(scheduledAt.getTime())) throw new HttpError(400, 'Pick a valid date and time');
      if (!destinationIds.length) throw new HttpError(400, 'Pick at least one destination');
      const kinds = files.map((f) => mediaKind(f.mimetype));
      if (kinds.includes(null)) throw new HttpError(400, 'Only images and videos can be attached');
      if (kinds.filter((k) => k === 'video').length > 1) throw new HttpError(400, 'Only one video per post');
      if (kinds.includes('video') && kinds.includes('image')) throw new HttpError(400, 'Attach either images or one video, not both');
      const total = files.reduce((n, f) => n + f.size, 0);
      if (total > LIMITS.maxTotalBytes) throw new HttpError(400, 'Attachments must total 10 MB or less');
      const dests = destinationIds.map((id) => db.prepare('SELECT * FROM destinations WHERE id = ? AND archived = 0').get(id));
      if (dests.some((d) => !d)) throw new HttpError(400, 'Unknown destination');
      const unsupported = dests.find((d) => !PLATFORMS[d.platform]?.posting);
      if (unsupported) throw new HttpError(400, `Posting to ${PLATFORMS[unsupported.platform].label} isn't supported yet`);
      for (const d of dests) {
        const problem = mediaProblem(d.platform, kinds);
        if (problem) throw new HttpError(400, `${problem} (${d.name})`);
      }

      const postId = tx(db, () => {
        const post = db.prepare('INSERT INTO posts(body, first_comment, created_at) VALUES (?, ?, ?) RETURNING id').get(body, firstComment, nowIso());
        const dir = path.join(p.media, String(post.id));
        fs.mkdirSync(dir, { recursive: true });
        files.forEach((f, i) => {
          const target = path.join(dir, `${i + 1}-${safeName(f.originalname)}`);
          fs.renameSync(f.path, target);
          db.prepare('INSERT INTO post_media(post_id, path, kind, size_bytes) VALUES (?, ?, ?, ?)')
            .run(post.id, target, kinds[i], f.size);
        });
        const insertJob = db.prepare('INSERT INTO jobs(post_id, destination_id, scheduled_at, post_as) VALUES (?, ?, ?, ?)');
        // "Who" only changes who posts in Facebook groups; profiles, Pages and other platforms post as themselves.
        for (const d of dests) {
          insertJob.run(post.id, d.id, scheduledAt.toISOString(), d.platform === 'facebook' && d.type === 'group' ? who : null);
        }
        return post.id;
      });
      res.status(201).json({ id: postId, jobs: dests.length });
    } catch (err) {
      cleanup();
      throw err;
    }
  });

  app.get('/api/posts/:id/media', (req, res) => {
    const rows = db.prepare('SELECT id, kind, size_bytes, path FROM post_media WHERE post_id = ?').all(req.params.id);
    res.json(rows.map((m) => ({ ...m, url: `/media/${req.params.id}/${path.basename(m.path)}`, path: undefined })));
  });

  // ---- jobs
  // Optional filters: status, and from/to (ISO) on scheduled_at for the calendar.
  app.get('/api/jobs', (req, res) => {
    const where = [];
    const params = [];
    if (req.query.status) { where.push('j.status = ?'); params.push(req.query.status); }
    for (const [key, op] of [['from', '>='], ['to', '<']]) {
      if (!req.query[key]) continue;
      const d = new Date(req.query[key]);
      if (Number.isNaN(d.getTime())) throw new HttpError(400, `Invalid ${key} date`);
      where.push(`j.scheduled_at ${op} ?`);
      params.push(d.toISOString());
    }
    const rows = db.prepare(`${JOB_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY j.scheduled_at DESC LIMIT 2000`).all(...params);
    res.json(rows);
  });

  app.get('/api/jobs/:id/log', (req, res) => {
    const job = db.prepare('SELECT result_json FROM jobs WHERE id = ?').get(req.params.id);
    if (!job) throw new HttpError(404, 'Job not found');
    const raw = job.result_json ? JSON.parse(job.result_json) : null;
    res.json({ result: raw?.result ?? null, num_turns: raw?.num_turns ?? null, duration_ms: raw?.duration_ms ?? null });
  });

  // A removed destination is archived, and the worker never picks up its jobs: running one again would wait forever.
  const refuseRemovedDestination = (jobId) => {
    const row = db.prepare('SELECT d.archived FROM jobs j JOIN destinations d ON d.id = j.destination_id WHERE j.id = ?').get(jobId);
    if (row?.archived) throw new HttpError(409, 'This destination was removed. Add it again in Destinations to post there.');
  };

  const transition = (from, to, extra = '') => (req, res) => {
    const row = db.prepare(`UPDATE jobs SET status = ?${extra} WHERE id = ? AND status IN (${from.map(() => '?').join(',')})
      RETURNING id, status`).get(to, req.params.id, ...from);
    if (!row) throw new HttpError(409, `Job can only move to ${to} from: ${from.join(', ')}`);
    res.json(row);
  };

  app.post('/api/jobs/:id/cancel', transition(['queued', 'awaiting_join'], 'cancelled', ', force_now = 0'));
  // Retrying a needs_check job is the user's call: they confirmed on Facebook that nothing went out.
  app.post('/api/jobs/:id/retry', (req, res) => {
    refuseRemovedDestination(req.params.id);
    // From awaiting_join this is "check now": the original request date is kept so the wait limit still counts.
    const row = db.prepare(`UPDATE jobs SET status = 'queued', scheduled_at = ?, last_error = NULL, attempts = 0,
        join_requested_at = CASE WHEN status = 'awaiting_join' THEN join_requested_at ELSE NULL END
      WHERE id = ? AND status IN ('failed','needs_check','cancelled','awaiting_join') RETURNING id, status`).get(nowIso(), req.params.id);
    if (!row) throw new HttpError(409, 'Only failed, needs-check, cancelled or waiting-to-join jobs can be retried');
    res.json(row);
  });
  // Lets the user paste a post's link when Claude couldn't read it. An empty value clears it.
  app.post('/api/jobs/:id/link', (req, res) => {
    const raw = String(req.body?.url ?? '').trim();
    const url = raw ? cleanPostUrl(raw) : null;
    if (raw && !url) throw new HttpError(400, 'Paste the https:// link to the post');
    const row = db.prepare('UPDATE jobs SET post_url = ? WHERE id = ? RETURNING id, post_url').get(url, req.params.id);
    if (!row) throw new HttpError(404, 'Job not found');
    res.json(row);
  });
  // Manual override: post this job now, skipping its schedule, the group gap, the daily cap and any usage pause.
  app.post('/api/jobs/:id/post-now', (req, res) => {
    refuseRemovedDestination(req.params.id);
    const running = db.prepare("SELECT id FROM jobs WHERE status = 'running'").get();
    const pid = workerPid(p.lock);
    if (running && !pid) throw new HttpError(409, 'Another post is being published right now. Try again when it finishes.');
    const row = db.prepare(`UPDATE jobs SET force_now = 1, last_error = NULL WHERE id = ? AND status IN ('queued','awaiting_join')
      RETURNING id, status`).get(req.params.id);
    if (!row) throw new HttpError(409, 'Only queued or waiting-to-join posts can be posted now');
    // A running worker sees the flag within a few seconds, right after any post it is publishing now.
    if (!pid) startWorker(p, ['--post-now']);
    res.json({ ...row, via: pid ? 'worker' : 'one-off' });
  });
  // Clears a failed or cancelled job from the Queue. Posted and pending jobs stay as history.
  // When it was the post's last job, the post and its media files go too.
  app.delete('/api/jobs/:id', (req, res) => {
    const mediaDir = tx(db, () => {
      const job = db.prepare("DELETE FROM jobs WHERE id = ? AND status IN ('failed','cancelled') RETURNING post_id").get(req.params.id);
      if (!job) throw new HttpError(409, 'Only failed or cancelled posts can be removed');
      if (db.prepare('SELECT 1 FROM jobs WHERE post_id = ?').get(job.post_id)) return null;
      db.prepare('DELETE FROM post_media WHERE post_id = ?').run(job.post_id);
      db.prepare('DELETE FROM posts WHERE id = ?').run(job.post_id);
      return path.join(p.media, String(job.post_id));
    });
    if (mediaDir) fs.rmSync(mediaDir, { recursive: true, force: true });
    res.status(204).end();
  });
  app.post('/api/jobs/:id/mark-posted', transition(['needs_check'], 'submitted'));

  // ---- worker control
  app.post('/api/worker/start', async (req, res) => {
    if (workerAlive(p.lock)) throw new HttpError(409, 'The worker is already running');
    startWorker(p);
    setSetting(db, 'worker_autostart', '1');
    if (!(await waitFor(() => workerAlive(p.lock)))) {
      throw new HttpError(503, 'The worker did not start; see logs/worker.log');
    }
    res.json({ worker_running: true });
  });

  app.post('/api/worker/stop', async (req, res) => {
    if (!IN_ELECTRON && fs.existsSync(LAUNCHD_PLIST) && !process.env.AUTOPOSTER_HOME) {
      throw new HttpError(409, 'The worker is managed by launchd and would restart. Run bash scripts/uninstall-launchd.sh to stop it.');
    }
    const pid = workerPid(p.lock);
    if (!pid) throw new HttpError(409, 'The worker is not running');
    process.kill(pid, 'SIGTERM');
    setSetting(db, 'worker_autostart', '0');
    await waitFor(() => !workerAlive(p.lock));
    res.json({ worker_running: workerAlive(p.lock) });
  });

  // ---- first-run setup: Claude Code installed and logged in with a Claude subscription
  app.get('/api/setup', (req, res) => {
    const bin = findClaude();
    const auth = claudeAuthStatus(bin);
    res.json({
      platform: process.platform,
      app: IN_ELECTRON,
      claude_path: bin,
      claude_installed: Boolean(bin),
      logged_in: Boolean(auth?.loggedIn),
      // 'claude.ai' is the subscription login; anything else would bill API usage.
      subscription: auth?.authMethod === 'claude.ai',
      auth_method: auth?.authMethod ?? null,
      email: auth?.email ?? null,
      // Claude Code in Chrome needs a paid plan. null: this Claude Code version doesn't report it.
      plan: auth?.plan ?? null,
      paid_plan: auth?.plan ? PAID_PLANS.has(auth.plan) : null,
      chrome_extension: findClaudeExtension(),
    });
  });
  // Asks Claude to list the Chrome browsers it can reach. Uses a tiny amount of the person's Claude usage.
  app.post('/api/setup/test-chrome', async (req, res) => {
    const bin = findClaude();
    if (!bin) throw new HttpError(409, 'Install Claude Code first');
    res.json(await testChromeConnection(bin, p));
  });
  // Both open a terminal window: the installer and the browser login need the person, not the app.
  app.post('/api/setup/install-claude', (req, res) => {
    openTerminal(CLAUDE_INSTALL_COMMAND);
    res.json({ opened: true });
  });
  app.post('/api/setup/login', (req, res) => {
    const bin = findClaude();
    if (!bin) throw new HttpError(409, 'Install Claude Code first');
    openTerminal(claudeLoginCommand(bin));
    res.json({ opened: true });
  });

  // ---- settings & status
  app.get('/api/settings', (req, res) => res.json(getSettings(db)));

  app.put('/api/settings', (req, res) => {
    const input = req.body ?? {};
    for (const [key, value] of Object.entries(input)) {
      if (key in NUMERIC_SETTINGS) {
        const [min, max] = NUMERIC_SETTINGS[key];
        const n = Number(value);
        if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${key} must be ${min}–${max}`);
        setSetting(db, key, n);
      } else if (key === 'model') {
        if (!MODELS.has(value)) throw new HttpError(400, 'Model must be sonnet, opus or haiku');
        setSetting(db, key, value);
      } else if (key === 'join_about') {
        const text = String(value ?? '').trim();
        if (text.length < 10 || text.length > 500) throw new HttpError(400, 'The join answer must be 10–500 characters');
        setSetting(db, key, text);
      } else if (key === 'fb_account_url') {
        const url = String(value ?? '').trim().replace(/\/+$/, '');
        if (url && !/^https:\/\/(www\.)?facebook\.com\/[^\s]+$/.test(url)) {
          throw new HttpError(400, 'The Facebook account must be a https://www.facebook.com/… link, or empty');
        }
        setSetting(db, key, url.replace('https://facebook.com/', 'https://www.facebook.com/'));
      } else if (key === 'paused_until') {
        setSetting(db, key, ''); // only clearing a pause is allowed from the UI
      } else if (!(key in DEFAULT_SETTINGS)) {
        throw new HttpError(400, `Unknown setting ${key}`);
      }
    }
    res.json(getSettings(db));
  });

  app.get('/api/status', (req, res) => {
    const settings = getSettings(db);
    const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all()
      .map((r) => [r.status, r.n]));
    res.json({
      worker_running: workerAlive(p.lock),
      worker_launchd: !IN_ELECTRON && fs.existsSync(LAUNCHD_PLIST),
      overdue: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued' AND scheduled_at <= ?").get(nowIso()).n,
      paused_until: settings.paused_until || null,
      posted_today: postedToday(db, new Date()),
      daily_cap: Number(settings.daily_cap),
      counts,
    });
  });

  // ---- static
  app.use('/media', express.static(p.media, { index: false, dotfiles: 'deny' }));
  app.use(express.static(p.webDist));
  app.get(/^\/(?!api\/).*/, (req, res, next) => {
    const index = path.join(p.webDist, 'index.html');
    if (fs.existsSync(index)) res.sendFile(index);
    else next();
  });

  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 10 MB or less' : err.message;
      return res.status(400).json({ error: msg });
    }
    const status = err.status || 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'Internal error' : err.message });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const p = getPaths();
  const db = openDb(p.db);
  createApp(db, p).listen(PORT, HOST, () => {
    console.log(`Autoposter dashboard: http://${HOST}:${PORT}`);
  });
}
