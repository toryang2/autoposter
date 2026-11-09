async function request(method, url, body) {
  const init = { method };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  status: () => request('GET', '/api/status'),
  destinations: () => request('GET', '/api/destinations'),
  addDestination: (d) => request('POST', '/api/destinations', d),
  updateDestination: (id, d) => request('PATCH', `/api/destinations/${id}`, d),
  removeDestination: (id) => request('DELETE', `/api/destinations/${id}`),
  createPost: (form) => request('POST', '/api/posts', form),
  aiCompose: (input) => request('POST', '/api/ai/compose', input),
  aiComment: (input) => request('POST', '/api/ai/comment', input),
  aiImage: (input) => request('POST', '/api/ai/image', input),
  postMedia: (id) => request('GET', `/api/posts/${id}/media`),
  jobs: (status) => request('GET', `/api/jobs${status === 'delayed' ? '?delayed=1' : status ? `?status=${status}` : ''}`),
  jobsBetween: (from, to) => request('GET', `/api/jobs?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`),
  jobLog: (id) => request('GET', `/api/jobs/${id}/log`),
  jobAction: (id, action) => request('POST', `/api/jobs/${id}/${action}`),
  // pick: "a<account id>", "p<page id>", or nothing to keep who posts it.
  postNow: (id, pick) => request('POST', `/api/jobs/${id}/post-now`,
    pick?.startsWith('p') ? { page_id: Number(pick.slice(1)) } : pick ? { account_id: Number(String(pick).replace(/^a/, '')) } : {}),
  removeJob: (id) => request('DELETE', `/api/jobs/${id}`),
  editJob: (id, changes) => request('PATCH', `/api/jobs/${id}`, changes),
  setJobLink: (id, url) => request('POST', `/api/jobs/${id}/link`, { url }),
  startWorker: () => request('POST', '/api/worker/start'),
  stopWorker: () => request('POST', '/api/worker/stop'),
  // Served by the Vite dev server (web/vite.config.js), since a dead API server can't restart itself.
  restartServer: () => request('POST', '/__dev/restart-server'),
  setup: () => request('GET', '/api/setup'),
  installClaude: () => request('POST', '/api/setup/install-claude'),
  loginClaude: () => request('POST', '/api/setup/login'),
  testChrome: () => request('POST', '/api/setup/test-chrome'),
  testAutomation: () => request('POST', '/api/setup/test-automation'),
  accounts: () => request('GET', '/api/accounts'),
  addAccount: (a) => request('POST', '/api/accounts', a),
  updateAccount: (id, a) => request('PATCH', `/api/accounts/${id}`, a),
  removeAccount: (id) => request('DELETE', `/api/accounts/${id}`),
  accountsInApp: () => request('GET', '/api/accounts/app'),
  loginAccount: (id) => request('POST', `/api/accounts/${id}/login`),
  openAccount: (id) => request('POST', `/api/accounts/${id}/open`),
  refreshPages: (id) => request('POST', `/api/accounts/${id}/pages/refresh`),
  logoutAccount: (id) => request('POST', `/api/accounts/${id}/logout`),
  update: () => request('GET', '/api/update'),
  installUpdate: () => request('POST', '/api/update/install'),
  restartForUpdate: () => request('POST', '/api/update/restart'),
  settings: () => request('GET', '/api/settings'),
  saveSettings: (s) => request('PUT', '/api/settings', s),
};

export const TYPE_LABEL = { profile: 'Profile', page: 'Page', group: 'Group' };
// Mirrors src/platforms.js.
export const PLATFORMS = {
  facebook: { label: 'Facebook', types: ['profile', 'page', 'group'], posting: true, maxImages: 10, example: 'https://www.facebook.com/…',
    accountHint: 'Open facebook.com/me while logged in to this account and paste the address it lands on.' },
  linkedin: { label: 'LinkedIn', types: ['profile', 'page', 'group'], posting: true, maxImages: 10, example: 'https://www.linkedin.com/in/…' },
  x: { label: 'X', types: ['profile'], posting: true, maxImages: 4, example: 'https://x.com/…' },
  threads: { label: 'Threads', types: ['profile'], posting: true, maxImages: 10, example: 'https://www.threads.com/@…' },
  reddit: { label: 'Reddit', types: ['profile', 'group'], typeLabel: { group: 'Subreddit' }, posting: true, maxImages: 10,
    example: 'https://www.reddit.com/r/…', hint: 'The first line of your post becomes the Reddit title.' },
  instagram: { label: 'Instagram', types: ['profile'], posting: true, maxImages: 10, needs: 'media', example: 'https://www.instagram.com/…' },
  tiktok: { label: 'TikTok', types: ['profile'], posting: true, maxImages: 0, needs: 'video', example: 'https://www.tiktok.com/@…' },
};
// Mirrors mediaProblem() in src/platforms.js.
export function mediaProblem(platform, kinds) {
  const pf = PLATFORMS[platform];
  const images = kinds.filter((k) => k === 'image').length;
  const video = kinds.includes('video');
  if (pf.needs === 'video' && !video) return `${pf.label} needs a video`;
  if (pf.needs === 'media' && !images && !video) return `${pf.label} needs a photo or a video`;
  if (images > pf.maxImages) return pf.maxImages ? `${pf.label} takes at most ${pf.maxImages} photos` : `${pf.label} takes a video, not photos`;
  return null;
}
export const typeLabel = (platform, type) => PLATFORMS[platform]?.typeLabel?.[type] ?? TYPE_LABEL[type];
export const AUDIENCE_LABEL = { default: 'Composer default', public: 'Public', friends: 'Friends', only_me: 'Only me' };
// Social links open inside the desktop app with this account's login (electron/main.js reads the #ap-account hint).
export const inApp = (url, accountId) => (url && accountId && !url.includes('#') ? `${url}#ap-account=${accountId}` : url);

export const STATUS_LABEL = {
  queued: 'Queued', running: 'Posting…', submitted: 'Posted', pending_approval: 'Pending approval',
  awaiting_join: 'Waiting to join', delayed: 'Delayed', failed: 'Failed', cancelled: 'Cancelled', needs_check: 'Needs check', needs_login: 'Needs login',
};

export function formatWhen(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
