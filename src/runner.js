import fs from 'node:fs';
import path from 'node:path';
import { buildPrompt } from './prompt.js';
import { ALL_HOSTS } from './platforms.js';
import { findClaude, spawnClaude, envWithClaude, killTree } from './platform.js';

// Anything here would switch Claude Code off the subscription login and onto paid API billing.
const BILLING_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
];

const DENIED_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent'];

export function buildArgs({ model, workDir }) {
  return [
    '-p', '--chrome', '--no-session-persistence', '--output-format', 'json',
    '--model', model,
    '--strict-mcp-config', '--disable-slash-commands',
    '--add-dir', workDir,
    '--allowedTools', 'mcp__claude-in-chrome__*',
    '--disallowedTools', ...DENIED_TOOLS,
  ];
}

export function cleanEnv(env = process.env) {
  const out = { ...env };
  for (const key of BILLING_ENV) delete out[key];
  return out;
}

const STATUSES = new Set(['submitted', 'pending_approval', 'awaiting_join', 'failed']);

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
export async function runJob(job, media, { paths, settings, claudeBin = findClaude() }) {
  if (!claudeBin) {
    return { kind: 'result', raw: null, result: { status: 'failed', clicked_post: false, post_url: null,
      note: 'Claude Code was not found on this computer. Open Setup in the dashboard to install it.' } };
  }
  const workDir = path.join(paths.jobs, String(job.id));
  fs.mkdirSync(workDir, { recursive: true });
  const mediaPaths = media.map((m) => {
    const dest = path.join(workDir, path.basename(m.path));
    fs.copyFileSync(m.path, dest);
    return dest;
  });

  const prompt = buildPrompt(job, mediaPaths, settings);
  const timeoutMs = Number(settings.job_timeout_min) * 60_000;
  const logFile = path.join(paths.logs, `job-${job.id}-attempt-${job.attempts}.json`);

  const { code, stdout, stderr, timedOut } = await new Promise((resolve) => {
    const child = spawnClaude(claudeBin, buildArgs({ model: settings.model, workDir }), {
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
  });

  fs.writeFileSync(logFile, JSON.stringify({ code, timedOut, stdout, stderr }, null, 2));

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
  const { stdout, stderr, timedOut } = await new Promise((resolve) => {
    const child = spawnClaude(claudeBin, args, { cwd: workDir, env: cleanEnv(envWithClaude(claudeBin)), stdio: ['pipe', 'pipe', 'pipe'] });
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
  if (timedOut) return { ok: false, browsers: 0, error: 'Claude did not answer in time. Is Chrome open?' };
  let text = '';
  try { text = JSON.parse(stdout).result ?? ''; } catch { return { ok: false, browsers: 0, error: (stderr || stdout).slice(0, 300) || 'No answer from Claude' }; }
  const m = text.match(/\{[\s\S]*\}/);
  let r = null;
  try { r = m ? JSON.parse(m[0]) : null; } catch { /* handled below */ }
  if (!r || typeof r.browsers !== 'number') return { ok: false, browsers: 0, error: text.slice(0, 300) || 'Unreadable answer' };
  return { ok: r.browsers > 0, browsers: r.browsers, error: r.browsers > 0 ? null : (r.error || 'No Chrome browser is connected') };
}
