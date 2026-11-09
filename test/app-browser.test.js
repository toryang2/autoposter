// The in-app browser route: accounts logged in inside the desktop app post from their own hidden window.
// The Electron side (electron/browser.js) is stood in for by a tiny control server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setup, addDestination, FAKE_CLAUDE } from './helpers.js';
import { runJob, buildArgs, parseResultBlock } from '../src/runner.js';
import { getJob, setAccountLogin, nowIso } from '../src/db.js';
import { recordOutcome } from '../src/worker.js';
import { buildPrompt } from '../src/prompt.js';
import { createApp } from '../src/server.js';

function addAccount(db, name, platform = 'facebook', login = 'connected') {
  return db.prepare(`INSERT INTO accounts(platform, name, profile_url, is_default, created_at, login_state)
    VALUES (?, ?, ?, (SELECT COUNT(*) = 0 FROM accounts WHERE platform = ?), ?, ?) RETURNING *`)
    .get(platform, name, `https://www.facebook.com/${name}`, platform, nowIso(), login);
}
function addJobFor(db, destId, accountId, status = 'queued') {
  const post = db.prepare("INSERT INTO posts(body, created_at) VALUES ('Hi', ?) RETURNING id").get(nowIso());
  return db.prepare('INSERT INTO jobs(post_id, destination_id, scheduled_at, account_id, status, attempts) VALUES (?, ?, ?, ?, ?, 1) RETURNING id')
    .get(post.id, destId, nowIso(), accountId, status).id;
}

// A stand-in for the app's control server: records session opens and closes.
function fakeControl(behaviour) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : {} });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.method === 'DELETE' ? { closed: true } : behaviour));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, calls, port: srv.address().port })));
}
function writeBrowserJson(p, port) {
  fs.writeFileSync(path.join(p.data, 'browser.json'), JSON.stringify({ port, token: 'main-token', exec: '/app/Electron', mcp: '/app/mcp-server.cjs', pid: process.pid }));
}

test('app mode args use only Autoposter\'s tools, never Chrome or --bare', () => {
  const args = buildArgs({ model: 'sonnet', workDir: '/w', browser: 'app', mcpConfigFile: '/w/mcp.json' });
  assert.ok(!args.includes('--chrome') && !args.includes('--bare'));
  assert.equal(args[args.indexOf('--mcp-config') + 1], '/w/mcp.json');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__autoposter__*');
  assert.ok(args.includes('--strict-mcp-config') && args.includes('Bash'));
});

test('needs_login is a valid reply', () => {
  assert.equal(parseResultBlock('```json\n{"status":"needs_login","clicked_post":false}\n```').status, 'needs_login');
});

test('a logged-in account posts through its own app window, and the window is closed afterwards', async () => {
  const { db, p } = setup();
  const ctl = await fakeControl({ token: 'job-token' });
  writeBrowserJson(p, ctl.port);
  const acct = addAccount(db, 'Shop');
  const d = addDestination(db, { type: 'group' });
  const job = getJob(db, addJobFor(db, d.id, acct.id));
  const record = path.join(p.home, 'rec.json');
  process.env.FAKE_MODE = 'success';
  process.env.FAKE_RECORD = record;
  let mcpSeen = null;
  const r = await runJob(job, [], { paths: p, settings: { model: 'sonnet', job_timeout_min: 1 }, claudeBin: FAKE_CLAUDE })
    .finally(() => { delete process.env.FAKE_RECORD; });
  const rec = JSON.parse(fs.readFileSync(record, 'utf8'));
  const cfgPath = rec.args[rec.args.indexOf('--mcp-config') + 1];
  mcpSeen = fs.existsSync(cfgPath);
  ctl.srv.close();
  assert.equal(r.result.status, 'submitted');
  assert.ok(!rec.args.includes('--chrome'));
  assert.match(rec.input, /autoposter browser tools/);
  assert.match(rec.input, /already logged in to the owner's Facebook account "Shop"/);
  assert.doesNotMatch(rec.input, /list_connected_browsers|tabs_close_mcp/);
  assert.deepEqual(ctl.calls.map((c) => c.method), ['POST', 'DELETE']);
  assert.equal(ctl.calls[0].auth, 'Bearer main-token');
  assert.equal(ctl.calls[0].body.account_id, acct.id);
  assert.equal(ctl.calls[1].body.token, 'job-token');
  assert.equal(mcpSeen, false, 'the MCP config with the job token is deleted after the run');
});

test('an expired login: Claude is not run, the post waits as Needs login without using a retry', async () => {
  const { db, p } = setup();
  const ctl = await fakeControl({ needs_login: true });
  writeBrowserJson(p, ctl.port);
  const acct = addAccount(db, 'Shop');
  const d = addDestination(db, { type: 'group' });
  const id = addJobFor(db, d.id, acct.id, 'running');
  const job = getJob(db, id);
  const out = await runJob(job, [], { paths: p, settings: { model: 'sonnet', job_timeout_min: 1 }, claudeBin: '/nonexistent/claude' });
  ctl.srv.close();
  assert.equal(out.result.status, 'needs_login');
  assert.equal(recordOutcome(db, job, out, { max_attempts: '2' }, new Date()), 'needs_login');
  const row = db.prepare('SELECT status, attempts, started_at FROM jobs WHERE id = ?').get(id);
  assert.deepEqual({ ...row }, { status: 'needs_login', attempts: 0, started_at: null });
  assert.equal(db.prepare('SELECT login_state FROM accounts WHERE id = ?').get(acct.id).login_state, 'needs_login');
});

test('logging in again puts only that account\'s waiting posts back in the queue', () => {
  const { db } = setup();
  const a = addAccount(db, 'A');
  const b = addAccount(db, 'B');
  const d = addDestination(db, { type: 'group' });
  const ja = addJobFor(db, d.id, a.id, 'needs_login');
  const jb = addJobFor(db, d.id, b.id, 'needs_login');
  assert.equal(setAccountLogin(db, a.id, 'connected'), 1);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').get(ja).status, 'queued');
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').get(jb).status, 'needs_login');
});

test('Needs login after Post was clicked is treated as Needs check', () => {
  const { db } = setup();
  const a = addAccount(db, 'A');
  const d = addDestination(db, { type: 'group' });
  const job = getJob(db, addJobFor(db, d.id, a.id, 'running'));
  const out = { kind: 'result', raw: null, result: { status: 'needs_login', clicked_post: true, post_url: null, note: 'x' } };
  assert.equal(recordOutcome(db, job, out, { max_attempts: '2' }, new Date()), 'needs_check');
});

test('accounts that never logged in inside the app keep the Chrome route', async () => {
  const { db, p } = setup();
  const acct = addAccount(db, 'Old', 'facebook', 'none');
  const d = addDestination(db, { type: 'group' });
  const job = getJob(db, addJobFor(db, d.id, acct.id));
  const record = path.join(p.home, 'rec.json');
  process.env.FAKE_MODE = 'success';
  process.env.FAKE_RECORD = record;
  await runJob(job, [], { paths: p, settings: { model: 'sonnet', job_timeout_min: 1 }, claudeBin: FAKE_CLAUDE })
    .finally(() => { delete process.env.FAKE_RECORD; });
  const rec = JSON.parse(fs.readFileSync(record, 'utf8'));
  assert.ok(rec.args.includes('--chrome'));
  assert.match(rec.input, /Use only the Chrome browser tools/);
});

test('app prompt for every platform: no Chrome tools, needs_login allowed', () => {
  for (const platform of ['facebook', 'instagram', 'tiktok', 'x', 'threads', 'linkedin', 'reddit']) {
    const prompt = buildPrompt({ destination_platform: platform, destination_type: 'profile', destination_url: 'https://example.com/me',
      destination_name: 'Me', post_body: 'Hi', account_name: 'Acc' }, ['/jobs/1/a.mp4'], {}, { browser: 'app' });
    assert.doesNotMatch(prompt, /list_connected_browsers|tabs_close_mcp|file_upload|Chrome/, platform);
    assert.match(prompt, /needs_login/, platform);
    assert.match(prompt, /upload tool/, platform);
  }
});

// ---- API: picking accounts per destination, and logging in
let server, base, ctx;
const loginCalls = [];
before(async () => {
  ctx = setup();
  const browser = {
    login: (a) => loginCalls.push(['login', a.id]),
    open: (a) => loginCalls.push(['open', a.id]),
    logout: async (a) => { loginCalls.push(['logout', a.id]); },
  };
  server = createApp(ctx.db, ctx.p, { browser }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('one post can go out from one, some or all accounts, per destination', async () => {
  const a = addAccount(ctx.db, 'A1');
  const b = addAccount(ctx.db, 'B1');
  const c = addAccount(ctx.db, 'C1');
  const g1 = addDestination(ctx.db, { name: 'G1', type: 'group' });
  const g2 = addDestination(ctx.db, { name: 'G2', type: 'group' });
  const form = new FormData();
  form.append('body', 'Hello all');
  form.append('scheduled_at', new Date(Date.now() + 3_600_000).toISOString());
  form.append('destination_ids', String(g1.id));
  form.append('destination_ids', String(g2.id));
  form.append('destination_accounts', JSON.stringify({ [g1.id]: [a.id, b.id, c.id], [g2.id]: [b.id] }));
  const res = await fetch(`${base}/api/posts`, { method: 'POST', body: form });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).jobs, 4);
  const jobs = (await (await fetch(`${base}/api/jobs`)).json()).filter((j) => j.post_body === 'Hello all');
  const pairs = jobs.map((j) => `${j.destination_name}:${j.account_name}`).sort();
  assert.deepEqual(pairs, ['G1:A1', 'G1:B1', 'G1:C1', 'G2:B1']);
});

test('an account from another platform cannot be picked for a destination', async () => {
  const x = addAccount(ctx.db, 'XAcc', 'x');
  const g = addDestination(ctx.db, { name: 'G3', type: 'group' });
  const form = new FormData();
  form.append('body', 'Nope');
  form.append('scheduled_at', new Date(Date.now() + 3_600_000).toISOString());
  form.append('destination_ids', String(g.id));
  form.append('destination_accounts', JSON.stringify({ [g.id]: [x.id] }));
  assert.equal((await fetch(`${base}/api/posts`, { method: 'POST', body: form })).status, 400);
});

test('Log in, Open and Log out go to the app browser; Log out marks the account not logged in', async () => {
  const a = addAccount(ctx.db, 'L1');
  assert.equal((await fetch(`${base}/api/accounts/app`).then((r) => r.json())).available, true);
  assert.equal((await fetch(`${base}/api/accounts/${a.id}/login`, { method: 'POST' })).status, 200);
  assert.equal((await fetch(`${base}/api/accounts/${a.id}/open`, { method: 'POST' })).status, 200);
  const list = await (await fetch(`${base}/api/accounts/${a.id}/logout`, { method: 'POST' })).json();
  assert.equal(list.find((x) => x.id === a.id).login_state, 'none');
  assert.deepEqual(loginCalls.filter((c) => c[1] === a.id).map((c) => c[0]), ['login', 'open', 'logout']);
});

test('removing an account cancels the posts still waiting to go out from it', async () => {
  const a = addAccount(ctx.db, 'R1');
  const g = addDestination(ctx.db, { name: 'G4', type: 'group' });
  const id = addJobFor(ctx.db, g.id, a.id, 'queued');
  assert.equal((await fetch(`${base}/api/accounts/${a.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(ctx.db.prepare('SELECT status FROM jobs WHERE id = ?').get(id).status, 'cancelled');
});

test('without the desktop app, logging in is refused', async () => {
  const s = setup();
  const srv = createApp(s.db, s.p).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const a = addAccount(s.db, 'N1');
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/accounts/${a.id}/login`, { method: 'POST' });
  srv.close();
  assert.equal(r.status, 409);
});

test('Setup counts an account logged in inside the app instead of the Chrome extension', async () => {
  const s = setup();
  const srv = createApp(s.db, s.p, { browser: {} }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}/api/setup`;
  addAccount(s.db, 'S1', 'facebook', 'connected');
  const setupState = await (await fetch(url)).json();
  srv.close();
  assert.equal(setupState.app_accounts, 1);
  assert.equal(setupState.readiness.checks.find((c) => c.id === 'extension').ok, true);
});
