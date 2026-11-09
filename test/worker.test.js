import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, addDestination, addJob } from './helpers.js';
import { tick, claimNext } from '../src/worker.js';
import { getSettings, setSetting } from '../src/db.js';

const T0 = new Date('2026-11-03T10:00:00Z');
const at = (min) => new Date(T0.getTime() + min * 60_000);
const fakeRun = (outcome) => async () => outcome;
const ok = { kind: 'result', result: { status: 'submitted', clicked_post: true, post_url: null, note: '' } };
const status = (db, id) => db.prepare('SELECT status FROM jobs WHERE id = ?').get(id).status;

test('only due jobs run; future jobs wait', async () => {
  const { db, p } = setup();
  const d = addDestination(db);
  const future = addJob(db, d.id, at(30));
  assert.equal((await tick(db, { paths: p, runJob: fakeRun(ok), now: () => T0 })).action, 'idle');
  assert.equal(status(db, future.id), 'queued');
});

test('a job can only be claimed once', () => {
  const { db } = setup();
  const d = addDestination(db);
  addJob(db, d.id, T0);
  const s = getSettings(db);
  assert.ok(claimNext(db, s, T0));
  assert.equal(claimNext(db, s, T0), null);
});

test('group posts are spaced by group_gap_minutes, and later posts wait their turn', async () => {
  const { db, p } = setup();
  const g1 = addDestination(db, { name: 'G1', type: 'group' });
  const g2 = addDestination(db, { name: 'G2', type: 'group' });
  const pg = addDestination(db, { name: 'P', type: 'page' });
  const j1 = addJob(db, g1.id, T0);
  const j2 = addJob(db, g2.id, T0);
  const j3 = addJob(db, pg.id, T0);
  const opts = (now) => ({ paths: p, runJob: fakeRun(ok), now: () => now });
  assert.equal((await tick(db, opts(T0))).jobId, j1.id);
  assert.equal((await tick(db, opts(at(1)))).action, 'idle', 'the page post waits behind the held group post');
  assert.equal((await tick(db, opts(at(20)))).jobId, j2.id);
  assert.equal((await tick(db, opts(at(21)))).jobId, j3.id);
});

test('daily cap stops further runs', async () => {
  const { db, p } = setup();
  setSetting(db, 'daily_cap', 1);
  const d1 = addDestination(db);
  const d2 = addDestination(db);
  addJob(db, d1.id, T0);
  const j2 = addJob(db, d2.id, T0);
  await tick(db, { paths: p, runJob: fakeRun(ok), now: () => T0 });
  assert.equal((await tick(db, { paths: p, runJob: fakeRun(ok), now: () => at(1) })).action, 'daily_cap');
  assert.equal(status(db, j2.id), 'queued');
});

test('failed before clicking Post retries once, then fails', async () => {
  const { db, p } = setup();
  const d = addDestination(db);
  const j = addJob(db, d.id, T0);
  const fail = fakeRun({ kind: 'result', result: { status: 'failed', clicked_post: false, post_url: null, note: 'login wall' } });
  assert.equal((await tick(db, { paths: p, runJob: fail, now: () => T0 })).status, 'queued');
  assert.equal((await tick(db, { paths: p, runJob: fail, now: () => at(5) })).action, 'idle', 'backoff');
  assert.equal((await tick(db, { paths: p, runJob: fail, now: () => at(10) })).status, 'failed');
  assert.equal(status(db, j.id), 'failed');
});

test('failed after clicking Post, ambiguous output and crashes become needs_check (no auto retry)', async () => {
  for (const outcome of [
    { kind: 'result', result: { status: 'failed', clicked_post: true, post_url: null, note: 'x' } },
    { kind: 'ambiguous', error: 'garbage' },
  ]) {
    const { db, p } = setup();
    const d = addDestination(db);
    const j = addJob(db, d.id, T0);
    await tick(db, { paths: p, runJob: fakeRun(outcome), now: () => T0 });
    assert.equal(status(db, j.id), 'needs_check');
    assert.equal((await tick(db, { paths: p, runJob: fakeRun(ok), now: () => at(60) })).action, 'idle');
  }
  const { db, p } = setup();
  const d = addDestination(db);
  const j = addJob(db, d.id, T0);
  await tick(db, { paths: p, runJob: async () => { throw new Error('spawn ENOENT'); }, now: () => T0 });
  assert.equal(status(db, j.id), 'needs_check');
});

test('usage limit requeues the job and pauses the worker', async () => {
  const { db, p } = setup();
  const d = addDestination(db);
  const j = addJob(db, d.id, T0);
  await tick(db, { paths: p, runJob: fakeRun({ kind: 'usage_limit', error: 'limit' }), now: () => T0 });
  assert.equal(status(db, j.id), 'queued');
  assert.equal(db.prepare('SELECT attempts FROM jobs WHERE id = ?').get(j.id).attempts, 0);
  assert.equal((await tick(db, { paths: p, runJob: fakeRun(ok), now: () => at(30) })).action, 'paused');
  assert.equal((await tick(db, { paths: p, runJob: fakeRun(ok), now: () => at(61) })).status, 'submitted');
});

test('stale running jobs become needs_check', async () => {
  const { db, p } = setup();
  const d = addDestination(db);
  const j = addJob(db, d.id, T0);
  db.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?").run(T0.toISOString(), j.id);
  await tick(db, { paths: p, runJob: fakeRun(ok), now: () => at(30) });
  assert.equal(status(db, j.id), 'needs_check');
});

test('other platforms are posted too, and the group gap is per platform', async () => {
  const { db, p } = setup();
  const fbGroup = addDestination(db, { name: 'FB', type: 'group' });
  const sub1 = addDestination(db, { name: 'r/one', type: 'group' });
  const sub2 = addDestination(db, { name: 'r/two', type: 'group' });
  db.prepare("UPDATE destinations SET platform = 'reddit' WHERE id IN (?, ?)").run(sub1.id, sub2.id);
  const j1 = addJob(db, fbGroup.id, T0);
  const j2 = addJob(db, sub1.id, T0);
  const j3 = addJob(db, sub2.id, T0);
  const opts = (now) => ({ paths: p, runJob: fakeRun(ok), now: () => now });
  assert.equal((await tick(db, opts(T0))).jobId, j1.id);
  assert.equal((await tick(db, opts(at(1)))).jobId, j2.id, 'a Facebook group post does not block a subreddit');
  assert.equal((await tick(db, opts(at(2)))).action, 'idle', 'the second subreddit waits for the gap');
  assert.equal((await tick(db, opts(at(22)))).jobId, j3.id);
});

test('disabled destinations are skipped but keep their jobs', async () => {
  const { db, p } = setup();
  const d = addDestination(db, { enabled: 0 });
  const j = addJob(db, d.id, T0);
  assert.equal((await tick(db, { paths: p, runJob: fakeRun(ok), now: () => T0 })).action, 'idle');
  assert.equal(status(db, j.id), 'queued');
});

const awaiting = { kind: 'result', result: { status: 'awaiting_join', clicked_post: false, post_url: null, note: 'Join request sent' } };
const row = (db, id) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);

test('a pending join request waits, rechecks in daytime, keeps its retry, then posts', async () => {
  const { db, p } = setup();
  const g = addDestination(db, { name: 'G', type: 'group' });
  const j = addJob(db, g.id, T0);
  assert.equal((await tick(db, { paths: p, runJob: fakeRun(awaiting), now: () => T0 })).status, 'awaiting_join');
  const r = row(db, j.id);
  assert.equal(r.status, 'awaiting_join');
  assert.equal(r.attempts, 0, 'a recheck is not a failed attempt');
  assert.equal(r.join_requested_at, T0.toISOString());
  const next = new Date(r.scheduled_at);
  assert.ok(next.getTime() >= T0.getTime() + 6 * 3_600_000);
  assert.ok(next.getHours() >= 7 && next.getHours() < 22, 'never rechecks at night');
  assert.equal((await tick(db, { paths: p, runJob: fakeRun(ok), now: () => at(60) })).action, 'idle', 'not before the recheck time');
  assert.equal((await tick(db, { paths: p, runJob: fakeRun(ok), now: () => next })).status, 'submitted');
});

test('a join request that is never accepted fails after join_wait_days', async () => {
  const { db, p } = setup();
  setSetting(db, 'join_wait_days', 2);
  const g = addDestination(db, { name: 'G', type: 'group' });
  const j = addJob(db, g.id, T0);
  await tick(db, { paths: p, runJob: fakeRun(awaiting), now: () => T0 });
  const later = new Date(T0.getTime() + 3 * 86_400_000);
  db.prepare('UPDATE jobs SET scheduled_at = ? WHERE id = ?').run(later.toISOString(), j.id);
  assert.equal((await tick(db, { paths: p, runJob: fakeRun(awaiting), now: () => later })).status, 'failed');
  assert.match(row(db, j.id).last_error, /hasn't accepted the join request/);
});

test('"Post now" runs a future job first, ignoring the group gap, daily cap and usage pause', async () => {
  const { db, p } = setup();
  setSetting(db, 'daily_cap', 1);
  const g1 = addDestination(db, { name: 'G1', type: 'group' });
  const g2 = addDestination(db, { name: 'G2', type: 'group' });
  const g3 = addDestination(db, { name: 'G3', type: 'group' });
  addJob(db, g1.id, T0);
  const due = addJob(db, g2.id, T0);
  const later = addJob(db, g3.id, at(600));
  const opts = (now) => ({ paths: p, runJob: fakeRun(ok), now: () => now });
  await tick(db, opts(T0)); // uses the daily cap and starts the group gap
  setSetting(db, 'paused_until', at(60).toISOString());
  db.prepare('UPDATE jobs SET force_now = 1 WHERE id = ?').run(later.id);
  const r = await tick(db, opts(at(1)));
  assert.equal(r.jobId, later.id);
  assert.equal(status(db, later.id), 'submitted');
  assert.equal(db.prepare('SELECT force_now FROM jobs WHERE id = ?').get(later.id).force_now, 0);
  assert.equal((await tick(db, opts(at(2)))).action, 'paused', 'the override is one-shot');
  assert.equal(status(db, due.id), 'queued');
});

test('posted without its first comment: still Posted, with a note to add it by hand', async () => {
  const { db, p } = setup();
  const d = addDestination(db, { type: 'group' });
  const j = addJob(db, d.id, T0);
  db.prepare("UPDATE posts SET first_comment = 'link' WHERE id = ?").run(j.post_id);
  const noComment = { kind: 'result', result: { status: 'submitted', clicked_post: true, post_url: null, commented: false, note: 'comment box missing' } };
  await tick(db, { paths: p, runJob: fakeRun(noComment), now: () => T0 });
  const row = db.prepare('SELECT status, last_error FROM jobs WHERE id = ?').get(j.id);
  assert.equal(row.status, 'submitted');
  assert.match(row.last_error, /first comment wasn't added/);
});

test('scheduled posts wait until Setup passes; Post now still goes', async () => {
  const { db, p } = setup();
  setSetting(db, 'setup_verified_at', '');
  const d = addDestination(db);
  const due = addJob(db, d.id, T0);
  assert.equal((await tick(db, { paths: p, runJob: fakeRun(ok), now: () => T0 })).action, 'not_ready');
  assert.equal(status(db, due.id), 'queued');
  db.prepare('UPDATE jobs SET force_now = 1 WHERE id = ?').run(due.id);
  assert.equal((await tick(db, { paths: p, runJob: fakeRun(ok), now: () => T0 })).action, 'ran');
});

test('a post waiting for group approval is looked at again later, and marked posted once it is live', async () => {
  const { db, p } = setup();
  const g = addDestination(db, { name: 'G', type: 'group' });
  const j = addJob(db, g.id, T0);
  const pending = { kind: 'result', result: { status: 'pending_approval', clicked_post: true, post_url: null, note: '' } };
  await tick(db, { paths: p, runJob: fakeRun(pending), now: () => T0 });
  const row = () => db.prepare('SELECT status, next_check_at, approval_checks, last_error FROM jobs WHERE id = ?').get(j.id);
  assert.equal(row().next_check_at, at(30).toISOString());
  // Not due yet: nothing to do.
  assert.equal((await tick(db, { paths: p, runJob: fakeRun(pending), now: () => at(10) })).action, 'idle');
  // First look: still waiting, so the next look is 3 hours later.
  const modes = [];
  const still = async (job, media, o) => { modes.push(o.mode); return { kind: 'result', result: { status: 'pending_approval', clicked_post: false, post_url: null, note: '' } }; };
  const r1 = await tick(db, { paths: p, runJob: still, now: () => at(31) });
  assert.equal(r1.action, 'checked');
  assert.deepEqual(modes, ['check']);
  assert.equal(row().approval_checks, 1);
  assert.equal(row().next_check_at, at(31 + 180).toISOString());
  // Second look: approved.
  const live = fakeRun({ kind: 'result', result: { status: 'submitted', clicked_post: false, post_url: null, note: '' } });
  assert.equal((await tick(db, { paths: p, runJob: live, now: () => at(220) })).status, 'submitted');
  assert.equal(row().status, 'submitted');
  assert.equal(row().next_check_at, null);
});

test('approval looks stop after the last one, and a usage limit only postpones a look', async () => {
  const { db, p } = setup();
  const g = addDestination(db, { name: 'G', type: 'group' });
  const j = addJob(db, g.id, T0);
  db.prepare("UPDATE jobs SET status = 'pending_approval', next_check_at = ?, approval_checks = 3 WHERE id = ?").run(T0.toISOString(), j.id);
  const row = () => db.prepare('SELECT status, next_check_at, approval_checks, last_error FROM jobs WHERE id = ?').get(j.id);
  await tick(db, { paths: p, runJob: fakeRun({ kind: 'usage_limit', error: 'limit' }), now: () => T0 });
  assert.equal(row().approval_checks, 3);
  assert.equal(row().next_check_at, at(60).toISOString());
  const still = fakeRun({ kind: 'result', result: { status: 'pending_approval', clicked_post: false, post_url: null, note: '' } });
  await tick(db, { paths: p, runJob: still, now: () => at(61) });
  assert.equal(row().status, 'pending_approval');
  assert.equal(row().next_check_at, null);
  assert.match(row().last_error, /2 days/);
});

test('a post the group declined becomes failed and is not looked at again', async () => {
  const { db, p } = setup();
  const g = addDestination(db, { name: 'G', type: 'group' });
  const j = addJob(db, g.id, T0);
  db.prepare("UPDATE jobs SET status = 'pending_approval', next_check_at = ? WHERE id = ?").run(T0.toISOString(), j.id);
  const declined = fakeRun({ kind: 'result', result: { status: 'failed', clicked_post: false, post_url: null, note: 'Under Declined' } });
  assert.equal((await tick(db, { paths: p, runJob: declined, now: () => T0 })).status, 'failed');
  const r = db.prepare('SELECT status, next_check_at, last_error FROM jobs WHERE id = ?').get(j.id);
  assert.equal(r.status, 'failed');
  assert.equal(r.next_check_at, null);
  assert.match(r.last_error, /declined/);
});

test('late posts say why they are delayed and when they should go', async () => {
  const { db, p } = setup();
  const { delayReasons } = await import('../src/worker.js');
  const g1 = addDestination(db, { name: 'G1', type: 'group' });
  const g2 = addDestination(db, { name: 'G2', type: 'group' });
  const pg = addDestination(db, { name: 'P', type: 'page' });
  const j1 = addJob(db, g1.id, T0);
  const j2 = addJob(db, g2.id, at(10));
  const j3 = addJob(db, pg.id, at(20));
  assert.match(delayReasons(db, { workerRunning: false, now: at(30) })[j2.id].reason, /worker is stopped/);
  await tick(db, { paths: p, runJob: fakeRun(ok), now: () => at(30) }); // j1 goes, starting the group gap
  const d = delayReasons(db, { workerRunning: true, now: at(35) });
  assert.equal(d[j1.id], undefined);
  assert.match(d[j2.id].reason, /minutes apart/);
  assert.equal(d[j2.id].eta, at(30 + Number(getSettings(db).group_gap_minutes)).toISOString());
  assert.match(d[j3.id].reason, /behind the earlier post to G2/);
  // Not late yet: no reason.
  const j4 = addJob(db, pg.id, at(35));
  assert.equal(delayReasons(db, { workerRunning: true, now: at(35) })[j4.id], undefined);
});
