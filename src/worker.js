import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { paths as getPaths } from './config.js';
import { openDb, getSettings, setSetting, getJob, getPostMedia, nowIso, tx, setAccountLogin } from './db.js';
import { runJob as defaultRunJob } from './runner.js';

const RETRY_BACKOFF_MIN = 10;
const USAGE_PAUSE_MIN = 60;
// Join rechecks never run at night: a post that follows an accepted join would go out then too.
const DAY_START_HOUR = 7;
const DAY_END_HOUR = 22;
// A post waiting for group admins is looked at again this long after it was sent, then after each next gap.
// After the last look it stays "Pending approval" and the person can check it themselves.
export const APPROVAL_CHECKS_MIN = [30, 180, 720, 2880];

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

// Posts go out first in, first out: the earliest due job goes next and marks it running, atomically. When the
// group gap holds it, later jobs wait behind it, so nothing jumps the queue.
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
    const pick = due[0];
    if (!pick || (pick.type === 'group' && groupBlocked(pick.platform))) return null;
    const claimed = db.prepare(`UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1
      WHERE id = ? AND status IN ('queued','awaiting_join') RETURNING id`).get(nowIso(now), pick.id);
    return claimed ? getJob(db, claimed.id) : null;
  });
}

const LATE_MS = 60_000; // a queued post counts as delayed once it is this late

/**
 * Why each overdue post hasn't gone out yet, keyed by job id: { reason, eta }. eta is when it should go, when known.
 * Follows the same rules as tick() and claimNext(), in the same order.
 */
export function delayReasons(db, { workerRunning, now = new Date() } = {}) {
  const settings = getSettings(db);
  const late = db.prepare(`SELECT j.id, j.status, j.scheduled_at, d.type, d.platform, d.enabled, d.name FROM jobs j
    JOIN destinations d ON d.id = j.destination_id
    WHERE j.status IN ('queued','awaiting_join') AND j.scheduled_at <= ? AND d.archived = 0
    ORDER BY j.scheduled_at, j.id`).all(nowIso(new Date(now.getTime() - LATE_MS)));
  const out = {};
  if (!late.length) return out;
  const all = (reason, eta = null) => { for (const j of late) if (j.status === 'queued') out[j.id] = { reason, eta }; return out; };
  if (workerRunning === false) return all('The worker is stopped. Start it to post.');
  if (!settings.setup_verified_at) return all('Waiting for Setup to be finished.');
  if (settings.paused_until && new Date(settings.paused_until) > now) {
    return all("Claude's usage limit was reached, so posting is paused.", settings.paused_until);
  }
  const cap = Number(settings.daily_cap);
  if (postedToday(db, now) >= cap) {
    return all(`Today's limit of ${cap} posts is reached (Settings). Posting goes on tomorrow.`, nowIso(startOfLocalDay(new Date(now.getTime() + 86_400_000))));
  }
  const running = db.prepare("SELECT d.name FROM jobs j JOIN destinations d ON d.id = j.destination_id WHERE j.status = 'running' LIMIT 1").get();
  const enabled = late.filter((j) => j.enabled);
  const first = enabled[0];
  let held = null;
  if (first && first.type === 'group') {
    const last = lastGroupStart(db, first.platform);
    const gapMs = Number(settings.group_gap_minutes) * 60_000;
    if (last && now.getTime() - new Date(last).getTime() < gapMs) held = nowIso(new Date(new Date(last).getTime() + gapMs));
  }
  for (const j of late) {
    if (j.status !== 'queued') continue;
    if (!j.enabled) out[j.id] = { reason: 'This place is turned off in Destinations.', eta: null };
    else if (running) out[j.id] = { reason: `Waiting for the post to ${running.name} that is going out now.`, eta: null };
    else if (j === first) {
      out[j.id] = held
        ? { reason: `Group posts are kept ${settings.group_gap_minutes} minutes apart (Settings), and the last group post went out late.`, eta: held }
        : { reason: 'Starting in a few seconds.', eta: null };
    } else out[j.id] = { reason: `Waiting its turn behind the earlier post to ${first.name}.`, eta: null };
  }
  return out;
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
  // The account's login inside the app expired: wait for the person to log in again. Not a failed attempt.
  if (result.status === 'needs_login' && !result.clicked_post) {
    db.prepare(`UPDATE jobs SET status = 'needs_login', started_at = NULL, attempts = MAX(attempts - 1, 0), last_error = ?, result_json = ?
      WHERE id = ?`).run(result.note || 'Log in again on the Accounts page', raw, job.id);
    if (job.account_ref) setAccountLogin(db, job.account_ref, 'needs_login', now);
    return 'needs_login';
  }
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
  const status = ['failed', 'needs_login'].includes(result.status) && result.clicked_post ? 'needs_check' : result.status;
  const missedComment = status === 'submitted' && job.first_comment && result.commented !== true;
  const note = status === 'submitted' || status === 'pending_approval'
    ? (missedComment ? `Posted, but the first comment wasn't added. Add it yourself: ${result.note}` : null)
    : result.note;
  const nextCheck = status === 'pending_approval' ? nowIso(new Date(now.getTime() + APPROVAL_CHECKS_MIN[0] * 60_000)) : null;
  db.prepare(`UPDATE jobs SET status = ?, finished_at = ?, last_error = ?, result_json = ?, post_url = ?, approval_checks = 0, next_check_at = ?
    WHERE id = ?`).run(status, finished, note, raw, result.post_url, nextCheck, job.id);
  return status;
}

// The next post waiting for group approval that is due for another look, or null.
export function dueApprovalCheck(db, now) {
  const row = db.prepare(`SELECT j.id FROM jobs j JOIN destinations d ON d.id = j.destination_id
    WHERE j.status = 'pending_approval' AND j.next_check_at IS NOT NULL AND j.next_check_at <= ? AND d.archived = 0
    ORDER BY j.next_check_at, j.id LIMIT 1`).get(nowIso(now));
  return row ? getJob(db, row.id) : null;
}

/** Records a later look at a post waiting for group approval. Returns the job's status afterwards. */
export function recordApprovalCheck(db, job, outcome, now) {
  const checks = (job.approval_checks || 0) + 1;
  const result = outcome.kind === 'result' ? outcome.result : null;
  // Couldn't tell (Claude's limit, a timeout, an expired login): look again in an hour; it doesn't count as a look.
  if (!result || result.status === 'needs_login') {
    db.prepare('UPDATE jobs SET next_check_at = ? WHERE id = ?').run(nowIso(new Date(now.getTime() + 60 * 60_000)), job.id);
    if (result?.status === 'needs_login' && job.account_ref) setAccountLogin(db, job.account_ref, 'needs_login', now);
    return 'pending_approval';
  }
  const raw = outcome.raw ? JSON.stringify(outcome.raw) : null;
  if (result.status === 'submitted') {
    const missed = job.first_comment && result.commented !== true;
    db.prepare(`UPDATE jobs SET status = 'submitted', approval_checks = ?, next_check_at = NULL, post_url = COALESCE(?, post_url),
        last_error = ?, result_json = ? WHERE id = ?`)
      .run(checks, result.post_url, missed ? `Approved and live, but the first comment wasn't added. Add it yourself: ${result.note}` : null, raw, job.id);
    return 'submitted';
  }
  if (result.status === 'failed') {
    // Declined by the admins, or gone from the group: it won't go live, so stop looking.
    db.prepare(`UPDATE jobs SET status = 'failed', approval_checks = ?, next_check_at = NULL, last_error = ?, result_json = ? WHERE id = ?`)
      .run(checks, `The group didn't publish this post (declined or removed by the admins). ${result.note}`, raw, job.id);
    return 'failed';
  }
  const gap = APPROVAL_CHECKS_MIN[checks];
  const note = gap ? null : 'Still waiting for the group admins after 2 days. Open the group to check it yourself.';
  db.prepare('UPDATE jobs SET approval_checks = ?, next_check_at = ?, last_error = ? WHERE id = ?')
    .run(checks, gap ? nowIso(new Date(now.getTime() + gap * 60_000)) : null, note, job.id);
  return 'pending_approval';
}

/** One scheduler pass. Returns what happened, for logging and tests. */
export async function tick(db, { paths, runJob = defaultRunJob, now = () => new Date() } = {}) {
  const settings = getSettings(db);
  resetStale(db, settings, now());
  const forced = forcedJob(db) !== null; // "Post now" is the user's explicit override of the pause and the cap
  if (!forced && !settings.setup_verified_at) return { action: 'not_ready' };
  if (!forced && settings.paused_until && new Date(settings.paused_until) > now()) return { action: 'paused' };
  const capped = !forced && postedToday(db, now()) >= Number(settings.daily_cap);

  const job = capped ? null : claimNext(db, settings, now());
  if (!job) {
    // Nothing to post right now: look again at a post waiting for group approval (that doesn't count toward the daily cap).
    const check = dueApprovalCheck(db, now());
    if (check) {
      let outcome;
      try {
        outcome = await runJob(check, [], { paths, settings, mode: 'check' });
      } catch (err) {
        outcome = { kind: 'ambiguous', error: `Runner crashed: ${err.message}` };
      }
      return { action: 'checked', jobId: check.id, status: recordApprovalCheck(db, check, outcome, now()) };
    }
    return { action: capped ? 'daily_cap' : 'idle' };
  }

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
  let warned = false;
  const loop = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await tick(db, { paths: p });
      if (r.action === 'ran') console.log(`[${nowIso()}] job ${r.jobId} -> ${r.status}`);
      if (r.action === 'checked') console.log(`[${nowIso()}] approval check: job ${r.jobId} -> ${r.status}`);
      if (r.action === 'not_ready' && !warned) console.log(`[${nowIso()}] holding scheduled posts: finish Setup and run the test automation`);
      warned = r.action === 'not_ready';
    } catch (err) {
      console.error(`[${nowIso()}] tick error:`, err);
    } finally {
      busy = false;
    }
  };
  await loop();
  setInterval(loop, 15_000); // a due post starts within 15 seconds
  // "Post now" sets a flag in the database; checking it every few seconds works the same on macOS and Windows.
  setInterval(() => { if (!busy && forcedJob(db) !== null) loop(); }, 5_000);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
