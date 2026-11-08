import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { paths as getPaths } from './config.js';
import { openDb, getSettings, setSetting, getJob, getPostMedia, nowIso, tx } from './db.js';
import { runJob as defaultRunJob } from './runner.js';

const RETRY_BACKOFF_MIN = 10;
const USAGE_PAUSE_MIN = 60;
// Join rechecks never run at night: a post that follows an accepted join would go out then too.
const DAY_START_HOUR = 7;
const DAY_END_HOUR = 22;

export function nextDaytime(date) {
  const d = new Date(date);
  if (d.getHours() >= DAY_END_HOUR) { d.setDate(d.getDate() + 1); d.setHours(DAY_START_HOUR, 5, 0, 0); }
  else if (d.getHours() < DAY_START_HOUR) d.setHours(DAY_START_HOUR, 5, 0, 0);
  return d;
}

function startOfLocalDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

// A worker that died mid-run leaves jobs in 'running'. They may have posted, so never re-run them.
export function resetStale(db, settings, now) {
  const cutoff = new Date(now.getTime() - (Number(settings.job_timeout_min) + 5) * 60_000);
  db.prepare(`UPDATE jobs SET status = 'needs_check', finished_at = ?,
      last_error = 'Worker stopped while this job was running; check Facebook before retrying'
    WHERE status = 'running' AND started_at < ?`).run(nowIso(now), nowIso(cutoff));
}

export function postedToday(db, now) {
  return db.prepare(`SELECT COUNT(*) AS n FROM jobs
    WHERE status IN ('submitted','pending_approval') AND finished_at >= ?`)
    .get(nowIso(startOfLocalDay(now))).n;
}

// Group posts (Facebook groups, subreddits, LinkedIn groups) are spaced per platform: a subreddit post doesn't
// hold up a Facebook group post.
export function lastGroupStart(db, platform = 'facebook') {
  return db.prepare(`SELECT MAX(j.started_at) AS t FROM jobs j JOIN destinations d ON d.id = j.destination_id
    WHERE d.type = 'group' AND d.platform = ? AND j.started_at IS NOT NULL`).get(platform).t;
}

export function forcedJob(db) {
  return db.prepare(`SELECT j.id FROM jobs j JOIN destinations d ON d.id = j.destination_id
    WHERE j.force_now = 1 AND j.status IN ('queued','awaiting_join') AND d.archived = 0
    ORDER BY j.id LIMIT 1`).get()?.id ?? null;
}

// Picks the earliest due job that spacing allows and marks it running, atomically.
// A "Post now" job goes first and ignores its schedule and the group gap.
export function claimNext(db, settings, now) {
  return tx(db, () => {
    const forced = forcedJob(db);
    if (forced) {
      const claimed = db.prepare(`UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1, force_now = 0
        WHERE id = ? AND status IN ('queued','awaiting_join') RETURNING id`).get(nowIso(now), forced);
      return claimed ? getJob(db, claimed.id) : null;
    }
    const due = db.prepare(`SELECT j.id, d.type, d.platform FROM jobs j JOIN destinations d ON d.id = j.destination_id
      WHERE j.status IN ('queued','awaiting_join') AND j.scheduled_at <= ? AND d.enabled = 1 AND d.archived = 0
      ORDER BY j.scheduled_at, j.id`).all(nowIso(now));
    const gapMs = Number(settings.group_gap_minutes) * 60_000;
    const blocked = {};
    const groupBlocked = (platform) => {
      if (!(platform in blocked)) {
        const last = lastGroupStart(db, platform);
        blocked[platform] = Boolean(last && now.getTime() - new Date(last).getTime() < gapMs);
      }
      return blocked[platform];
    };
    const pick = due.find((j) => !(j.type === 'group' && groupBlocked(j.platform)));
    if (!pick) return null;
    const claimed = db.prepare(`UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1
      WHERE id = ? AND status IN ('queued','awaiting_join') RETURNING id`).get(nowIso(now), pick.id);
    return claimed ? getJob(db, claimed.id) : null;
  });
}

export function recordOutcome(db, job, outcome, settings, now) {
  const finished = nowIso(now);
  const raw = outcome.raw ? JSON.stringify(outcome.raw) : null;

  if (outcome.kind === 'usage_limit') {
    setSetting(db, 'paused_until', nowIso(new Date(now.getTime() + USAGE_PAUSE_MIN * 60_000)));
    db.prepare(`UPDATE jobs SET status = 'queued', attempts = attempts - 1, started_at = NULL, last_error = ?
      WHERE id = ?`).run(`Claude usage limit reached; paused ${USAGE_PAUSE_MIN} min. ${outcome.error}`, job.id);
    return 'queued';
  }

  if (outcome.kind === 'ambiguous') {
    db.prepare(`UPDATE jobs SET status = 'needs_check', finished_at = ?, last_error = ?, result_json = ? WHERE id = ?`)
      .run(finished, outcome.error, raw, job.id);
    return 'needs_check';
  }

  const { result } = outcome;
  if (result.status === 'awaiting_join' && !result.clicked_post) {
    const requestedAt = job.join_requested_at || finished;
    const waitedDays = (now.getTime() - new Date(requestedAt).getTime()) / 86_400_000;
    if (waitedDays >= Number(settings.join_wait_days || 14)) {
      db.prepare(`UPDATE jobs SET status = 'failed', finished_at = ?, last_error = ?, result_json = ? WHERE id = ?`)
        .run(finished, `The group hasn't accepted the join request after ${Math.floor(waitedDays)} days, so this post was not sent. `
          + 'If you get in later, press Retry now.', raw, job.id);
      return 'failed';
    }
    const recheck = nextDaytime(new Date(now.getTime() + Number(settings.join_recheck_hours || 6) * 3_600_000));
    // A recheck is not a failed attempt, so it never uses up the retry.
    db.prepare(`UPDATE jobs SET status = 'awaiting_join', scheduled_at = ?, started_at = NULL, attempts = MAX(attempts - 1, 0),
        join_requested_at = ?, last_error = NULL, result_json = ? WHERE id = ?`)
      .run(nowIso(recheck), requestedAt, raw, job.id);
    return 'awaiting_join';
  }
  if (result.status === 'failed' && !result.clicked_post && job.attempts < Number(settings.max_attempts)) {
    const retryAt = nowIso(new Date(now.getTime() + RETRY_BACKOFF_MIN * 60_000));
    db.prepare(`UPDATE jobs SET status = 'queued', scheduled_at = ?, started_at = NULL, last_error = ?, result_json = ?
      WHERE id = ?`).run(retryAt, result.note, raw, job.id);
    return 'queued';
  }
  // A "failed" report after Post was clicked is ambiguous: something may be live.
  const status = result.status === 'failed' && result.clicked_post ? 'needs_check' : result.status;
  const missedComment = status === 'submitted' && job.first_comment && result.commented !== true;
  const note = status === 'submitted' || status === 'pending_approval'
    ? (missedComment ? `Posted, but the first comment wasn't added. Add it yourself: ${result.note}` : null)
    : result.note;
  db.prepare(`UPDATE jobs SET status = ?, finished_at = ?, last_error = ?, result_json = ?, post_url = ? WHERE id = ?`)
    .run(status, finished, note, raw, result.post_url, job.id);
  return status;
}

/** One scheduler pass. Returns what happened, for logging and tests. */
export async function tick(db, { paths, runJob = defaultRunJob, now = () => new Date() } = {}) {
  const settings = getSettings(db);
  resetStale(db, settings, now());
  const forced = forcedJob(db) !== null; // "Post now" is the user's explicit override of the pause and the cap
  if (!forced && settings.paused_until && new Date(settings.paused_until) > now()) return { action: 'paused' };
  if (!forced && postedToday(db, now()) >= Number(settings.daily_cap)) return { action: 'daily_cap' };

  const job = claimNext(db, settings, now());
  if (!job) return { action: 'idle' };

  let outcome;
  try {
    outcome = await runJob(job, getPostMedia(db, job.post_id), { paths, settings });
  } catch (err) {
    outcome = { kind: 'ambiguous', error: `Runner crashed: ${err.message}` };
  }
  const status = recordOutcome(db, job, outcome, settings, now());
  return { action: 'ran', jobId: job.id, status };
}

function acquireLock(lockFile) {
  try {
    const pid = Number(fs.readFileSync(lockFile, 'utf8'));
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); return false; } catch { /* stale lock */ }
    }
  } catch { /* no lock yet */ }
  fs.writeFileSync(lockFile, String(process.pid));
  const release = () => { try { if (fs.readFileSync(lockFile, 'utf8') === String(process.pid)) fs.unlinkSync(lockFile); } catch {} };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
  return true;
}

// `node src/worker.js --post-now`: runs the "Post now" job once and exits. The server uses this when the
// background worker is stopped, so one post can go out without releasing every other overdue post.
async function postNowOnce(p) {
  const db = openDb(p.db);
  if (forcedJob(db) === null) return;
  const r = await tick(db, { paths: p });
  console.log(`[${nowIso()}] post now: ${r.action === 'ran' ? `job ${r.jobId} -> ${r.status}` : r.action}`);
}

async function main() {
  const p = getPaths();
  if (process.argv.includes('--post-now')) return postNowOnce(p);
  if (!acquireLock(p.lock)) {
    console.error('Another autoposter worker is already running; exiting.');
    process.exit(1);
  }
  const db = openDb(p.db);
  console.log(`[${nowIso()}] worker started (pid ${process.pid})`);
  let busy = false;
  const loop = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await tick(db, { paths: p });
      if (r.action === 'ran') console.log(`[${nowIso()}] job ${r.jobId} -> ${r.status}`);
    } catch (err) {
      console.error(`[${nowIso()}] tick error:`, err);
    } finally {
      busy = false;
    }
  };
  await loop();
  setInterval(loop, 60_000);
  // "Post now" sets a flag in the database; checking it every few seconds works the same on macOS and Windows.
  setInterval(() => { if (!busy && forcedJob(db) !== null) loop(); }, 5_000);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
