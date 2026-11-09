import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert, Badge, Box, Button, Drawer, IconButton, List, ListItemButton, ListItemIcon, ListItemText,
  Stack, Typography, useMediaQuery,
} from '@mui/material';
import { CalendarDays, CircleUserRound, LayoutDashboard, Rocket, RotateCw, ListChecks, MapPin, Menu, Plus, Send, Settings as SettingsIcon, SquarePen, Sparkles } from 'lucide-react';
import { api, formatWhen } from './api.js';
import { tokens } from './theme.js';
import { WorkerControl } from './components.jsx';
import Overview from './pages/Overview.jsx';
import Calendar from './pages/Calendar.jsx';
import Compose from './pages/Compose.jsx';
import Queue from './pages/Queue.jsx';
import Destinations from './pages/Destinations.jsx';
import Accounts from './pages/Accounts.jsx';
import Settings from './pages/Settings.jsx';
import Setup, { setupReady } from './pages/Setup.jsx';

const DRAWER = 252;
// Read before the app writes its own hash, so a first visit with no page in the URL can open Setup.
const INITIAL_HASH = location.hash.slice(1);

const PAGES = [
  { key: 'overview', label: 'Dashboard', subtitle: 'Today at a glance', icon: LayoutDashboard },
  { key: 'calendar', label: 'Calendar', subtitle: 'Your posting plan, day by day', icon: CalendarDays },
  { key: 'compose', label: 'Compose', subtitle: 'Write once, schedule everywhere', icon: SquarePen },
  { key: 'queue', label: 'Queue', subtitle: 'Every scheduled post and how it went', icon: ListChecks },
  { key: 'destinations', label: 'Destinations', subtitle: 'Your profile, Pages and groups', icon: MapPin },
  { key: 'accounts', label: 'Accounts', subtitle: 'Every account you post from, and its Pages', icon: CircleUserRound },
  { key: 'settings', label: 'Settings', subtitle: 'Pacing, limits and the Claude model', icon: SettingsIcon },
  { key: 'setup', label: 'Setup', subtitle: 'Connect Claude Code and Chrome, once', icon: Rocket },
];

function RestartServer() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function restart() {
    setBusy(true);
    setError('');
    try { await api.restartServer(); location.reload(); } catch (e) { setError(e.message); setBusy(false); }
  }
  return (
    <Box mt={1.75}>
      <Button size="small" variant="contained" fullWidth disabled={busy} onClick={restart}
        startIcon={<RotateCw size={15} className={busy ? 'spin' : undefined} />}>
        {busy ? 'Restarting…' : 'Restart server'}
      </Button>
      {error && <Typography variant="caption" sx={{ color: '#FF6B5B', display: 'block', mt: 0.75 }}>{error}</Typography>}
    </Box>
  );
}

// Shown when latest.json on GitHub names a newer version. "Update now" installs the new code and restarts the app;
// when the update needs a new installer, the buttons link to the store instead. "Later" hides it until the next version.
function UpdateBanner({ update }) {
  const key = 'dismissedUpdate';
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(key); } catch { return null; } });
  const [stage, setStage] = useState('idle'); // idle | installing | restarting | failed
  const [error, setError] = useState('');
  if (!update?.available || dismissed === update.latest) return null;
  const later = () => {
    try { localStorage.setItem(key, update.latest); } catch { /* storage unavailable */ }
    setDismissed(update.latest);
  };
  async function install() {
    setStage('installing');
    setError('');
    try {
      await api.installUpdate();
      setStage('restarting');
      await api.restartForUpdate();
      // The app comes back on its own; reload once the server answers again.
      const wait = setInterval(() => api.status().then(() => { clearInterval(wait); location.reload(); }).catch(() => {}), 1500);
    } catch (e) {
      setError(e.message);
      setStage('failed');
    }
  }
  const busy = stage === 'installing' || stage === 'restarting';
  const auto = update.auto && stage !== 'failed';
  return (
    <Alert severity={stage === 'failed' ? 'warning' : 'info'} icon={<Sparkles size={20} />} sx={{ mt: { xs: 2, md: 3 }, alignItems: 'center' }}
      action={(
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          {auto ? (
            <Button size="small" variant="contained" disabled={busy} onClick={install}
              startIcon={busy ? <RotateCw size={15} className="spin" /> : undefined}>
              {stage === 'installing' ? 'Updating…' : stage === 'restarting' ? 'Restarting…' : 'Update now'}
            </Button>
          ) : update.links.map((l) => (
            <Button key={l.url} size="small" variant="contained" href={l.url} target="_blank" rel="noopener noreferrer">{l.label}</Button>
          ))}
          {!busy && <Button size="small" color="inherit" onClick={later}>Later</Button>}
        </Stack>
      )}>
      <Typography fontWeight={700}>Autoposter {update.latest} is out</Typography>
      <Typography variant="body2">
        {update.notes || 'A free update for everyone who bought the app.'} You have {update.current}.{' '}
        {auto
          ? 'Updating takes a few seconds and restarts the app. Your accounts, posts and schedule stay.'
          : 'Download it from where you bought it and install it over this one: your accounts, posts and schedule stay.'}
      </Typography>
      {error && <Typography variant="body2" fontWeight={600} mt={0.5}>{error}</Typography>}
    </Alert>
  );
}

function WorkerCard({ status, onChange, blocked }) {
  const running = status?.worker_running;
  const paused = status?.paused_until && new Date(status.paused_until) > new Date();
  const pct = status ? Math.min(100, (status.posted_today / status.daily_cap) * 100) : 0;
  return (
    <Box sx={{ p: 2, borderRadius: '3px', bgcolor: tokens.inkSoft, border: '1px solid #2E323B' }}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Box className={running ? 'pulse' : undefined}
          sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: !status ? tokens.inkMuted : running ? '#3DDC84' : '#FF6B5B' }} />
        <Typography variant="body2" fontWeight={700} color="#fff">
          {!status ? 'Server unreachable' : running ? 'Worker running' : 'Worker stopped'}
        </Typography>
      </Stack>
      {!status && <RestartServer />}
      {status && !running && (
        <Typography variant="caption" sx={{ color: tokens.inkMuted, display: 'block', mt: 0.5 }}>
          {blocked ? 'On hold until Setup is finished' : "Scheduled posts won't go out"}
        </Typography>
      )}
      {paused && (
        <Typography variant="caption" sx={{ color: '#FFB547', display: 'block', mt: 0.5 }}>
          Paused until {formatWhen(status.paused_until)}
        </Typography>
      )}
      {status && (
        <Box mt={1.75}>
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="caption" sx={{ color: tokens.inkMuted }}>Posted today</Typography>
            <Typography variant="caption" fontWeight={700} color="#fff">{status.posted_today} / {status.daily_cap}</Typography>
          </Stack>
          <Box sx={{ mt: 0.75, height: 5, borderRadius: 3, bgcolor: '#353945', overflow: 'hidden' }}>
            <Box sx={{ width: `${pct}%`, height: '100%', bgcolor: 'primary.main', transition: 'width .4s' }} />
          </Box>
        </Box>
      )}
      {status && !status.worker_launchd && (
        <Box mt={1.75}>
          <WorkerControl status={status} onChange={onChange} size="small" blocked={blocked}
            sx={{ width: '100%', borderRadius: '3px', ...(status.worker_running ? { color: '#B6BAC4', borderColor: '#3A3E48' } : {}) }} />
        </Box>
      )}
    </Box>
  );
}

function Sidebar({ page, go, status, onStatusChange, setupDone, blocked, version }) {
  const needsCheck = status?.counts?.needs_check || 0;
  return (
    <Stack sx={{ height: '100%', bgcolor: tokens.ink, color: '#fff', p: 2, gap: 3 }}>
      <Stack direction="row" alignItems="center" spacing={1.25} sx={{ px: 1, pt: 0.5 }}>
        <Box sx={{ width: 34, height: 34, borderRadius: '10px', bgcolor: 'primary.main', display: 'grid', placeItems: 'center',
          boxShadow: '0 8px 20px -8px rgba(255,91,31,.8)' }}>
          <Send size={17} color="#fff" />
        </Box>
        <Box>
          <Typography sx={{ fontFamily: '"Bricolage Grotesque Variable"', fontWeight: 700, fontSize: 18, lineHeight: 1.1 }}>Autoposter</Typography>
          <Typography variant="caption" sx={{ color: tokens.inkMuted }}>Social post scheduler{version ? ` · v${version}` : ''}</Typography>
        </Box>
      </Stack>

      <Box>
        <Typography variant="overline" sx={{ color: tokens.inkMuted, px: 1.5 }}>Workspace</Typography>
        <List dense disablePadding sx={{ mt: 0.5 }}>
          {PAGES.map(({ key, label, icon: Icon }) => {
            const active = page === key;
            return (
              <ListItemButton key={key} selected={active} onClick={() => go(key)}
                sx={{
                  mb: 0.5, py: 1, color: active ? '#fff' : '#B6BAC4',
                  '&:hover': { bgcolor: tokens.inkSoft, color: '#fff' },
                  '&.Mui-selected, &.Mui-selected:hover': { bgcolor: tokens.inkSoft, color: '#fff' },
                  position: 'relative',
                  '&::before': active ? { content: '""', position: 'absolute', left: -16, top: 8, bottom: 8, width: 3,
                    borderRadius: 3, bgcolor: 'primary.main' } : undefined,
                }}>
                <ListItemIcon sx={{ minWidth: 34, color: active ? 'primary.main' : 'inherit' }}><Icon size={18} /></ListItemIcon>
                <ListItemText primary={label} slotProps={{ primary: { fontWeight: active ? 700 : 550, fontSize: 14 } }} />
                {key === 'queue' && needsCheck > 0 && <Badge badgeContent={needsCheck} color="warning" sx={{ mr: 1 }} />}
                {key === 'setup' && setupDone === false && <Badge variant="dot" color="primary" sx={{ mr: 1.5 }} />}
              </ListItemButton>
            );
          })}
        </List>
      </Box>

      <Box sx={{ mt: 'auto' }}><WorkerCard status={status} onChange={onStatusChange} blocked={blocked} /></Box>
    </Stack>
  );
}

export default function App() {
  const [page, setPage] = useState(() => {
    const h = location.hash.slice(1);
    return PAGES.some((p) => p.key === h) ? h : 'overview';
  });
  const [status, setStatus] = useState(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [composeWhen, setComposeWhen] = useState(null);
  const [setup, setSetup] = useState(null);
  const [update, setUpdate] = useState(null);
  useEffect(() => { api.update().then(setUpdate).catch(() => {}); }, []);
  // First run: open Setup until every readiness check passes.
  useEffect(() => {
    api.setup().then((s) => {
      setSetup(s);
      if (!setupReady(s) && !INITIAL_HASH) setPage('setup');
    }).catch(() => {});
  }, []);
  const desktop = useMediaQuery((t) => t.breakpoints.up('md'));

  const refreshStatus = useCallback(() => api.status().then(setStatus).catch(() => setStatus(null)), []);
  useEffect(() => {
    refreshStatus();
    const t = setInterval(refreshStatus, 10_000);
    return () => clearInterval(t);
  }, [refreshStatus]);
  useEffect(() => { location.hash = page; }, [page]);
  // The in-app browser covers the page beside the sidebar: a click anywhere Autoposter's own screen shows
  // (the sidebar, even the page already open) closes it, so it never gets stuck on top.
  useEffect(() => {
    const close = () => { fetch('/api/browser/close', { method: 'POST' }).catch(() => {}); };
    window.addEventListener('mousedown', close, true);
    return () => window.removeEventListener('mousedown', close, true);
  }, []);
  useEffect(() => {
    const onHash = () => {
      const h = location.hash.slice(1);
      if (PAGES.some((p) => p.key === h)) setPage(h);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // go('queue', { filter: 'failed' }) opens the Queue on that filter (the Dashboard cards).
  const [queueFilter, setQueueFilter] = useState('');
  const go = (key, opts) => { if (key === 'compose') setComposeWhen(null); if (key === 'queue') setQueueFilter(opts?.filter ?? ''); setPage(key); setMobileOpen(false); };
  const composeAt = (date) => { setComposeWhen(date); setPage('compose'); };
  const current = PAGES.find((p) => p.key === page);
  const ready = setup ? setupReady(setup) : undefined;
  // Scheduled posts stay on hold until every Setup check passes; the server and worker enforce it too.
  const blocked = ready === false ? 'Finish Setup first: scheduled posts are on hold until every check passes' : null;
  const sidebar = <Sidebar page={page} go={go} status={status} onStatusChange={refreshStatus} setupDone={ready} blocked={blocked} version={update?.current} />;

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      {desktop ? (
        <Box component="nav" sx={{ width: DRAWER, flex: 'none', position: 'sticky', top: 0, height: '100vh' }}>{sidebar}</Box>
      ) : (
        <Drawer open={mobileOpen} onClose={() => setMobileOpen(false)}
          slotProps={{ paper: { sx: { width: DRAWER, border: 0, bgcolor: tokens.ink } } }}>{sidebar}</Drawer>
      )}

      <Box component="main" className="canvas" sx={{ flex: 1, minWidth: 0, px: { xs: 2, md: 5 }, pb: 6 }}>
        <Box sx={{ maxWidth: 1440, mx: 'auto' }}>
          <UpdateBanner update={update} />
          <Stack direction="row" alignItems="center" spacing={2} sx={{ pt: { xs: 2.5, md: 4 }, pb: 3 }}>
            {!desktop && <IconButton onClick={() => setMobileOpen(true)} aria-label="Open menu"><Menu size={20} /></IconButton>}
            <Box sx={{ flex: 1, minWidth: 0 }} key={page} className="rise">
              <Typography variant="h1">{current.label}</Typography>
              <Typography color="text.secondary" mt={0.25}>{current.subtitle}</Typography>
            </Box>
            {page !== 'compose' && (
              <Button variant="contained" startIcon={<Plus size={18} />} onClick={() => go('compose')}>New post</Button>
            )}
          </Stack>

          <Box key={page} className="rise" sx={{ animationDelay: '60ms' }}>
            {page === 'overview' && <Overview status={status} go={go} onStatusChange={refreshStatus} setup={setup} />}
            {page === 'calendar' && <Calendar onAdd={composeAt} />}
            {page === 'compose' && <Compose ready={ready} goSetup={() => go('setup')} initialWhen={composeWhen} onScheduled={() => { refreshStatus(); go('calendar'); }} goDestinations={() => go('destinations')} />}
            {page === 'queue' && <Queue key={queueFilter} initialFilter={queueFilter} onChange={refreshStatus} />}
            {page === 'destinations' && <Destinations />}
            {page === 'accounts' && <Accounts />}
            {page === 'settings' && <Settings onChange={refreshStatus} />}
            {page === 'setup' && <Setup status={status} onStatusChange={refreshStatus} go={go} onSetupChange={setSetup} />}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
