import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildPrompt, buildCheckPrompt } from './prompt.js';
import { ALL_HOSTS } from './platforms.js';
import { findClaude, spawnClaude, envWithClaude, killTree } from './platform.js';
import { CHROME_MAX_BYTES } from './config.js';
import { SLOP_RULES, findSlop } from './slop.js';

// Anything here would switch Claude Code off the subscription login and onto paid API billing.
const BILLING_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
];

const DENIED_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent'];

// browser 'chrome': the person's Chrome through the Claude in Chrome extension.
// browser 'app': Autoposter's own hidden window for one account, through the MCP server described in mcpConfigFile.
export function buildArgs({ model, workDir, browser = 'chrome', mcpConfigFile = null }) {
  const tools = browser === 'app'
    ? ['--mcp-config', mcpConfigFile, '--allowedTools', 'mcp__autoposter__*']
    : ['--chrome', '--allowedTools', 'mcp__claude-in-chrome__*'];
  return [
    '-p', '--no-session-persistence', '--output-format', 'json',
    '--model', model,
    '--strict-mcp-config', '--disable-slash-commands',
    '--add-dir', workDir,
    ...tools,
    '--disallowedTools', ...DENIED_TOOLS,
  ];
}

// The desktop app's in-app browser, if it is running: { port, token, exec, mcp } from data/browser.json.
export function appBrowser(paths) {
  let info;
  try { info = JSON.parse(fs.readFileSync(path.join(paths.data, 'browser.json'), 'utf8')); } catch { return null; }
  if (!info?.port || !info?.token) return null;
  if (info.pid) { try { process.kill(info.pid, 0); } catch { return null; } }
  return info;
}

async function sessionRequest(info, method, body) {
  const res = await fetch(`http://127.0.0.1:${info.port}/session`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` }, body: JSON.stringify(body),
  });
  return res.json();
}

/**
 * Opens a hidden posting window logged in as this account and writes the MCP config Claude uses to drive it.
 * Returns { mcpConfigFile, close } | { needs_login: true } | { error }.
 */
export async function openAppSession(info, accountId, workDir) {
  let r;
  try { r = await sessionRequest(info, 'POST', { account_id: accountId, dir: workDir }); } catch (e) { return { error: `Autoposter's browser is not reachable (${e.message})` }; }
  if (r.needs_login) return { needs_login: true };
  if (!r.token) return { error: r.error || 'Autoposter could not open a posting window' };
  const mcpConfigFile = path.join(workDir, 'mcp.json');
  fs.writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: { autoposter: {
    type: 'stdio', command: info.exec, args: [info.mcp],
    env: { ELECTRON_RUN_AS_NODE: '1', AUTOPOSTER_PORT: String(info.port), AUTOPOSTER_TOKEN: r.token },
  } } }), { mode: 0o600 });
  return {
    mcpConfigFile,
    close: async () => {
      try { await sessionRequest(info, 'DELETE', { token: r.token }); } catch { /* the app closes it after 30 min anyway */ }
      fs.rmSync(mcpConfigFile, { force: true });
    },
  };
}

// The job goes through the app's own window when its account has logged in inside the app.
function usesApp(job) {
  return Boolean(job.account_ref) && ['connected', 'needs_login'].includes(job.account_login_state);
}

export function cleanEnv(env = process.env) {
  const out = { ...env };
  for (const key of BILLING_ENV) delete out[key];
  return out;
}

const STATUSES = new Set(['submitted', 'pending_approval', 'awaiting_join', 'failed', 'needs_login']);

const TRACKING_PARAMS = /^(__cft__|__tn__|__xts__|_rdr|ref|rdid|share_url|mibextid|utm_|igsh|si$|s$|t$|rcm|trk)/;

// Only an https link on a supported platform is stored, minus tracking parameters.
export function cleanPostUrl(value) {
  if (typeof value !== 'string') return null;
  let u;
  try { u = new URL(value.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || !ALL_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) return null;
  if (u.pathname === '/' || u.pathname === '') return null;
  if (/…|%E2%80%A6|redacted/i.test(u.href)) return null; // a partially hidden link is not a link
  for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  u.hash = '';
  return u.toString();
}

// Returns the last ```json block in Claude's reply, or null if it is missing or malformed.
export function parseResultBlock(text) {
  if (typeof text !== 'string') return null;
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!blocks.length) return null;
  try {
    const parsed = JSON.parse(blocks.at(-1)[1]);
    if (!STATUSES.has(parsed.status) || typeof parsed.clicked_post !== 'boolean') return null;
    return {
      status: parsed.status,
      clicked_post: parsed.clicked_post,
      post_url: cleanPostUrl(parsed.post_url),
      note: typeof parsed.note === 'string' ? parsed.note : '',
      ...(typeof parsed.commented === 'boolean' ? { commented: parsed.commented } : {}),
    };
  } catch {
    return null;
  }
}

export function looksLikeUsageLimit(text) {
  return /usage limit|rate limit|limit reached|out of (extra )?usage|5-hour limit|weekly limit/i.test(text || '');
}

/**
 * Runs one job through Claude Code and classifies the outcome:
 *   { kind: 'result', result, raw }   Claude returned a valid status block
 *   { kind: 'usage_limit', error }    subscription limit hit; nothing was attempted
 *   { kind: 'ambiguous', error, raw } crash, timeout or unreadable output: may or may not have posted
 */
// mode 'check': a later look at a post waiting for group approval (buildCheckPrompt); nothing new is posted.
export async function runJob(job, media, { paths, settings, claudeBin = findClaude(), mode = 'post' }) {
  if (!claudeBin) {
    return { kind: 'result', raw: null, result: { status: 'failed', clicked_post: false, post_url: null,
      note: 'Claude Code was not found on this computer. Open Setup in the dashboard to install it.' } };
  }
  const workDir = path.join(paths.jobs, String(job.id));
  fs.mkdirSync(workDir, { recursive: true });
  // Big videos are linked rather than copied when the disk allows it (no second copy of a 2 GB file).
  const mediaPaths = media.map((m) => {
    const dest = path.join(workDir, path.basename(m.path));
    fs.rmSync(dest, { force: true });
    try { fs.linkSync(m.path, dest); } catch { fs.copyFileSync(m.path, dest); }
    return dest;
  });
  const mediaBytes = media.reduce((n, m) => n + (m.size_bytes || 0), 0);

  let route = { browser: 'chrome' };
  let appSession = null;
  if (usesApp(job)) {
    const notPosted = (status, note) => ({ kind: 'result', raw: null, result: { status, clicked_post: false, post_url: null, note } });
    const info = appBrowser(paths);
    if (!info) return notPosted('failed', `"${job.account_name}" is logged in inside the Autoposter app, but the app isn't running. Open Autoposter.`);
    appSession = await openAppSession(info, job.account_ref, workDir);
    if (appSession.needs_login) {
      return notPosted('needs_login', `The login for "${job.account_name}" inside Autoposter has expired. Open Accounts and log in again; this post goes out after that.`);
    }
    if (appSession.error) return notPosted('failed', appSession.error);
    route = { browser: 'app', mcpConfigFile: appSession.mcpConfigFile };
  }
  // Chrome can't take files over 10 MB; only the app's own window can.
  if (route.browser === 'chrome' && mode === 'post' && mediaBytes > CHROME_MAX_BYTES) {
    return { kind: 'result', raw: null, result: { status: 'failed', clicked_post: false, post_url: null,
      note: `This post's files are over 10 MB, which Chrome can't upload. Log in to ${job.account_name ? `"${job.account_name}"` : 'this account'} inside the Autoposter app (Accounts page) to post big videos, then retry.` } };
  }

  const prompt = mode === 'check'
    ? buildCheckPrompt(job, settings, { browser: route.browser })
    : buildPrompt(job, mediaPaths, settings, { browser: route.browser });
  // Big uploads take longer: 10 more minutes for every started GB over 100 MB.
  const timeoutMs = Number(settings.job_timeout_min) * 60_000 + (mediaBytes > 100 * 1024 ** 2 ? Math.ceil(mediaBytes / 1024 ** 3) * 600_000 : 0);
  const logFile = path.join(paths.logs, mode === 'check'
    ? `job-${job.id}-check-${(job.approval_checks || 0) + 1}.json`
    : `job-${job.id}-attempt-${job.attempts}.json`);

  const { code, stdout, stderr, timedOut } = await new Promise((resolve) => {
    const child = spawnClaude(claudeBin, buildArgs({ model: settings.model, workDir, ...route }), {
      cwd: workDir,
      env: cleanEnv(envWithClaude(claudeBin)),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; killTree(child); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { err += String(e); });
    child.on('close', (c) => { clearTimeout(timer); resolve({ code: c, stdout: out, stderr: err, timedOut: killed }); });
    child.stdin.end(prompt);
  }).finally(() => appSession?.close?.());

  fs.writeFileSync(logFile, JSON.stringify({ code, timedOut, stdout, stderr, browser: route.browser }, null, 2));

  let envelope = null;
  try { envelope = JSON.parse(stdout); } catch { /* handled below */ }
  const resultText = envelope?.result ?? '';

  if (timedOut) return { kind: 'ambiguous', error: `Timed out after ${settings.job_timeout_min} min`, raw: envelope };

  if (looksLikeUsageLimit(`${stderr}\n${resultText}`) && !parseResultBlock(resultText)?.clicked_post) {
    return { kind: 'usage_limit', error: (stderr || resultText).slice(0, 500) };
  }

  const result = parseResultBlock(resultText);
  if (code === 0 && envelope && !envelope.is_error && result) return { kind: 'result', result, raw: envelope };

  return {
    kind: 'ambiguous',
    error: `claude exited ${code}${result ? '' : ', no valid status block'}: ${(stderr || resultText).slice(0, 500)}`,
    raw: envelope,
  };
}

// Runs a short setup check through claude -p and returns { stdout, stderr, timedOut }.
function runSetupClaude(claudeBin, args, prompt, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawnClaude(claudeBin, args, { cwd, env: cleanEnv(envWithClaude(claudeBin)), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; killTree(child); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { err += String(e); });
    child.on('close', () => { clearTimeout(timer); resolve({ stdout: out, stderr: err, timedOut: killed }); });
    child.stdin.end(prompt);
  });
}

// The last {...} in Claude's reply, parsed; or { error } explaining why there is none.
function setupReply({ stdout, stderr }) {
  let envelope;
  try { envelope = JSON.parse(stdout); } catch { return { error: (stderr || stdout).slice(0, 300) || 'No answer from Claude' }; }
  const text = envelope?.result ?? '';
  if (looksLikeUsageLimit(`${stderr}\n${text}`)) return { error: 'Your Claude usage limit is reached. Try again after it resets.' };
  const m = text.match(/\{[\s\S]*\}/);
  try { return { reply: m ? JSON.parse(m[0]) : null, text }; } catch { return { reply: null, text }; }
}

/**
 * Checks Claude Code can reach the Claude in Chrome extension: asks Claude to list connected browsers.
 * Returns { ok, browsers, error }.
 */
export async function testChromeConnection(claudeBin, paths, { timeoutMs = 120_000 } = {}) {
  const workDir = path.join(paths.jobs, 'chrome-test');
  fs.mkdirSync(workDir, { recursive: true });
  const args = [
    '-p', '--chrome', '--no-session-persistence', '--output-format', 'json', '--model', 'haiku',
    '--strict-mcp-config', '--disable-slash-commands',
    '--allowedTools', 'mcp__claude-in-chrome__list_connected_browsers',
    '--disallowedTools', ...DENIED_TOOLS,
  ];
  const prompt = 'Call the list_connected_browsers tool once. Then reply with only this JSON and nothing else: '
    + '{"browsers": <how many browsers it listed>}. If the tool is missing or fails, reply {"browsers": 0, "error": "<short reason>"}.';
  const run = await runSetupClaude(claudeBin, args, prompt, workDir, timeoutMs);
  if (run.timedOut) return { ok: false, browsers: 0, error: 'Claude did not answer in time. Is Chrome open?' };
  const { reply: r, text, error } = setupReply(run);
  if (error) return { ok: false, browsers: 0, error };
  if (!r || typeof r.browsers !== 'number') return { ok: false, browsers: 0, error: text.slice(0, 300) || 'Unreadable answer' };
  return { ok: r.browsers > 0, browsers: r.browsers, error: r.browsers > 0 ? null : (r.error || 'No Chrome browser is connected') };
}

export const TEST_AUTOMATION_PROMPT = `This is Autoposter's setup test. It checks that you can drive the person's Chrome.
Do NOT post, type, like, comment, follow, accept or click anything that changes any account. Only look.

1. Use the Claude in Chrome tools to get the browser's tab context.
2. Open a NEW tab and go to https://www.facebook.com/
3. Wait for the page to load, then read it. A news feed or a "What's on your mind" box means a Facebook account is signed in;
   a login form means it is not.
4. Close the tab you opened.

Reply with only this JSON and nothing else:
{"opened_tab": true|false, "page_loaded": true|false, "facebook_signed_in": true|false, "closed_tab": true|false, "note": "<one short sentence>"}
If a step fails, set it and every later step to false and say why in note.`;

export function appTestPrompt(account) {
  const home = { facebook: 'https://www.facebook.com/', instagram: 'https://www.instagram.com/', threads: 'https://www.threads.com/',
    x: 'https://x.com/home', linkedin: 'https://www.linkedin.com/feed/', reddit: 'https://www.reddit.com/', tiktok: 'https://www.tiktok.com/' }[account.platform];
  return `This is Autoposter's setup test. It checks that you can drive Autoposter's own browser window.
Do NOT post, type, like, comment, follow, accept or click anything that changes any account. Only look.

1. Use the autoposter navigate tool to open ${home}
2. Wait 3 seconds with the wait tool, then call snapshot and read it. A feed or a compose box means an account is signed in;
   a login form means it is not.

Reply with only this JSON and nothing else:
{"opened_tab": true|false, "page_loaded": true|false, "facebook_signed_in": true|false, "closed_tab": true, "note": "<one short sentence>"}
"opened_tab" is true if the navigate tool worked. "facebook_signed_in" means: signed in to this site. If a step fails, set it and every later step to false and say why in note.`;
}

/**
 * The setup test automation: a real Claude Code run in the person's Chrome that opens a tab, loads Facebook,
 * reads whether an account is signed in and closes the tab, without changing anything.
 * Returns { ok, facebook_signed_in, note, error }. ok means Claude could drive Chrome end to end.
 */
export async function runTestAutomation(claudeBin, paths, { model = 'sonnet', timeoutMs = 240_000, account = null } = {}) {
  const workDir = path.join(paths.jobs, 'setup-test');
  fs.mkdirSync(workDir, { recursive: true });
  const fail = (error) => ({ ok: false, facebook_signed_in: false, note: '', error });
  let run;
  if (account) {
    // An account logged in inside the app: the test drives Autoposter's own window instead of Chrome.
    const info = appBrowser(paths);
    if (!info) return fail('Open the Autoposter app to run the test');
    const s = await openAppSession(info, account.id, workDir);
    if (s.needs_login) return fail(`The login for "${account.name}" has expired. Log in again on the Accounts page.`);
    if (s.error) return fail(s.error);
    try {
      run = await runSetupClaude(claudeBin, buildArgs({ model, workDir, browser: 'app', mcpConfigFile: s.mcpConfigFile }),
        appTestPrompt(account), workDir, timeoutMs);
    } finally { await s.close(); }
  } else {
    run = await runSetupClaude(claudeBin, buildArgs({ model, workDir }), TEST_AUTOMATION_PROMPT, workDir, timeoutMs);
  }
  fs.writeFileSync(path.join(paths.logs, 'setup-test.json'), JSON.stringify(run, null, 2));
  if (run.timedOut) return fail(`Claude did not finish in ${Math.round(timeoutMs / 60_000)} minutes. Is Chrome open with the extension signed in?`);
  const { reply: r, text, error } = setupReply(run);
  if (error) return fail(error);
  if (!r || typeof r.opened_tab !== 'boolean' || typeof r.page_loaded !== 'boolean') return fail(text.slice(0, 300) || 'Unreadable answer');
  const note = typeof r.note === 'string' ? r.note.slice(0, 300) : '';
  const ok = r.opened_tab && r.page_loaded;
  return { ok, facebook_signed_in: ok && r.facebook_signed_in === true, note, error: ok ? null : (note || 'Claude could not open and read a page in Chrome') };
}

// ---- the AI post writer in Compose: Claude writes post options from a short brief. Text only, no tools.
const LENGTHS = { short: '1 to 3 short sentences', medium: 'about 60 to 120 words', long: 'about 150 to 250 words' };
// Any language works; a few need a word of explanation.
const LANGUAGES = { Taglish: 'Taglish (natural mix of Tagalog and English, as Filipinos write on Facebook)', Hinglish: 'Hinglish (natural mix of Hindi and English, in Latin letters)', Spanglish: 'Spanglish (natural mix of Spanish and English)' };

export function buildComposePrompt({ brief = '', draft = '', goal = '', audience = '', format = '', style = '', hook = '', framework = '', cta = '', extra = '',
  tone = '', language = 'English', length = 'medium', limit = null, noSlop = false,
  emojis = false, hashtags = false, platforms = [], count = 3 }) {
  return [
    'You write social media posts for a small business owner or creator. Write the post text only, ready to publish.',
    draft.trim() ? `Improve this draft. Keep its meaning, facts, prices and links; make it clearer and more engaging:\n"""\n${draft.trim()}\n"""` : '',
    brief.trim() ? `What the post is about:\n"""\n${brief.trim()}\n"""` : '',
    `Where it goes: ${platforms.length ? platforms.join(', ') : 'Facebook (pages and groups)'}.`,
    goal ? `Goal of the post: ${goal}.` : '',
    audience ? `Written for: ${audience}.` : '',
    format ? `Format: ${format}.` : '',
    hook && hook !== 'No hook' ? `Open with a ${hook.toLowerCase()} hook in the first line.` : '',
    framework && framework !== 'Automatic' ? `Structure it with the ${framework} framework (without naming it or labeling its parts).` : '',
    cta && cta !== 'None' ? `End with this call to action: ${cta}.` : '',
    extra.trim() ? `Extra instructions from the owner (follow them unless they ask you to invent facts):\n"""\n${extra.trim()}\n"""` : '',
    `Writing style: ${style || tone || 'conversational'}. Language: ${LANGUAGES[language] || language}. Length: ${limit ? `about ${limit.n} ${limit.unit} (count them; stay within 10% of ${limit.n}${limit.unit === 'characters' ? ', counting spaces and emojis' : ''})` : LENGTHS[length] || LENGTHS.medium}.`,
    emojis ? 'Use a few fitting emojis.' : 'Do not use emojis.',
    hashtags ? 'End with 2 to 4 relevant hashtags.' : 'Do not use hashtags.',
    'Speak to the reader as "you". Keep paragraphs short and easy to read on a phone.',
    cta && cta !== 'None' ? '' : noSlop ? '' : 'End with a simple question or next step.',
    noSlop ? SLOP_RULES : '',
    'Never invent facts, prices, discounts, results, testimonials, people, quotes or personal anecdotes ("a friend told me") that are not in the brief or draft.',
    'Many Facebook groups block links in posts: if there is a link, leave it out of the post text and put it in first_comment (e.g. "Here\'s the link: <url>"). Otherwise first_comment is "".',
    `Write ${count} clearly different options (different hooks and angles).`,
    'Reply with JSON only, no other text: {"options":[{"body":"...","first_comment":"..."}]}',
  ].filter(Boolean).join('\n\n');
}

// The first comment under a post: Claude writes options from the post itself and what to add.
const COMMENT_KINDS = {
  link: 'share the link (and only the link given) with a short, friendly line that makes people want to click',
  question: 'ask one easy question that gets people replying, related to the post',
  details: 'add useful extra details the post did not have room for (only facts given in the post or the notes)',
  thanks: 'a warm line thanking people for reading and inviting them to message or comment',
};
export function buildCommentPrompt({ post = '', notes = '', kind = 'link', language = 'English', emojis = true, noSlop = false, count = 3 }) {
  return [
    'You write the first comment the owner adds under their own social media post, right after posting it.',
    `The post:\n"""\n${post.trim() || '(no text, only photos)'}\n"""`,
    notes.trim() ? `What the owner wants in the comment (links, details):\n"""\n${notes.trim()}\n"""` : '',
    `The comment should ${COMMENT_KINDS[kind] || COMMENT_KINDS.link}.`,
    `Language: ${LANGUAGES[language] || language}. Keep it short: 1 or 2 sentences. Don't repeat the post.`,
    emojis ? 'One fitting emoji is fine.' : 'Do not use emojis.',
    'Never invent links, prices, facts or offers. Use a link only if it appears in the post or the notes, exactly as written.',
    noSlop ? SLOP_RULES : '',
    `Write ${count} different options.`,
    'Reply with JSON only, no other text: {"options":["...","...","..."]}',
  ].filter(Boolean).join('\n\n');
}

// Runs one text-only Claude request (no tools) and returns its JSON reply, or { error }.
async function runWriter(prompt, { claudeBin, model, timeoutMs }) {
  if (!claudeBin) return { error: 'Claude Code is not set up yet. Finish Setup first.' };
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoposter-write-'));
  try {
    const args = ['-p', '--no-session-persistence', '--output-format', 'json', '--model', model,
      '--strict-mcp-config', '--disable-slash-commands', '--disallowedTools', ...DENIED_TOOLS, 'Read', 'Glob', 'Grep', 'TodoWrite'];
    const run = await runSetupClaude(claudeBin, args, prompt, workDir, timeoutMs);
    if (run.timedOut) return { error: 'Claude took too long. Try again.' };
    const { reply, error, text } = setupReply(run);
    if (error) return { error };
    if (!reply) return { error: text ? 'Claude did not return any text. Try again.' : 'No answer from Claude. Try again.' };
    return { reply };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// "No AI slop": options that still use a listed word or phrase go back to Claude once, to be reworded.
async function deSlop(texts, opts) {
  const hits = texts.map(findSlop);
  if (!hits.some((h) => h.length)) return texts;
  const prompt = [
    'Reword these social media texts so they no longer use the listed words and phrases. Keep the meaning, facts, links, language, length and tone; change only what is needed. Replace em dashes with commas or periods.',
    SLOP_RULES,
    ...texts.map((t, i) => `Text ${i + 1}${hits[i].length ? ` (remove: ${hits[i].join(', ')})` : ' (keep as it is)'}:\n"""\n${t}\n"""`),
    `Reply with JSON only, no other text: {"texts":["...",...]} with exactly ${texts.length} texts in the same order.`,
  ].join('\n\n');
  const { reply } = await runWriter(prompt, opts);
  const fixed = Array.isArray(reply?.texts) && reply.texts.length === texts.length ? reply.texts.map((t) => String(t || '').trim()) : null;
  // Clean texts stay as they were; a reworded one is kept only if it has fewer hits than before.
  const better = (t, i) => t && hits[i].length && findSlop(t).length < hits[i].length;
  return fixed ? fixed.map((t, i) => (better(t, i) ? t : texts[i])) : texts;
}

export async function composeComment(input, { claudeBin = findClaude(), model = 'sonnet', timeoutMs = 90_000 } = {}) {
  const { reply, error } = await runWriter(buildCommentPrompt(input), { claudeBin, model, timeoutMs });
  if (error) return { error };
  let options = (reply.options || []).map((o) => String(typeof o === 'string' ? o : o?.text || '').trim()).filter(Boolean);
  if (input.noSlop && options.length) options = await deSlop(options, { claudeBin, model, timeoutMs });
  return options.length ? { options } : { error: 'Claude did not return a comment. Try again.' };
}

export async function composePost(input, { claudeBin = findClaude(), model = 'sonnet', timeoutMs = 120_000 } = {}) {
  const { reply, error } = await runWriter(buildComposePrompt(input), { claudeBin, model, timeoutMs });
  if (error) return { error };
  const options = (reply.options || []).map((o) => ({ body: String(o.body || '').trim(), first_comment: String(o.first_comment || '').trim() }))
    .filter((o) => o.body);
  if (input.noSlop && options.length) {
    const bodies = await deSlop(options.map((o) => o.body), { claudeBin, model, timeoutMs });
    bodies.forEach((b, i) => { options[i].body = b; });
  }
  return options.length ? { options } : { error: 'Claude did not return a post. Try again.' };
}

// ---- AI images: Claude designs post graphics as self-contained HTML; the desktop app turns each into a PNG.
export const IMAGE_SIZES = { square: [1080, 1080], portrait: [1080, 1350], story: [1080, 1920], landscape: [1200, 630] };
export function buildImagePrompt({ brief = '', post = '', kind = '', style = '', colors = '', language = 'English', size = 'square', photo = false, photos = photo ? 1 : 0, count = 3 }) {
  const [w, h] = IMAGE_SIZES[size] || IMAGE_SIZES.square;
  return [
    `You are a graphic designer. Design ${count} different social media post images, each as one self-contained HTML document exactly ${w}x${h} pixels.`,
    brief.trim() ? `What the image should say or show:\n"""\n${brief.trim()}\n"""` : '',
    post.trim() ? `The post it goes with (for context; don't copy it all onto the image):\n"""\n${post.trim().slice(0, 3000)}\n"""` : '',
    kind ? `Kind of graphic: ${kind}.` : '',
    style ? `Visual style: ${style}.` : '',
    colors ? `Colors: ${colors}.` : 'Pick a strong, attractive color palette that fits the topic.',
    `Any text on the image is in ${LANGUAGES[language] || language}.`,
    photos === 1
      ? 'Use the owner\'s photo as the main visual: put it in the design as <img src="{{PHOTO1}}"> (or CSS url("{{PHOTO1}}")) with object-fit: cover, and keep text readable over it (a gradient or solid panel behind text).'
      : photos > 1
        ? `Combine the owner's ${photos} photos in each design (a collage, grid, side by side, or one large with smaller ones): use them as <img src="{{PHOTO1}}"> … <img src="{{PHOTO${photos}}}"> (every one of them), each with object-fit: cover, and keep text readable (a panel or gradient behind text).`
        : 'There is no photo: build the visual from type, color, shapes, CSS gradients, inline SVG and emoji.',
    'Rules for the HTML:',
    `- <html><body style="margin:0"> with one root element exactly ${w}px wide and ${h}px tall, overflow hidden.`,
    '- Inline <style> only. No JavaScript, no external files, fonts or images (they will not load). Use system fonts such as -apple-system, "Segoe UI", Helvetica, Arial, and "Georgia" for serif.',
    '- Big, bold, readable text: a short headline (under 8 words), at most one supporting line, and an optional small call to action. Never cram the whole post onto the image.',
    '- Generous margins (at least 64px), clear hierarchy, good contrast. Each design looks clearly different (layout, color, typography).',
    '- Text must never overlap other text or run off the image: lay all text out in normal flow (a flexbox column with gap), never with absolute positioning; only decorative shapes may be absolutely positioned, behind the text (z-index), and they stay clear of the text or are faint enough that every word stays easy to read. Size the headline so it fits in at most 3 lines.',
    '- Never invent prices, discounts, dates, results or brand names that are not in the brief or post.',
    'Reply with JSON only, no other text: {"designs":[{"html":"<html>...</html>"}]}',
  ].filter(Boolean).join('\n\n');
}

export async function composeImages(input, { claudeBin = findClaude(), model = 'sonnet', timeoutMs = 180_000 } = {}) {
  const { reply, error } = await runWriter(buildImagePrompt(input), { claudeBin, model, timeoutMs });
  if (error) return { error };
  const designs = (reply.designs || []).map((d) => String(typeof d === 'string' ? d : d?.html || '')).filter((h) => /<html|<body|<div/i.test(h));
  return designs.length ? { designs } : { error: 'Claude did not return a design. Try again.' };
}
