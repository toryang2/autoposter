import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, addDestination } from './helpers.js';
import { createApp } from '../src/server.js';
import { openDb, getJob, setSetting, savePages } from '../src/db.js';
import { buildPrompt } from '../src/prompt.js';

let server, base, db, p;
before(async () => {
  const s = setup();
  ({ db, p } = s);
  server = createApp(db, p).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const json = (method, url, body) => fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('accounts: first per platform is default, links are checked, default can move', async () => {
  assert.equal((await json('POST', '/api/accounts', { name: 'Bad', profile_url: 'https://evil.com/me' })).status, 400);
  const a = await (await json('POST', '/api/accounts', { name: 'Ruel', profile_url: 'https://facebook.com/ruel.nopal.5/' })).json();
  assert.equal(a.is_default, 1);
  assert.equal(a.profile_url, 'https://www.facebook.com/ruel.nopal.5');
  const b = await (await json('POST', '/api/accounts', { name: 'Shop', profile_url: 'https://www.facebook.com/profile.php?id=1000578413' })).json();
  assert.equal(b.is_default, 0);
  assert.equal((await json('POST', '/api/accounts', { name: 'Dup', profile_url: 'https://www.facebook.com/ruel.nopal.5' })).status, 409);
  const list = await (await json('PATCH', `/api/accounts/${b.id}`, { is_default: true })).json();
  assert.deepEqual(list.filter((x) => x.is_default).map((x) => x.id), [b.id]);
});

test('a post can pick the account; others use the default; the prompt names the chosen account', async () => {
  const accounts = await (await fetch(`${base}/api/accounts`)).json();
  const ruel = accounts.find((a) => a.name === 'Ruel');
  const group = addDestination(db, { name: 'G', type: 'group' });
  const form = new FormData();
  form.append('body', 'Hello');
  form.append('scheduled_at', new Date(Date.now() + 3_600_000).toISOString());
  form.append('destination_ids', String(group.id));
  form.append('account_ids', String(ruel.id));
  assert.equal((await fetch(`${base}/api/posts`, { method: 'POST', body: form })).status, 201);
  const jobs = await (await fetch(`${base}/api/jobs`)).json();
  assert.equal(jobs[0].account_name, 'Ruel');
  const job = getJob(db, jobs[0].id);
  assert.equal(job.account_url, 'https://www.facebook.com/ruel.nopal.5');
  const prompt = buildPrompt(job, [], {});
  assert.match(prompt, /"Ruel" \(https:\/\/www\.facebook\.com\/ruel\.nopal\.5\)/);
  assert.match(prompt, /Switch accounts/);

  // Without a pick, the job follows the platform's default (Shop, made default above).
  const form2 = new FormData();
  form2.append('body', 'Hi');
  form2.append('scheduled_at', new Date(Date.now() + 7_200_000).toISOString());
  form2.append('destination_ids', String(group.id));
  // Same post+destination pair is unique per post, so this is a new post.
  assert.equal((await fetch(`${base}/api/posts`, { method: 'POST', body: form2 })).status, 201);
  const latest = (await (await fetch(`${base}/api/jobs`)).json()).find((j) => j.post_body === 'Hi');
  assert.equal(latest.account_name, 'Shop');
});

test('removing an account moves the default and frees jobs that picked it', async () => {
  const accounts = await (await fetch(`${base}/api/accounts`)).json();
  const shop = accounts.find((a) => a.name === 'Shop');
  const left = await (await fetch(`${base}/api/accounts/${shop.id}`, { method: 'DELETE' })).json();
  assert.equal(left.length, 1);
  assert.equal(left[0].is_default, 1);
});

test('the old single Facebook account setting becomes the default account', () => {
  const s = setup();
  setSetting(s.db, 'fb_account_url', 'https://www.facebook.com/old.me');
  const again = openDb(s.p.db);
  const rows = again.prepare('SELECT * FROM accounts').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].profile_url, 'https://www.facebook.com/old.me');
  assert.equal(rows[0].is_default, 1);
});

test('a saved profile picture is listed and served, and goes away with the account', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const acc = await (await json('POST', '/api/accounts', { name: 'Pic', profile_url: 'https://www.facebook.com/pic.person' })).json();
  assert.equal((await fetch(`${base}/api/accounts/${acc.id}/avatar`)).status, 404);
  fs.mkdirSync(path.join(p.data, 'avatars'), { recursive: true });
  fs.writeFileSync(path.join(p.data, 'avatars', `${acc.id}.img`), Buffer.alloc(800, 1));
  const listed = (await (await fetch(`${base}/api/accounts`)).json()).find((a) => a.id === acc.id);
  assert.ok(listed.avatar_v > 0);
  const img = await fetch(`${base}/api/accounts/${acc.id}/avatar`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  await fetch(`${base}/api/accounts/${acc.id}`, { method: 'DELETE' });
  assert.equal(fs.existsSync(path.join(p.data, 'avatars', `${acc.id}.img`)), false);
});

test("an account's own profile becomes a place to post, and only that account posts there", async () => {
  const li = await (await json('POST', '/api/accounts', { platform: 'linkedin', name: 'Me LI', profile_url: 'https://www.linkedin.com/in/me-li' })).json();
  await json('POST', '/api/accounts', { platform: 'linkedin', name: 'Other LI', profile_url: 'https://www.linkedin.com/in/other-li' });
  const dest = (await (await fetch(`${base}/api/destinations`)).json()).find((d) => d.url === 'https://www.linkedin.com/in/me-li');
  assert.ok(dest);
  assert.equal(dest.type, 'profile');
  const form = new FormData();
  form.append('body', 'LI post');
  form.append('scheduled_at', new Date(Date.now() + 3_600_000).toISOString());
  form.append('destination_ids', String(dest.id));
  const r = await (await fetch(`${base}/api/posts`, { method: 'POST', body: form })).json();
  assert.equal(r.jobs, 1);
  const job = (await (await fetch(`${base}/api/jobs`)).json()).find((j) => j.post_body === 'LI post');
  assert.equal(job.account_name, li.name);
});

test('a queued post can be edited; a post shared with other places gets its own copy', async () => {
  const g1 = addDestination(db, { name: 'E1', type: 'group' });
  const g2 = addDestination(db, { name: 'E2', type: 'group' });
  const form = new FormData();
  form.append('body', 'Original');
  form.append('first_comment', 'Link');
  form.append('scheduled_at', new Date(Date.now() + 3_600_000).toISOString());
  form.append('destination_ids', String(g1.id));
  form.append('destination_ids', String(g2.id));
  form.append('media', new Blob([Buffer.alloc(600, 7)], { type: 'image/png' }), 'pic.png');
  assert.equal((await fetch(`${base}/api/posts`, { method: 'POST', body: form })).status, 201);
  const jobs = (await (await fetch(`${base}/api/jobs`)).json()).filter((j) => j.post_body === 'Original');
  assert.equal(jobs.length, 2);
  const when = new Date(Date.now() + 7_200_000).toISOString();
  const r = await json('PATCH', `/api/jobs/${jobs[0].id}`, { body: 'Edited', first_comment: '', scheduled_at: when });
  assert.equal(r.status, 200);
  const edited = await r.json();
  assert.equal(edited.post_body, 'Edited');
  assert.equal(edited.first_comment, null);
  assert.equal(edited.scheduled_at, when);
  assert.notEqual(edited.post_id, jobs[0].post_id);
  const other = (await (await fetch(`${base}/api/jobs`)).json()).find((j) => j.id === jobs[1].id);
  assert.equal(other.post_body, 'Original');
  const media = await (await fetch(`${base}/api/posts/${edited.post_id}/media`)).json();
  assert.equal(media.length, 1);
  // A post that went out can't be edited.
  db.prepare("UPDATE jobs SET status = 'submitted' WHERE id = ?").run(jobs[1].id);
  assert.equal((await json('PATCH', `/api/jobs/${jobs[1].id}`, { body: 'x' })).status, 409);
});

test('editing can remove a photo and add another', async () => {
  const g = addDestination(db, { name: 'M1', type: 'group' });
  const form = new FormData();
  form.append('body', 'With photo');
  form.append('scheduled_at', new Date(Date.now() + 3_600_000).toISOString());
  form.append('destination_ids', String(g.id));
  form.append('media', new Blob([Buffer.alloc(600, 1)], { type: 'image/png' }), 'a.png');
  form.append('media', new Blob([Buffer.alloc(600, 2)], { type: 'image/png' }), 'b.png');
  await fetch(`${base}/api/posts`, { method: 'POST', body: form });
  const job = (await (await fetch(`${base}/api/jobs`)).json()).find((j) => j.post_body === 'With photo');
  const before = await (await fetch(`${base}/api/posts/${job.post_id}/media`)).json();
  assert.equal(before.length, 2);
  const edit = new FormData();
  edit.append('body', 'With photo');
  edit.append('keep_media', JSON.stringify([before[0].id]));
  edit.append('media', new Blob([Buffer.alloc(700, 3)], { type: 'image/jpeg' }), 'c.jpg');
  const r = await fetch(`${base}/api/jobs/${job.id}`, { method: 'PATCH', body: edit });
  assert.equal(r.status, 200);
  const after = await (await fetch(`${base}/api/posts/${(await r.json()).post_id}/media`)).json();
  assert.equal(after.length, 2);
  assert.equal(after[0].id, before[0].id);
  // A video can't join photos.
  const bad = new FormData();
  bad.append('media', new Blob([Buffer.alloc(700, 4)], { type: 'video/mp4' }), 'v.mp4');
  assert.equal((await fetch(`${base}/api/jobs/${job.id}`, { method: 'PATCH', body: bad })).status, 400);
});

test('Post now can pick the account, but only one on the same platform', async () => {
  const fb = await (await json('POST', '/api/accounts', { name: 'FB Two', profile_url: 'https://www.facebook.com/fb.two' })).json();
  const li = (await (await fetch(`${base}/api/accounts`)).json()).find((a) => a.platform === 'linkedin');
  const g = addDestination(db, { name: 'PN', type: 'group' });
  const form = new FormData();
  form.append('body', 'Post now pick');
  form.append('scheduled_at', new Date(Date.now() + 3_600_000).toISOString());
  form.append('destination_ids', String(g.id));
  await fetch(`${base}/api/posts`, { method: 'POST', body: form });
  const job = (await (await fetch(`${base}/api/jobs`)).json()).find((j) => j.post_body === 'Post now pick');
  const fs = await import('node:fs');
  fs.writeFileSync(p.lock, String(process.pid)); // looks like a running worker, so nothing is started
  try {
    assert.equal((await json('POST', `/api/jobs/${job.id}/post-now`, { account_id: li.id })).status, 400);
    assert.equal(getJob(db, job.id).force_now, 0);
    assert.equal((await json('POST', `/api/jobs/${job.id}/post-now`, { account_id: fb.id })).status, 200);
    const after = (await (await fetch(`${base}/api/jobs`)).json()).find((j) => j.id === job.id);
    assert.equal(after.account_ref, fb.id);
    assert.equal(after.force_now, 1);
  } finally {
    fs.rmSync(p.lock, { force: true });
    db.prepare("UPDATE jobs SET status = 'cancelled', force_now = 0 WHERE id = ?").run(job.id);
  }
});

test("an account's Pages are listed under it, can post in groups as the Page, and a Page added as an account needs no login", async () => {
  const acc = await (await json('POST', '/api/accounts', { name: 'Pager', profile_url: 'https://www.facebook.com/pager.person' })).json();
  const asAccount = await (await json('POST', '/api/accounts', { name: 'Shop Page', profile_url: 'https://www.facebook.com/shop.page' })).json();
  savePages(db, acc.id, [{ fb_page_id: '111', name: 'Shop Page', url: 'https://www.facebook.com/shop.page' }, { fb_page_id: '222', name: 'Blog', url: 'https://www.facebook.com/blog.page' }]);
  let list = await (await fetch(`${base}/api/accounts`)).json();
  const me = list.find((a) => a.id === acc.id);
  assert.deepEqual(me.pages.map((pg) => pg.name), ['Blog', 'Shop Page']);
  assert.deepEqual(list.find((a) => a.id === asAccount.id).page_of, { id: acc.id, name: 'Pager' });
  // Its auto-made "profile" destination is really a Page.
  assert.equal((await (await fetch(`${base}/api/destinations`)).json()).find((d) => d.url === 'https://www.facebook.com/shop.page').type, 'page');
  // Adding a known Page works, as a Page of its account (no login needed), and its place to post is a Page.
  const added = await json('POST', '/api/accounts', { name: 'Blog', profile_url: 'https://www.facebook.com/blog.page' });
  assert.equal(added.status, 201);
  assert.deepEqual((await added.json()).page_of, { id: acc.id, name: 'Pager' });
  assert.equal((await (await fetch(`${base}/api/destinations`)).json()).find((d) => d.url === 'https://www.facebook.com/blog.page').type, 'page');

  const blog = me.pages.find((pg) => pg.name === 'Blog');
  const g = addDestination(db, { name: 'PG', type: 'group' });
  const form = new FormData();
  form.append('body', 'As a Page');
  form.append('scheduled_at', new Date(Date.now() + 3_600_000).toISOString());
  form.append('destination_ids', String(g.id));
  form.append('destination_accounts', JSON.stringify({ [g.id]: [acc.id, `p${blog.id}`] }));
  assert.equal((await fetch(`${base}/api/posts`, { method: 'POST', body: form })).status, 201);
  const jobs = (await (await fetch(`${base}/api/jobs`)).json()).filter((j) => j.post_body === 'As a Page');
  assert.deepEqual(jobs.map((j) => j.post_as).sort(), ['Blog', null].sort());
  assert.ok(jobs.every((j) => j.account_ref === acc.id));
  // Pages that disappear from Facebook's list go away.
  savePages(db, acc.id, [{ fb_page_id: '222', name: 'Blog', url: 'https://www.facebook.com/blog.page' }]);
  list = await (await fetch(`${base}/api/accounts`)).json();
  assert.equal(list.find((a) => a.id === acc.id).pages.length, 1);
});

test('a destination can be edited: name, link and kind', async () => {
  const d = addDestination(db, { name: 'Old', type: 'group' });
  const r = await json('PATCH', `/api/destinations/${d.id}`, { name: 'New name', url: 'https://www.facebook.com/groups/999888/', type: 'page' });
  assert.equal(r.status, 200);
  const row = await r.json();
  assert.equal(row.name, 'New name');
  assert.equal(row.url, 'https://www.facebook.com/groups/999888');
  assert.equal(row.type, 'page');
  assert.equal((await json('PATCH', `/api/destinations/${d.id}`, { url: 'https://evil.com/x' })).status, 400);
});
