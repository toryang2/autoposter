import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import os from 'node:os';
import { spawnNodeScript, findClaude, claudeAuthStatus, openTerminal, CLAUDE_INSTALL_COMMAND, claudeLoginCommand, IN_ELECTRON, findClaudeExtension } from './platform.js';
import { testChromeConnection, runTestAutomation, composePost, composeComment, composeImages, IMAGE_SIZES } from './runner.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths as getPaths, PORT, HOST, LIMITS, sizeLabel } from './config.js';
import { openDb, getSettings, setSetting, nowIso, tx, DEFAULT_SETTINGS, ACCOUNT_OF_JOB, setAccountLogin, savePages } from './db.js';
import { PLATFORMS, isPlatformUrl, mediaProblem } from './platforms.js';
import { postedToday, delayReasons } from './worker.js';
import { cleanPostUrl } from './runner.js';
import { checkForUpdate, installUpdate, restartApp, canRestart, APP_VERSION } from './update.js';

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
  j.post_url, j.started_at, j.finished_at, j.force_now, j.post_as, j.next_check_at, j.approval_checks, d.name AS destination_name, d.type AS destination_type, d.url AS destination_url,
  d.platform AS destination_platform, d.post_as AS destination_post_as, d.archived AS destination_archived, p.body AS post_body, p.first_comment,
  a.id AS account_ref, a.name AS account_name, a.profile_url AS account_url, a.login_state AS account_login_state
  FROM jobs j JOIN destinations d ON d.id = j.destination_id JOIN posts p ON p.id = j.post_id LEFT JOIN accounts a ON a.id = ${ACCOUNT_OF_JOB}`;

// browser: the desktop app's in-app browser (electron/browser.js), or undefined when running from the command line.
export function createApp(db, p, { browser } = {}) {
  const app = express();
  // JSON bodies; AI image requests carry a photo and get their own, larger limit on their route.
  const json = express.json();
  app.use((req, res, next) => (req.path === '/api/ai/image' ? next() : json(req, res, next)));

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
    // The link and the kind (profile, Page, group) can be corrected too; queued posts follow the change.
    const type = req.body?.type ?? d.type;
    if (!PLATFORMS[d.platform].types.includes(type)) throw new HttpError(400, `${PLATFORMS[d.platform].label} destinations can be: ${PLATFORMS[d.platform].types.join(', ')}`);
    const url = req.body?.url !== undefined ? String(req.body.url).trim().replace(/\/+$/, '') : d.url;
    if (url !== d.url) {
      if (!isPlatformUrl(d.platform, url)) throw new HttpError(400, `URL must be an https://${PLATFORMS[d.platform].hosts[0]} link`);
      if (db.prepare('SELECT 1 FROM destinations WHERE url = ? AND id <> ?').get(url, d.id)) throw new HttpError(409, 'Another destination already has that link');
    }
    res.json(db.prepare('UPDATE destinations SET name = ?, enabled = ?, audience = ?, post_as = ?, url = ?, type = ? WHERE id = ? RETURNING *')
      .get(String(name).trim() || d.name, enabled ? 1 : 0, type === 'profile' && d.platform === 'facebook' ? audience : 'default', postAs, url, type, d.id));
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

  // ---- accounts: which of the person's own accounts posts. The first one on a platform becomes its default.
  // Each logged-in account's profile picture, saved by the desktop app at <data>/avatars/<id>.img.
  const avatarFile = (id) => path.join(p.data, 'avatars', `${Number(id)}.img`);
  const avatarVersion = (id) => { try { return Math.floor(fs.statSync(avatarFile(id)).mtimeMs); } catch { return null; } };
  // Every account's own profile is a place to post: it shows in Compose's "Where" without adding it by hand,
  // and only that account posts there.
  const ensureAccountDestination = (a) => {
    const d = db.prepare('SELECT id, archived FROM destinations WHERE url = ?').get(a.profile_url);
    if (d) return;
    const isPage = db.prepare('SELECT 1 FROM account_pages WHERE url = ?').get(a.profile_url);
    db.prepare(`INSERT INTO destinations(name, platform, type, url, audience, post_as, created_at) VALUES (?, ?, ?, ?, 'default', NULL, ?)`)
      .run(a.name, a.platform, isPage ? 'page' : 'profile', a.profile_url, nowIso());
  };
  for (const a of db.prepare('SELECT * FROM accounts').all()) ensureAccountDestination(a);
  // A Facebook Page's picture, saved by the desktop app at <data>/avatars/page-<Facebook page id>.img.
  const pageAvatarFile = (fbId) => path.join(p.data, 'avatars', `page-${String(fbId).replace(/\D/g, '')}.img`);
  const pageAvatarVersion = (fbId) => { try { return fbId ? Math.floor(fs.statSync(pageAvatarFile(fbId)).mtimeMs) : null; } catch { return null; } };
  const pagesOf = (accountId) => db.prepare('SELECT id, fb_page_id, name, url FROM account_pages WHERE account_id = ? ORDER BY name COLLATE NOCASE')
    .all(accountId).map((pg) => ({ ...pg, avatar_v: pageAvatarVersion(pg.fb_page_id) }));
  // Each account with its Pages. An "account" whose link is one of those Pages is marked page_of: it needs no login.
  const listAccounts = () => db.prepare('SELECT * FROM accounts ORDER BY platform, is_default DESC, name').all().map((a) => {
    const owner = db.prepare(`SELECT x.id, x.name, pg.fb_page_id FROM account_pages pg JOIN accounts x ON x.id = pg.account_id
      WHERE pg.url = ? AND x.id <> ? LIMIT 1`).get(a.profile_url, a.id);
    return { ...a, avatar_v: owner ? pageAvatarVersion(owner.fb_page_id) : avatarVersion(a.id), pages: pagesOf(a.id),
      page_of: owner ? { id: owner.id, name: owner.name } : null, page_avatar: owner?.fb_page_id ?? null };
  });
  app.get('/api/accounts', (req, res) => res.json(listAccounts()));
  app.get('/api/pages/:id/avatar', (req, res) => {
    const pg = db.prepare('SELECT fb_page_id FROM account_pages WHERE id = ?').get(req.params.id);
    if (!pg || !pageAvatarVersion(pg.fb_page_id)) throw new HttpError(404, 'No picture yet');
    res.set('content-type', 'image/jpeg').set('cache-control', 'max-age=86400').sendFile(pageAvatarFile(pg.fb_page_id));
  });
  // Reads the account's Pages from Facebook again (desktop app only).
  app.post('/api/accounts/:id/pages/refresh', async (req, res) => {
    const a = accountForLogin(req.params.id);
    if (a.platform !== 'facebook') throw new HttpError(400, 'Only Facebook accounts have Pages');
    if (a.login_state !== 'connected') throw new HttpError(409, 'Log in to this account first');
    const pages = await browser.fetchPages(a);
    if (!pages) throw new HttpError(502, "Couldn't read your Pages from Facebook. Try again in a minute.");
    savePages(db, a.id, pages);
    res.json(listAccounts());
  });
  app.get('/api/accounts/:id/avatar', (req, res) => {
    const acc = listAccounts().find((x) => x.id === Number(req.params.id));
    if (acc?.page_avatar && acc.avatar_v) {
      return res.set('content-type', 'image/jpeg').set('cache-control', 'max-age=86400').sendFile(pageAvatarFile(acc.page_avatar));
    }
    if (!avatarVersion(req.params.id)) throw new HttpError(404, 'No picture yet');
    res.set('content-type', 'image/jpeg').set('cache-control', 'max-age=86400').sendFile(avatarFile(req.params.id));
  });

  app.post('/api/accounts', (req, res) => {
    const { platform = 'facebook', name } = req.body ?? {};
    const pf = PLATFORMS[platform];
    if (!pf) throw new HttpError(400, 'Unknown platform');
    if (!String(name ?? '').trim()) throw new HttpError(400, 'Give the account a name');
    let url = String(req.body?.profile_url ?? '').trim().replace(/\/+$/, '');
    if (!isPlatformUrl(platform, url)) throw new HttpError(400, `The profile link must be an https://${pf.hosts[0]} link`);
    if (platform === 'facebook') url = url.replace('https://facebook.com/', 'https://www.facebook.com/').replace('https://m.facebook.com/', 'https://www.facebook.com/');
    if (db.prepare('SELECT 1 FROM accounts WHERE profile_url = ?').get(url)) throw new HttpError(409, 'That account is already added');
    // One of the person's own Pages: added as a Page (no login of its own; its account switches into it to post).
    const page = db.prepare('SELECT pg.name, a.id AS account_id, a.name AS account FROM account_pages pg JOIN accounts a ON a.id = pg.account_id WHERE pg.url = ?').get(url);
    const first = !db.prepare('SELECT 1 FROM accounts WHERE platform = ?').get(platform);
    const row = db.prepare('INSERT INTO accounts(platform, name, profile_url, is_default, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *')
      .get(platform, String(name).trim().slice(0, 80), url, first ? 1 : 0, nowIso());
    ensureAccountDestination(row);
    res.status(201).json({ ...row, page_of: page ? { id: page.account_id, name: page.account } : null });
  });

  app.patch('/api/accounts/:id', (req, res) => {
    const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
    if (!a) throw new HttpError(404, 'Account not found');
    tx(db, () => {
      if (req.body?.name !== undefined) {
        const name = String(req.body.name).trim();
        if (!name) throw new HttpError(400, 'Give the account a name');
        db.prepare('UPDATE accounts SET name = ? WHERE id = ?').run(name.slice(0, 80), a.id);
      }
      if (req.body?.is_default) {
        db.prepare('UPDATE accounts SET is_default = 0 WHERE platform = ?').run(a.platform);
        db.prepare('UPDATE accounts SET is_default = 1 WHERE id = ?').run(a.id);
      }
    });
    res.json(listAccounts());
  });

  // ---- logging in to an account inside the desktop app (its own saved login, separate from every other account)
  app.get('/api/accounts/app', (req, res) => res.json({ available: Boolean(browser) }));
  // Any click in Autoposter's own screen (the sidebar beside the in-app browser) closes that browser.
  app.post('/api/browser/close', async (req, res) => { await browser?.closePane?.({ minAge: 1000 }); res.json({ closed: true }); });
  const accountForLogin = (id) => {
    if (!browser) throw new HttpError(409, 'Logging in works in the Autoposter desktop app');
    const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    if (!a) throw new HttpError(404, 'Account not found');
    return a;
  };
  // Opens the platform's login page in an Autoposter window; the account turns Connected when the login is saved.
  app.post('/api/accounts/:id/login', (req, res) => {
    const a = accountForLogin(req.params.id);
    browser.login(a);
    res.json({ opened: true });
  });
  // Opens the account's feed in an Autoposter window, e.g. to check a post went out.
  app.post('/api/accounts/:id/open', (req, res) => {
    const a = accountForLogin(req.params.id);
    browser.open(a);
    res.json({ opened: true });
  });
  app.post('/api/accounts/:id/logout', async (req, res) => {
    const a = accountForLogin(req.params.id);
    await browser.logout(a);
    setAccountLogin(db, a.id, 'none');
    res.json(listAccounts());
  });

  // Posts waiting to go out from this account are cancelled: another account must not post them instead.
  app.delete('/api/accounts/:id', async (req, res) => {
    const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
    if (!a) throw new HttpError(404, 'Account not found');
    if (browser) await browser.logout(a).catch(() => {});
    tx(db, () => {
      db.prepare(`UPDATE jobs SET status = 'cancelled', force_now = 0, last_error = 'The account was removed'
        WHERE account_id = ? AND status IN ('queued','awaiting_join','needs_login')`).run(a.id);
      db.prepare('UPDATE jobs SET account_id = NULL WHERE account_id = ?').run(a.id);
      db.prepare('DELETE FROM accounts WHERE id = ?').run(a.id);
      if (a.is_default) {
        db.prepare(`UPDATE accounts SET is_default = 1 WHERE id = (SELECT id FROM accounts WHERE platform = ? ORDER BY id LIMIT 1)`).run(a.platform);
      }
      if (a.platform === 'facebook' && getSettings(db).fb_account_url === a.profile_url) setSetting(db, 'fb_account_url', '');
    });
    fs.rmSync(avatarFile(a.id), { force: true });
    res.json(listAccounts());
  });

  // ---- the AI writer in Compose: Claude (on the person's own subscription) writes post options from a brief.
  app.post('/api/ai/compose', async (req, res) => {
    const b = req.body ?? {};
    const brief = String(b.brief ?? '').slice(0, 4000);
    const draft = String(b.draft ?? '').slice(0, 8000);
    if (!brief.trim() && !draft.trim()) throw new HttpError(400, 'Say what the post is about');
    const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);
    const platforms = [...new Set([].concat(b.platforms ?? []).map((x) => PLATFORMS[x]?.label).filter(Boolean))];
    const out = await composePost({
      brief, draft, platforms,
      // Free-text choices (lists in the app are suggestions): trimmed and kept short.
      ...Object.fromEntries(['goal', 'audience', 'format', 'style', 'hook', 'framework', 'cta']
        .map((k) => [k, String(b[k] ?? '').replace(/[\r\n"]/g, ' ').trim().slice(0, 120)])),
      extra: String(b.extra ?? '').slice(0, 2000),
      language: String(b.language ?? '').replace(/[^\p{L}\p{M} ()'-]/gu, '').trim().slice(0, 40) || 'English',
      length: pick(b.length, ['short', 'medium', 'long', 'custom'], 'medium'),
      // "custom": an exact size, e.g. 50 words or 280 characters.
      limit: b.length === 'custom' && Number(b.limit_n) > 0
        ? { n: Math.min(Math.round(Number(b.limit_n)), b.limit_unit === 'characters' ? 5000 : 1000), unit: b.limit_unit === 'characters' ? 'characters' : 'words' } : null,
      emojis: Boolean(b.emojis), hashtags: Boolean(b.hashtags), noSlop: Boolean(b.no_slop),
    }, { model: getSettings(db).model || 'sonnet' });
    if (out.error) throw new HttpError(502, out.error);
    res.json(out);
  });

  app.post('/api/ai/comment', async (req, res) => {
    const b = req.body ?? {};
    const out = await composeComment({
      post: String(b.post ?? '').slice(0, 8000), notes: String(b.notes ?? '').slice(0, 2000),
      kind: ['link', 'question', 'details', 'thanks'].includes(b.kind) ? b.kind : 'link',
      language: String(b.language ?? '').replace(/[^\p{L}\p{M} ()'-]/gu, '').trim().slice(0, 40) || 'English',
      emojis: b.emojis !== false, noSlop: Boolean(b.no_slop),
    }, { model: getSettings(db).model || 'sonnet' });
    if (out.error) throw new HttpError(502, out.error);
    res.json(out);
  });

  // AI images: Claude designs graphics as HTML; the desktop app's browser turns them into PNGs. With "photo", the
  // person's own photo (a data: URL) goes where the design says {{PHOTO}}.
  app.post('/api/ai/image', express.json({ limit: '12mb' }), async (req, res) => {
    if (!browser?.renderHtml) throw new HttpError(409, 'Creating images works in the Autoposter desktop app');
    const b = req.body ?? {};
    const brief = String(b.brief ?? '').slice(0, 3000);
    if (!brief.trim() && !String(b.post ?? '').trim()) throw new HttpError(400, 'Say what the image should show');
    // The person's own photos (data: URLs, up to 4): they go where the design says {{PHOTO1}}, {{PHOTO2}}, …
    const isImage = (x) => typeof x === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(x);
    const photos = [].concat(b.photos ?? [], b.photo ?? []).filter(isImage).slice(0, 4);
    const size = IMAGE_SIZES[b.size] ? b.size : 'square';
    const clean = (v) => String(v ?? '').replace(/[\r\n"]/g, ' ').trim().slice(0, 120);
    const out = await composeImages({
      brief, post: String(b.post ?? '').slice(0, 3000), kind: clean(b.kind), style: clean(b.style), colors: clean(b.colors), size,
      language: String(b.language ?? '').replace(/[^\p{L}\p{M} ()'-]/gu, '').trim().slice(0, 40) || 'English', photos: photos.length,
    }, { model: getSettings(db).model || 'sonnet' });
    const withPhotos = (html) => photos.reduce((h, src, i) => h.replaceAll(`{{PHOTO${i + 1}}}`, src), html.replaceAll('{{PHOTO}}', photos[0] ?? ''));
    if (out.error) throw new HttpError(502, out.error);
    const [w, h] = IMAGE_SIZES[size];
    const images = [];
    for (const html of out.designs) {
      try {
        const png = await browser.renderHtml(withPhotos(html), w, h);
        images.push(`data:image/png;base64,${png.toString('base64')}`);
      } catch { /* skip a design that would not render */ }
    }
    if (!images.length) throw new HttpError(502, "Claude's designs could not be turned into images. Try again.");
    res.json({ images, width: w, height: h });
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
      // Which accounts post. destination_accounts: {"<destination id>": [account ids]}, any number per destination;
      // each one becomes its own job. account_ids (older form): one account per platform. Neither: the default account.
      const accountFor = {};
      for (const id of [].concat(req.body.account_ids ?? []).map(Number).filter(Boolean)) {
        const a = db.prepare('SELECT id, platform FROM accounts WHERE id = ?').get(id);
        if (!a) throw new HttpError(400, 'Unknown account');
        accountFor[a.platform] = a.id;
      }
      let perDestination = {};
      if (req.body.destination_accounts) {
        try { perDestination = JSON.parse(req.body.destination_accounts); } catch { throw new HttpError(400, 'Invalid account choice'); }
        if (!perDestination || typeof perDestination !== 'object') throw new HttpError(400, 'Invalid account choice');
      }
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
      if (total > LIMITS.maxTotalBytes) throw new HttpError(400, `Attachments must total ${sizeLabel(LIMITS.maxTotalBytes)} or less`);
      const dests = destinationIds.map((id) => db.prepare('SELECT * FROM destinations WHERE id = ? AND archived = 0').get(id));
      if (dests.some((d) => !d)) throw new HttpError(400, 'Unknown destination');
      const unsupported = dests.find((d) => !PLATFORMS[d.platform]?.posting);
      if (unsupported) throw new HttpError(400, `Posting to ${PLATFORMS[unsupported.platform].label} isn't supported yet`);
      for (const d of dests) {
        const problem = mediaProblem(d.platform, kinds);
        if (problem) throw new HttpError(400, `${problem} (${d.name})`);
      }
      // Every (destination, account) pair to post; null account: that platform's default account.
      const targets = dests.flatMap((d) => {
        // An account's own profile: only that account can post there.
        const owner = d.type === 'profile' && db.prepare('SELECT id FROM accounts WHERE profile_url = ? AND platform = ?').get(d.url, d.platform);
        if (owner) return [{ d, account: owner.id }];
        // Each pick is an account id, or "p<page id>" for one of a Facebook account's Pages.
        const picks = [];
        for (const raw of [...new Set([].concat(perDestination[d.id] ?? []).map(String))]) {
          let account, page = null;
          if (/^p\d+$/.test(raw)) {
            page = db.prepare('SELECT pg.name, pg.account_id FROM account_pages pg WHERE pg.id = ?').get(Number(raw.slice(1)));
            if (!page) throw new HttpError(400, 'Unknown Page');
            account = page.account_id;
          } else account = Number(raw);
          if (!account) continue;
          const a = db.prepare('SELECT platform FROM accounts WHERE id = ?').get(account);
          if (!a) throw new HttpError(400, 'Unknown account');
          if (a.platform !== d.platform) throw new HttpError(400, `That account can't post to ${d.name}`);
          // A Page posts in groups as itself. Elsewhere (a Page's own feed, other places) its account posts.
          const postAs = page && d.type === 'group' ? page.name : null;
          if (!picks.some((x) => x.account === account && x.postAs === postAs)) picks.push({ account, postAs });
        }
        return picks.length ? picks.map((x) => ({ d, account: x.account, postAs: x.postAs }))
          : [{ d, account: accountFor[d.platform] ?? null }];
      });

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
        const insertJob = db.prepare('INSERT INTO jobs(post_id, destination_id, scheduled_at, post_as, account_id) VALUES (?, ?, ?, ?, ?)');
        // "Who" only changes who posts in Facebook groups; profiles, Pages and other platforms post as themselves.
        for (const { d, account, postAs } of targets) {
          insertJob.run(post.id, d.id, scheduledAt.toISOString(), postAs ?? (d.platform === 'facebook' && d.type === 'group' ? who : null), account);
        }
        return post.id;
      });
      res.status(201).json({ id: postId, jobs: targets.length });
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
    const delays = delayReasons(db, { workerRunning: workerAlive(p.lock) });
    for (const r of rows) r.delay = delays[r.id] ?? null;
    if (req.query.delayed) return res.json(rows.filter((r) => r.delay));
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

  app.post('/api/jobs/:id/cancel', transition(['queued', 'awaiting_join', 'needs_login'], 'cancelled', ', force_now = 0'));
  // Retrying a needs_check job is the user's call: they confirmed on Facebook that nothing went out.
  app.post('/api/jobs/:id/retry', (req, res) => {
    refuseRemovedDestination(req.params.id);
    // From awaiting_join this is "check now": the original request date is kept so the wait limit still counts.
    const row = db.prepare(`UPDATE jobs SET status = 'queued', scheduled_at = ?, last_error = NULL, attempts = 0,
        join_requested_at = CASE WHEN status = 'awaiting_join' THEN join_requested_at ELSE NULL END
      WHERE id = ? AND status IN ('failed','needs_check','cancelled','awaiting_join','needs_login') RETURNING id, status`).get(nowIso(), req.params.id);
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
    // The person may pick which account posts it (one of the destination's platform), or one of its Pages (page_id).
    let pickedPage = null;
    if (req.body?.page_id != null) {
      pickedPage = db.prepare('SELECT name, account_id FROM account_pages WHERE id = ?').get(Number(req.body.page_id));
      if (!pickedPage) throw new HttpError(400, 'Unknown Page');
      req.body.account_id = pickedPage.account_id;
    }
    if (req.body?.account_id != null) {
      const job = db.prepare(`SELECT j.post_id, j.destination_id, d.platform, d.type, d.url FROM jobs j JOIN destinations d ON d.id = j.destination_id
        WHERE j.id = ?`).get(req.params.id);
      if (!job) throw new HttpError(404, 'Job not found');
      const acc = db.prepare('SELECT id, platform FROM accounts WHERE id = ?').get(Number(req.body.account_id));
      if (!acc || acc.platform !== job.platform) throw new HttpError(400, `Pick one of your ${PLATFORMS[job.platform]?.label ?? ''} accounts`);
      const owner = job.type === 'profile' && db.prepare('SELECT id FROM accounts WHERE profile_url = ? AND platform = ?').get(job.url, job.platform);
      if (owner && owner.id !== acc.id) throw new HttpError(400, 'Only the account that owns this profile can post on it');
      const postAs = pickedPage && job.type === 'group' ? pickedPage.name : null;
      const taken = db.prepare(`SELECT 1 FROM jobs j JOIN destinations d ON d.id = j.destination_id
        WHERE j.post_id = ? AND j.destination_id = ? AND j.id <> ? AND ${ACCOUNT_OF_JOB} = ? AND COALESCE(j.post_as, '') = ?`)
        .get(job.post_id, job.destination_id, req.params.id, acc.id, postAs ?? '');
      if (taken) throw new HttpError(409, 'This post already goes to this place from that account');
      db.prepare("UPDATE jobs SET account_id = ?, post_as = ? WHERE id = ? AND status IN ('queued','awaiting_join')").run(acc.id, postAs, req.params.id);
    }
    const row = db.prepare(`UPDATE jobs SET force_now = 1, last_error = NULL WHERE id = ? AND status IN ('queued','awaiting_join')
      RETURNING id, status`).get(req.params.id);
    if (!row) throw new HttpError(409, 'Only queued or waiting-to-join posts can be posted now');
    // A running worker sees the flag within a few seconds, right after any post it is publishing now.
    if (!pid) startWorker(p, ['--post-now']);
    res.json({ ...row, via: pid ? 'worker' : 'one-off' });
  });
  // Clears a failed or cancelled job from the Queue. Posted and pending jobs stay as history.
  // When it was the post's last job, the post and its media files go too.
  // Edit a post that hasn't gone out: its text, first comment and time. Only this destination changes: if the same post
  // also goes elsewhere, this one gets its own copy (with its own copy of the media).
  const EDITABLE = ['queued', 'awaiting_join', 'needs_login', 'failed', 'cancelled'];
  // Sent as JSON, or as a form when photos change: keep_media (JSON list of the media ids to keep) plus new "media" files.
  app.patch('/api/jobs/:id', upload.array('media', LIMITS.maxFiles), (req, res) => {
    const files = req.files ?? [];
    const cleanup = () => files.forEach((f) => fs.rmSync(f.path, { force: true }));
    const copied = [];
    try {
      const job = db.prepare(`SELECT j.*, p.body, p.first_comment, d.platform, d.name AS destination_name FROM jobs j
        JOIN posts p ON p.id = j.post_id JOIN destinations d ON d.id = j.destination_id WHERE j.id = ?`).get(req.params.id);
      if (!job) throw new HttpError(404, 'Post not found');
      if (!EDITABLE.includes(job.status)) throw new HttpError(409, "Only posts that haven't gone out can be edited");
      const b = req.body ?? {};
      const body = 'body' in b ? String(b.body ?? '') : job.body;
      const firstComment = 'first_comment' in b ? (String(b.first_comment ?? '').trim() || null) : job.first_comment;
      if (body.length > 63206) throw new HttpError(400, 'The post is too long');
      if (firstComment && firstComment.length > 2000) throw new HttpError(400, 'The first comment must be 2000 characters or less');
      const media = db.prepare('SELECT * FROM post_media WHERE post_id = ? ORDER BY id').all(job.post_id);
      let keep = media;
      if ('keep_media' in b) {
        let ids;
        try { ids = (typeof b.keep_media === 'string' ? JSON.parse(b.keep_media) : b.keep_media).map(Number); } catch { throw new HttpError(400, 'Invalid media choice'); }
        keep = media.filter((m) => ids.includes(m.id));
      }
      const addKinds = files.map((f) => mediaKind(f.mimetype));
      if (addKinds.includes(null)) throw new HttpError(400, 'Only images and videos can be attached');
      const kinds = [...keep.map((m) => m.kind), ...addKinds];
      if (kinds.length > LIMITS.maxFiles) throw new HttpError(400, `At most ${LIMITS.maxFiles} files`);
      if (kinds.filter((k) => k === 'video').length > 1) throw new HttpError(400, 'Only one video per post');
      if (kinds.includes('video') && kinds.includes('image')) throw new HttpError(400, 'Attach either images or one video, not both');
      const total = keep.reduce((n, m) => n + (m.size_bytes || 0), 0) + files.reduce((n, f) => n + f.size, 0);
      if (total > LIMITS.maxTotalBytes) throw new HttpError(400, `Attachments must total ${sizeLabel(LIMITS.maxTotalBytes)} or less`);
      const problem = mediaProblem(job.platform, kinds);
      if (problem) throw new HttpError(400, `${problem} (${job.destination_name})`);
      if (!body.trim() && !kinds.length) throw new HttpError(400, 'Write some text or attach media');
      let scheduledAt = job.scheduled_at;
      if (b.scheduled_at) {
        const d = new Date(b.scheduled_at);
        if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Pick a valid date and time');
        scheduledAt = d.toISOString();
      }
      const mediaChanged = files.length > 0 || keep.length !== media.length;
      const changed = mediaChanged || body !== job.body || firstComment !== job.first_comment;
      const removedFiles = [];
      tx(db, () => {
        let postId = job.post_id;
        const shared = Boolean(db.prepare('SELECT 1 FROM jobs WHERE post_id = ? AND id != ?').get(job.post_id, job.id));
        if (changed && shared) {
          postId = db.prepare('INSERT INTO posts(body, first_comment, created_at) VALUES (?, ?, ?) RETURNING id').get(body, firstComment, nowIso()).id;
        } else if (changed) {
          db.prepare('UPDATE posts SET body = ?, first_comment = ? WHERE id = ?').run(body, firstComment, postId);
        }
        const dir = path.join(p.media, String(postId));
        fs.mkdirSync(dir, { recursive: true });
        if (changed && shared) {
          for (const m of keep) {
            const target = path.join(dir, path.basename(m.path));
            fs.copyFileSync(m.path, target);
            copied.push(target);
            db.prepare('INSERT INTO post_media(post_id, path, kind, size_bytes) VALUES (?, ?, ?, ?)').run(postId, target, m.kind, m.size_bytes);
          }
        } else if (mediaChanged) {
          for (const m of media.filter((x) => !keep.includes(x))) {
            db.prepare('DELETE FROM post_media WHERE id = ?').run(m.id);
            removedFiles.push(m.path);
          }
        }
        const start = db.prepare('SELECT COUNT(*) AS n FROM post_media WHERE post_id = ?').get(postId).n;
        files.forEach((f, i) => {
          const target = path.join(dir, `${Date.now()}-${start + i + 1}-${safeName(f.originalname)}`);
          fs.renameSync(f.path, target);
          copied.push(target);
          db.prepare('INSERT INTO post_media(post_id, path, kind, size_bytes) VALUES (?, ?, ?, ?)').run(postId, target, addKinds[i], f.size);
        });
        db.prepare('UPDATE jobs SET post_id = ?, scheduled_at = ? WHERE id = ?').run(postId, scheduledAt, job.id);
      });
      removedFiles.forEach((f) => fs.rmSync(f, { force: true }));
      res.json(db.prepare(`${JOB_SELECT} WHERE j.id = ?`).get(job.id));
    } catch (err) {
      copied.forEach((f) => fs.rmSync(f, { force: true }));
      cleanup();
      throw err;
    }
  });

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
  app.post('/api/jobs/:id/mark-posted', transition(['needs_check', 'pending_approval'], 'submitted', ', next_check_at = NULL'));
  // Look at a post waiting for group approval on the worker's next pass instead of at the next planned look.
  app.post('/api/jobs/:id/check-approval', (req, res) => {
    const row = db.prepare(`UPDATE jobs SET next_check_at = ? WHERE id = ? AND status = 'pending_approval' RETURNING id`).get(nowIso(), req.params.id);
    if (!row) throw new HttpError(409, 'Only posts waiting for approval can be checked');
    res.json({ checking: true });
  });

  // ---- worker control
  app.post('/api/worker/start', async (req, res) => {
    if (workerAlive(p.lock)) throw new HttpError(409, 'The worker is already running');
    const notReady = setupState().readiness.checks.find((c) => !c.ok);
    if (notReady) throw new HttpError(409, `Setup isn't finished, so scheduled posts can't run yet. Open Setup and ${notReady.todo}.`);
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

  // ---- first-run setup: Claude Code installed and logged in with a Claude subscription, the Chrome extension
  // installed, and a test automation that drove Chrome end to end. Scheduled posts wait until all four pass.
  function setupState() {
    const bin = findClaude();
    const auth = claudeAuthStatus(bin);
    const settings = getSettings(db);
    const s = {
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
      // Accounts logged in inside the desktop app: posts from them don't need Chrome or the extension.
      app_accounts: db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE login_state = 'connected'").get().n,
      verified_at: settings.setup_verified_at || null,
    };
    // A test run on another Claude account doesn't count for this one.
    const sameAccount = !settings.setup_verified_account || !s.email || settings.setup_verified_account === s.email;
    const checks = [
      { id: 'installed', label: 'Claude Code installed', todo: 'install Claude Code', ok: s.claude_installed },
      { id: 'auth', label: 'Signed in with a Claude Pro or Max subscription', todo: 'log in with a Claude Pro or Max subscription',
        ok: s.logged_in && s.subscription && s.paid_plan !== false },
      { id: 'extension', label: 'An account logged in inside Autoposter (or the Claude in Chrome extension)',
        todo: 'log in to an account on the Accounts page', ok: s.app_accounts > 0 || s.chrome_extension.length > 0 },
      { id: 'automation', label: 'Test automation passed', todo: 'run the test automation', ok: Boolean(s.verified_at) && sameAccount },
    ];
    s.readiness = { ready: checks.every((c) => c.ok), checks };
    return s;
  }

  app.get('/api/setup', (req, res) => res.json(setupState()));
  // Asks Claude to list the Chrome browsers it can reach. Uses a tiny amount of the person's Claude usage.
  app.post('/api/setup/test-chrome', async (req, res) => {
    const bin = findClaude();
    if (!bin) throw new HttpError(409, 'Install Claude Code first');
    res.json(await testChromeConnection(bin, p));
  });
  // A real run in Chrome (open a tab, load Facebook, look, close it). Passing it unlocks scheduled posts.
  let testRunning = false;
  app.post('/api/setup/test-automation', async (req, res) => {
    const s = setupState();
    const blocking = s.readiness.checks.find((c) => c.id !== 'automation' && !c.ok);
    if (blocking) throw new HttpError(409, `First ${blocking.todo}`);
    if (testRunning) throw new HttpError(409, 'A test is already running');
    testRunning = true;
    let result;
    try {
      // With an account logged in inside the app, the test drives the app's own window instead of Chrome.
      const account = browser ? db.prepare("SELECT * FROM accounts WHERE login_state = 'connected' ORDER BY is_default DESC, id LIMIT 1").get() : null;
      result = await runTestAutomation(s.claude_path, p, { model: getSettings(db).model, account });
    } finally {
      testRunning = false;
    }
    setSetting(db, 'setup_verified_at', result.ok ? nowIso() : '');
    setSetting(db, 'setup_verified_account', result.ok ? (s.email || '') : '');
    res.json({ ...result, setup: setupState() });
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
      max_upload_bytes: LIMITS.maxTotalBytes,
      counts,
    });
  });

  // Only the desktop app checks: people running from source update with git pull.
  app.get('/api/update', async (req, res) => {
    res.json(IN_ELECTRON || process.env.AUTOPOSTER_UPDATE_URL ? await checkForUpdate() : { current: APP_VERSION, available: false });
  });

  app.post('/api/update/install', async (req, res) => {
    try {
      res.json(await installUpdate());
    } catch (err) {
      throw new HttpError(409, err.message);
    }
  });

  app.post('/api/update/restart', (req, res) => {
    if (!canRestart()) throw new HttpError(409, 'Restart the app yourself to finish the update');
    res.status(204).end();
    setTimeout(restartApp, 300);
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
