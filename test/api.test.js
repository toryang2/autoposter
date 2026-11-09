import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, addDestination, addJob, FAKE_CLAUDE } from './helpers.js';
import { createApp } from '../src/server.js';

let server, base, db;
before(async () => {
  const s = setup();
  db = s.db;
  server = createApp(s.db, s.p).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const json = (method, url, body) => fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('destinations CRUD and validation', async () => {
  assert.equal((await json('POST', '/api/destinations', { name: 'X', type: 'page', url: 'https://evil.com/x' })).status, 400);
  const r = await json('POST', '/api/destinations', { name: 'My Page', type: 'page', url: 'https://www.facebook.com/mypage' });
  assert.equal(r.status, 201);
  const d = await r.json();
  assert.equal((await json('POST', '/api/destinations', { name: 'Dup', type: 'page', url: 'https://www.facebook.com/mypage' })).status, 409);
  const patched = await (await json('PATCH', `/api/destinations/${d.id}`, { enabled: false })).json();
  assert.equal(patched.enabled, 0);
  assert.equal((await fetch(`${base}/api/destinations/${d.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await (await fetch(`${base}/api/destinations`)).json()).length, 0);
});

test('other platforms: URLs are checked and media rules apply per platform', async () => {
  assert.equal((await json('POST', '/api/destinations', { name: 'R', platform: 'reddit', type: 'group', url: 'https://www.facebook.com/x' })).status, 400);
  assert.equal((await json('POST', '/api/destinations', { name: 'T', platform: 'tiktok', type: 'group', url: 'https://www.tiktok.com/@me' })).status, 400);
  assert.equal((await json('POST', '/api/destinations', { name: 'M', platform: 'myspace', type: 'profile', url: 'https://myspace.com/me' })).status, 400);
  const r = await json('POST', '/api/destinations', { name: 'r/ph', platform: 'reddit', type: 'group', url: 'https://www.reddit.com/r/Philippines', audience: 'public' });
  assert.equal(r.status, 201);
  const d = await r.json();
  assert.equal(d.platform, 'reddit');
  assert.equal(d.audience, 'default');
  const x = await json('POST', '/api/destinations', { name: 'X', platform: 'x', type: 'profile', url: 'https://twitter.com/me' });
  assert.equal(x.status, 201);
  const xId = (await x.json()).id;
  const ig = await (await json('POST', '/api/destinations', { name: 'IG', platform: 'instagram', type: 'profile', url: 'https://www.instagram.com/me' })).json();
  const schedule = (ids, files = []) => {
    const form = new FormData();
    form.append('body', 'Title\nhi');
    form.append('scheduled_at', new Date(Date.now() + 86_400_000).toISOString());
    for (const id of ids) form.append('destination_ids', String(id));
    for (const f of files) form.append('media', f);
    return fetch(`${base}/api/posts`, { method: 'POST', body: form });
  };
  assert.equal((await schedule([d.id, xId])).status, 201, 'Reddit and X accept text-only posts');
  const noMedia = await schedule([ig.id]);
  assert.equal(noMedia.status, 400);
  assert.match((await noMedia.json()).error, /Instagram needs a photo or a video/);
  const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'a.png', { type: 'image/png' });
  const tooMany = await schedule([xId], [png(), png(), png(), png(), png()]);
  assert.equal(tooMany.status, 400);
  assert.match((await tooMany.json()).error, /X takes at most 4 photos/);
  assert.equal((await schedule([ig.id], [png()])).status, 201);
  for (const id of [d.id, xId, ig.id]) await fetch(`${base}/api/destinations/${id}`, { method: 'DELETE' });
});

test('scheduling a post with an image to two destinations creates two jobs', async () => {
  const a = await (await json('POST', '/api/destinations', { name: 'A', type: 'group', url: 'https://www.facebook.com/groups/a' })).json();
  const b = await (await json('POST', '/api/destinations', { name: 'B', type: 'profile', url: 'https://www.facebook.com/me', audience: 'only_me' })).json();
  const form = new FormData();
  form.append('body', 'Hello world');
  form.append('scheduled_at', new Date(Date.now() + 3600e3).toISOString());
  form.append('destination_ids', String(a.id));
  form.append('destination_ids', String(b.id));
  form.append('media', new Blob([new Uint8Array(1000)], { type: 'image/jpeg' }), 'photo.jpg');
  const r = await fetch(`${base}/api/posts`, { method: 'POST', body: form });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).jobs, 2);
  const jobs = await (await fetch(`${base}/api/jobs?status=queued`)).json();
  assert.equal(jobs.length, 2);
  const inRange = (from, to) => fetch(`${base}/api/jobs?from=${from.toISOString()}&to=${to.toISOString()}`).then((r) => r.json());
  assert.equal((await inRange(new Date(), new Date(Date.now() + 2 * 3600e3))).length, 2);
  assert.equal((await inRange(new Date(Date.now() + 2 * 3600e3), new Date(Date.now() + 9 * 3600e3))).length, 0);
  assert.equal((await fetch(`${base}/api/jobs?from=nope`)).status, 400);
  const media = await (await fetch(`${base}/api/posts/${jobs[0].post_id}/media`)).json();
  assert.equal(media.length, 1);
  assert.equal((await fetch(base + media[0].url)).status, 200);
  // removing a destination with queued jobs cancels them and archives it
  await fetch(`${base}/api/destinations/${a.id}`, { method: 'DELETE' });
  const after = await (await fetch(`${base}/api/jobs`)).json();
  assert.equal(after.find((j) => j.destination_id === a.id).status, 'cancelled');
});

test('files over 10 MB are refused with a message', async () => {
  const d = await (await json('POST', '/api/destinations', { name: 'C', type: 'page', url: 'https://www.facebook.com/c' })).json();
  const form = new FormData();
  form.append('body', 'big');
  form.append('scheduled_at', new Date().toISOString());
  form.append('destination_ids', String(d.id));
  form.append('media', new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'video/mp4' }), 'big.mp4');
  const r = await fetch(`${base}/api/posts`, { method: 'POST', body: form });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /10 MB/);
});

test('job transitions: cancel queued, retry cancelled, cannot mark queued as posted', async () => {
  const jobs = await (await fetch(`${base}/api/jobs?status=queued`)).json();
  const id = jobs[0].id;
  assert.equal((await fetch(`${base}/api/jobs/${id}/mark-posted`, { method: 'POST' })).status, 409);
  assert.equal((await (await fetch(`${base}/api/jobs/${id}/cancel`, { method: 'POST' })).json()).status, 'cancelled');
  assert.equal((await (await fetch(`${base}/api/jobs/${id}/retry`, { method: 'POST' })).json()).status, 'queued');
});

test('a post link can be set, cleaned and cleared', async () => {
  const [job] = await (await fetch(`${base}/api/jobs`)).json();
  assert.equal((await json('POST', `/api/jobs/${job.id}/link`, { url: 'https://evil.com/x' })).status, 400);
  const set = await (await json('POST', `/api/jobs/${job.id}/link`, { url: 'https://www.facebook.com/groups/a/posts/1/?__cft__=z' })).json();
  assert.equal(set.post_url, 'https://www.facebook.com/groups/a/posts/1/');
  assert.equal((await (await json('POST', `/api/jobs/${job.id}/link`, { url: '' })).json()).post_url, null);
  assert.equal((await json('POST', '/api/jobs/99999/link', { url: '' })).status, 404);
});

test('settings are validated', async () => {
  assert.equal((await json('PUT', '/api/settings', { daily_cap: 0 })).status, 400);
  assert.equal((await json('PUT', '/api/settings', { model: 'gpt' })).status, 400);
  const s = await (await json('PUT', '/api/settings', { daily_cap: 5, model: 'opus' })).json();
  assert.equal(s.daily_cap, '5');
  const st = await (await fetch(`${base}/api/status`)).json();
  assert.equal(st.worker_running, false);
});

test('post now: refused for non-queued jobs and while another post is publishing', async () => {
  const d = addDestination(db);
  const later = new Date(Date.now() + 86_400_000);
  const a = addJob(db, d.id, later);
  const b = addJob(db, addDestination(db).id, later);
  await fetch(`${base}/api/jobs/${a.id}/cancel`, { method: 'POST' });
  assert.equal((await fetch(`${base}/api/jobs/${a.id}/post-now`, { method: 'POST' })).status, 409);
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(a.id);
  assert.equal((await fetch(`${base}/api/jobs/${b.id}/post-now`, { method: 'POST' })).status, 409);
  assert.equal(db.prepare('SELECT force_now FROM jobs WHERE id = ?').get(b.id).force_now, 0);
  db.prepare("UPDATE jobs SET status = 'cancelled' WHERE id IN (?, ?)").run(a.id, b.id);
});

test('jobs for a removed destination cannot be retried; failed jobs can be removed with their post', async () => {
  const d = addDestination(db);
  const job = addJob(db, d.id, new Date(Date.now() + 86_400_000));
  db.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(job.id);
  const queued = addJob(db, d.id, new Date(Date.now() + 86_400_000));
  assert.equal((await fetch(`${base}/api/destinations/${d.id}`, { method: 'DELETE' })).status, 204);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').get(queued.id).status, 'cancelled');
  const listed = (await (await fetch(`${base}/api/jobs`)).json()).find((j) => j.id === job.id);
  assert.equal(listed.destination_archived, 1);
  assert.equal((await fetch(`${base}/api/jobs/${job.id}/retry`, { method: 'POST' })).status, 409);
  assert.equal((await fetch(`${base}/api/jobs/${job.id}/post-now`, { method: 'POST' })).status, 409);

  assert.equal((await fetch(`${base}/api/jobs/${job.id}`, { method: 'DELETE' })).status, 204);
  assert.equal(db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(job.id), undefined);
  assert.equal(db.prepare('SELECT 1 FROM posts WHERE id = ?').get(job.post_id), undefined);

  const live = addJob(db, addDestination(db).id, new Date(Date.now() + 86_400_000));
  assert.equal((await fetch(`${base}/api/jobs/${live.id}`, { method: 'DELETE' })).status, 409, 'queued jobs are not removable');
  db.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ?").run(live.id);
});

test('Facebook groups can be set to post as a Page; other destinations cannot', async () => {
  const g = await (await json('POST', '/api/destinations', { name: 'G', type: 'group', url: 'https://www.facebook.com/groups/asPage', post_as: '  My Shop  ' })).json();
  assert.equal(g.post_as, 'My Shop');
  const cleared = await (await json('PATCH', `/api/destinations/${g.id}`, { post_as: '' })).json();
  assert.equal(cleared.post_as, null);
  const set = await (await json('PATCH', `/api/destinations/${g.id}`, { post_as: 'Other Page' })).json();
  assert.equal(set.post_as, 'Other Page');
  const kept = await (await json('PATCH', `/api/destinations/${g.id}`, { enabled: false })).json();
  assert.equal(kept.post_as, 'Other Page', 'other updates keep the choice');
  const page = await json('POST', '/api/destinations', { name: 'P', type: 'page', url: 'https://www.facebook.com/somePage', post_as: 'X' });
  assert.equal(page.status, 400);
  await fetch(`${base}/api/destinations/${g.id}`, { method: 'DELETE' });
});

test('Compose "Who" sets who posts in Facebook groups only', async () => {
  const g = await (await json('POST', '/api/destinations', { name: 'WG', type: 'group', url: 'https://www.facebook.com/groups/whoTest', post_as: 'Group Default Page' })).json();
  const pf = await (await json('POST', '/api/destinations', { name: 'WP', type: 'profile', url: 'https://www.facebook.com/whoProfile' })).json();
  const schedule = async (who) => {
    const form = new FormData();
    form.append('body', 'hi');
    form.append('scheduled_at', new Date(Date.now() + 86_400_000).toISOString());
    form.append('destination_ids', String(g.id));
    form.append('destination_ids', String(pf.id));
    if (who !== undefined) form.append('post_as', who);
    const r = await fetch(`${base}/api/posts`, { method: 'POST', body: form });
    assert.equal(r.status, 201);
    return db.prepare('SELECT d.type, j.post_as FROM jobs j JOIN destinations d ON d.id = j.destination_id WHERE j.post_id = ? ORDER BY d.type').all((await r.json()).id);
  };
  assert.deepEqual((await schedule('My Shop')).map((r) => r.post_as), ['My Shop', null], 'only the group gets the Page');
  assert.deepEqual((await schedule('@self')).map((r) => r.post_as), ['@self', null]);
  assert.deepEqual((await schedule()).map((r) => r.post_as), [null, null], 'no choice keeps the group setting');
  for (const id of [g.id, pf.id]) await fetch(`${base}/api/destinations/${id}`, { method: 'DELETE' });
});

test('readiness: four checks, and the worker and test automation are refused until the earlier steps pass', async () => {
  process.env.CLAUDE_BIN = FAKE_CLAUDE; // reports "not logged in"
  try {
    const s = await (await fetch(`${base}/api/setup`)).json();
    assert.deepEqual(s.readiness.checks.map((c) => c.id), ['installed', 'auth', 'extension', 'automation']);
    assert.equal(s.readiness.checks[0].ok, true);
    assert.equal(s.readiness.checks[1].ok, false);
    assert.equal(s.readiness.ready, false);
    const start = await fetch(`${base}/api/worker/start`, { method: 'POST' });
    assert.equal(start.status, 409);
    assert.match((await start.json()).error, /Setup isn't finished/);
    const t = await fetch(`${base}/api/setup/test-automation`, { method: 'POST' });
    assert.equal(t.status, 409);
    assert.match((await t.json()).error, /log in with a Claude/);
  } finally {
    delete process.env.CLAUDE_BIN;
  }
});

test('update check is off outside the desktop app', async () => {
  const r = await (await fetch(`${base}/api/update`)).json();
  assert.equal(r.available, false);
  assert.match(r.current, /^\d+\.\d+\.\d+/);
});
