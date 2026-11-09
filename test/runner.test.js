import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, FAKE_CLAUDE } from './helpers.js';
import { runJob, parseResultBlock, buildArgs, cleanEnv, cleanPostUrl, runTestAutomation, TEST_AUTOMATION_PROMPT } from '../src/runner.js';

const job = { id: 1, attempts: 1, destination_type: 'group', destination_name: 'Test Group',
  destination_url: 'https://www.facebook.com/groups/x', destination_audience: 'default', post_body: 'Hi there' };

async function run(mode, extra = {}) {
  const { p } = setup();
  process.env.FAKE_MODE = mode;
  return runJob(job, extra.media ?? [], { paths: p, settings: { model: 'sonnet', job_timeout_min: extra.timeout ?? 1 }, claudeBin: FAKE_CLAUDE });
}

test('parseResultBlock takes the last valid block and rejects bad ones', () => {
  assert.equal(parseResultBlock('no block'), null);
  assert.equal(parseResultBlock('```json\n{bad\n```'), null);
  assert.equal(parseResultBlock('```json\n{"status":"live","clicked_post":true}\n```'), null);
  assert.equal(parseResultBlock('```json\n{"status":"submitted"}\n```'), null, 'clicked_post required');
  const r = parseResultBlock('```json\n{"status":"failed","clicked_post":false}\n```\n```json\n{"status":"submitted","clicked_post":true,"note":"x"}\n```');
  assert.deepEqual(r, { status: 'submitted', clicked_post: true, post_url: null, note: 'x' });
});

test('args never use --bare and only allow Chrome tools', () => {
  const args = buildArgs({ model: 'sonnet', workDir: '/w' });
  assert.ok(!args.includes('--bare'));
  assert.ok(args.includes('--chrome') && args.includes('-p'));
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__claude-in-chrome__*');
  for (const t of ['Bash', 'Edit', 'Write', 'WebFetch']) assert.ok(args.includes(t));
});

test('billing env vars are stripped from the child', () => {
  const env = cleanEnv({ ANTHROPIC_API_KEY: 'x', CLAUDE_CODE_USE_BEDROCK: '1', HOME: '/h' });
  assert.deepEqual(env, { HOME: '/h' });
});

test('success, pending and failed outcomes', async () => {
  assert.equal((await run('success')).result.status, 'submitted');
  assert.equal((await run('pending')).result.status, 'pending_approval');
  const f = await run('failed_before');
  assert.equal(f.kind, 'result');
  assert.equal(f.result.clicked_post, false);
});

test('garbage output and crashes are ambiguous', async () => {
  assert.equal((await run('garbage')).kind, 'ambiguous');
  assert.equal((await run('crash')).kind, 'ambiguous');
});

test('usage limit is detected', async () => {
  assert.equal((await run('usage')).kind, 'usage_limit');
});

test('hang is killed by the timeout and is ambiguous', async () => {
  const r = await run('hang', { timeout: 0.01 });
  assert.equal(r.kind, 'ambiguous');
  assert.match(r.error, /Timed out/);
});

test('media is copied into the job folder and named in the prompt; API key not passed', async () => {
  const { p } = setup();
  const src = path.join(p.media, 'pic.jpg');
  fs.writeFileSync(src, 'x');
  const record = path.join(p.home, 'record.json');
  process.env.FAKE_MODE = 'success';
  process.env.FAKE_RECORD = record;
  process.env.ANTHROPIC_API_KEY = 'should-not-leak';
  try {
    await runJob(job, [{ path: src }], { paths: p, settings: { model: 'sonnet', job_timeout_min: 1 }, claudeBin: FAKE_CLAUDE });
  } finally {
    delete process.env.FAKE_RECORD;
    delete process.env.ANTHROPIC_API_KEY;
  }
  const rec = JSON.parse(fs.readFileSync(record, 'utf8'));
  const copied = path.join(p.jobs, '1', 'pic.jpg');
  assert.ok(fs.existsSync(copied));
  assert.ok(rec.input.includes(copied));
  assert.ok(rec.input.includes('Hi there'));
  assert.ok(!rec.env.includes('ANTHROPIC_API_KEY'));
});

test('post links: only https facebook.com, tracking params stripped', () => {
  assert.equal(cleanPostUrl('https://www.facebook.com/groups/123/posts/456/?__cft__[0]=abc&__tn__=%2CO%2CP-R'),
    'https://www.facebook.com/groups/123/posts/456/');
  assert.equal(cleanPostUrl('https://www.facebook.com/permalink.php?story_fbid=9&id=1&__tn__=x'),
    'https://www.facebook.com/permalink.php?story_fbid=9&id=1');
  assert.equal(cleanPostUrl('https://x.com/me/status/123?s=20&t=abc'), 'https://x.com/me/status/123');
  assert.equal(cleanPostUrl('https://www.reddit.com/r/test/comments/abc/title/?utm_source=share'), 'https://www.reddit.com/r/test/comments/abc/title/');
  assert.equal(cleanPostUrl('https://www.linkedin.com/feed/update/urn:li:activity:1/?trk=x'), 'https://www.linkedin.com/feed/update/urn:li:activity:1/');
  assert.equal(cleanPostUrl('https://example.com/post/1'), null);
  assert.equal(cleanPostUrl('#'), null);
  assert.equal(cleanPostUrl('javascript:alert(1)'), null);
  assert.equal(cleanPostUrl('https://evil.com/facebook.com/x'), null);
  assert.equal(cleanPostUrl('http://www.facebook.com/x'), null);
  assert.equal(cleanPostUrl('https://www.facebook.com/'), null);
  assert.equal(cleanPostUrl(null), null);
  assert.equal(cleanPostUrl('https://www.facebook.com/permalink.php?story_fbid=…&id=1'), null);
  assert.equal(cleanPostUrl('https://www.facebook.com/permalink.php?story_fbid=[REDACTED]&id=1'), null);
  const r = parseResultBlock('```json\n{"status":"submitted","clicked_post":true,"post_url":"https://www.facebook.com/x/posts/1?__cft__=z"}\n```');
  assert.equal(r.post_url, 'https://www.facebook.com/x/posts/1');
});

test('prompt asks for tab cleanup and skips link hunting', async () => {
  const { buildPrompt } = await import('../src/prompt.js');
  assert.doesNotMatch(buildPrompt(job, []), /Getting the post's link/);
  assert.match(buildPrompt(job, []), /close every tab you opened/);
});

test('each platform gets its own instructions; Reddit uses the first line as the title', async () => {
  const { buildPrompt } = await import('../src/prompt.js');
  const base = { destination_name: 'Dest', post_body: 'Title here\nBody', destination_audience: 'default' };
  const reddit = buildPrompt({ ...base, destination_platform: 'reddit', destination_type: 'group', destination_url: 'https://www.reddit.com/r/test/' }, []);
  assert.match(reddit, /ONE Reddit post/);
  assert.match(reddit, /FIRST LINE of the post text as the title/);
  assert.match(reddit, /https:\/\/www\.reddit\.com\/r\/test\/submit/);
  assert.match(reddit, /Stay on reddit\.com/);
  assert.doesNotMatch(reddit, /facebook/i);
  for (const [platform, re] of [['linkedin', /Start a post/], ['x', /What is happening/], ['threads', /What's new/],
    ['instagram', /Share once/], ['tiktok', /tiktokstudio\/upload/]]) {
    const p = buildPrompt({ ...base, destination_platform: platform, destination_type: 'profile', destination_url: 'https://example/' }, []);
    assert.match(p, re, platform);
    assert.doesNotMatch(p, /facebook/i, platform);
  }
  const fb = buildPrompt({ ...base, destination_type: 'group', destination_url: 'https://www.facebook.com/groups/x' }, []);
  assert.match(fb, /ONE Facebook post/, 'jobs without a platform are Facebook');
});

test('a Facebook group set to post as a Page switches to it and never falls back to the profile', async () => {
  const { buildPrompt } = await import('../src/prompt.js');
  const g = { destination_platform: 'facebook', destination_type: 'group', destination_name: 'G', destination_url: 'https://www.facebook.com/groups/g', post_body: 'Hi' };
  const asPage = buildPrompt({ ...g, destination_post_as: 'My Shop' }, []);
  assert.match(asPage, /POST AS THE PAGE "My Shop"/);
  assert.match(asPage, /do NOT post as the owner instead/);
  assert.doesNotMatch(buildPrompt(g, []), /POST AS THE PAGE/);
});

test('the post\'s own "Who" beats the group setting; "@self" posts as the person', async () => {
  const { buildPrompt } = await import('../src/prompt.js');
  const g = { destination_platform: 'facebook', destination_type: 'group', destination_name: 'G', destination_url: 'https://www.facebook.com/groups/g', post_body: 'Hi', destination_post_as: 'Group Page' };
  assert.match(buildPrompt({ ...g, post_as: 'Other Page' }, []), /POST AS THE PAGE "Other Page"/);
  assert.doesNotMatch(buildPrompt({ ...g, post_as: '@self' }, []), /POST AS THE PAGE/);
  assert.match(buildPrompt(g, []), /POST AS THE PAGE "Group Page"/);
});

test('a first comment is added after the post is live, and asked for in the report', async () => {
  const { buildPrompt } = await import('../src/prompt.js');
  const g = { destination_platform: 'facebook', destination_type: 'group', destination_name: 'G', destination_url: 'https://www.facebook.com/groups/g', post_body: 'Hi' };
  const withComment = buildPrompt({ ...g, first_comment: 'Get it here: https://example.com' }, []);
  assert.match(withComment, /FIRST COMMENT/);
  assert.match(withComment, /<<<COMMENT_TEXT\nGet it here: https:\/\/example\.com\nCOMMENT_TEXT>>>/);
  assert.match(withComment, /"commented":true\|false/);
  assert.doesNotMatch(buildPrompt(g, []), /FIRST COMMENT|commented/);
  assert.equal(parseResultBlock('```json\n{"status":"submitted","clicked_post":true,"post_url":null,"commented":false,"note":"x"}\n```').commented, false);
});

test('setup test automation: passes when Claude drives Chrome, fails with the reason otherwise', async () => {
  const { p } = setup();
  const record = path.join(p.home, 'record.json');
  process.env.FAKE_RECORD = record;
  process.env.FAKE_MODE = 'automation_ok';
  let r;
  try { r = await runTestAutomation(FAKE_CLAUDE, p); } finally { delete process.env.FAKE_RECORD; }
  assert.deepEqual(r, { ok: true, facebook_signed_in: true, note: 'Feed visible', error: null });
  const rec = JSON.parse(fs.readFileSync(record, 'utf8'));
  assert.ok(rec.args.includes('--chrome') && !rec.args.includes('--bare'));
  assert.equal(rec.input, TEST_AUTOMATION_PROMPT);
  assert.match(TEST_AUTOMATION_PROMPT, /Do NOT post/);
  assert.ok(fs.existsSync(path.join(p.logs, 'setup-test.json')));

  process.env.FAKE_MODE = 'automation_no_chrome';
  r = await runTestAutomation(FAKE_CLAUDE, p);
  assert.equal(r.ok, false);
  assert.match(r.error, /No browser/);
  for (const mode of ['garbage', 'crash', 'usage']) {
    process.env.FAKE_MODE = mode;
    assert.equal((await runTestAutomation(FAKE_CLAUDE, p)).ok, false, mode);
  }
  process.env.FAKE_MODE = 'hang';
  r = await runTestAutomation(FAKE_CLAUDE, p, { timeoutMs: 50 });
  assert.equal(r.ok, false);
  assert.match(r.error, /did not finish/);
});

test('files over 10 MB never go through Chrome: the post fails before Claude runs, saying to log in inside the app', async () => {
  const { p } = setup();
  const src = path.join(p.media, 'big.mp4');
  fs.writeFileSync(src, Buffer.alloc(10 * 1024 * 1024 + 1));
  const job = { id: 77, attempts: 1, account_name: 'Shop', destination_name: 'G', destination_type: 'group', destination_url: 'https://www.facebook.com/groups/1', destination_platform: 'facebook', post_body: 'x' };
  const r = await runJob(job, [{ path: src, size_bytes: 10 * 1024 * 1024 + 1 }], { paths: p, settings: { model: 'sonnet', job_timeout_min: 1 }, claudeBin: FAKE_CLAUDE });
  assert.equal(r.result.status, 'failed');
  assert.equal(r.result.clicked_post, false);
  assert.match(r.result.note, /over 10 MB[\s\S]*inside the Autoposter app/);
});
