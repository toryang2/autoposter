import React, { useEffect, useState } from 'react';
import { Alert, Box, Button, IconButton, ListItemIcon, Menu, MenuItem, Paper, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { ChevronDown, CircleUserRound, ExternalLink, Flag, LogIn, LogOut, MoreHorizontal, PanelTop, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, inApp as appLink, PLATFORMS } from '../api.js';
import { AccountPic, EmptyState, Panel, PlatformLabel } from '../components.jsx';

const EMPTY = { platform: 'facebook', name: '', profile_url: '' };

const LOGIN = {
  connected: { color: '#16A34A', label: 'Logged in' },
  needs_login: { color: '#D97706', label: 'Login expired' },
  none: { color: '#A8A29E', label: 'Not logged in' },
};

const AVATAR_COLORS = ['#FF5A1F', '#2563EB', '#7C3AED', '#0D9488', '#DB2777', '#CA8A04'];
const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';
// "facebook.com/ruel.nopal.5" instead of the full link.
const shortLink = (url) => url.replace(/^https:\/\/(www\.)?/, '').replace(/\/$/, '');

function Avatar({ account, inApp }) {
  const l = LOGIN[account.login_state] || LOGIN.none;
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [account.avatar_v]);
  return (
    <Box sx={{ position: 'relative', flex: 'none' }}>
      {account.avatar_v && !broken ? (
        // The profile picture the desktop app saved from the account's own page after logging in.
        <Box component="img" src={`/api/accounts/${account.id}/avatar?v=${account.avatar_v}`} alt="" onError={() => setBroken(true)}
          sx={{ width: 42, height: 42, borderRadius: '50%', objectFit: 'cover', display: 'block', bgcolor: 'action.hover' }} />
      ) : (
        <Box sx={{ width: 42, height: 42, borderRadius: '50%', display: 'grid', placeItems: 'center',
          bgcolor: AVATAR_COLORS[account.id % AVATAR_COLORS.length], color: '#fff', fontWeight: 750, fontSize: 15 }}>
          {initials(account.name)}
        </Box>
      )}
      {inApp && (
        <Tooltip title={l.label}>
          <Box sx={{ position: 'absolute', right: -1, bottom: -1, width: 13, height: 13, borderRadius: '50%',
            bgcolor: l.color, border: '2.5px solid', borderColor: 'background.paper' }} />
        </Tooltip>
      )}
    </Box>
  );
}

// The Pages a Facebook account manages, read from Facebook. They need no login: the account switches into a Page to post.
function AccountPages({ a }) {
  const [open, setOpen] = useState(false);
  if (!a.pages?.length) return null;
  return (
    <Box sx={{ pl: 7.25, pb: 1.25, mt: -0.5 }}>
      <Button size="small" color="secondary" onClick={() => setOpen(!open)} startIcon={<Flag size={14} />}
        endIcon={<ChevronDown size={14} style={{ transition: 'transform .2s', transform: open ? 'rotate(180deg)' : 'none' }} />}
        sx={{ px: 1, fontSize: 12.5, color: 'text.secondary' }}>
        {a.pages.length} Page{a.pages.length === 1 ? '' : 's'} it manages
      </Button>
      {open && (
        <Box sx={{ display: 'grid', gap: 0.75, mt: 0.75, gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
          {a.pages.map((pg) => (
            <Stack key={pg.id} component="a" href={appLink(pg.url, a.id)} target="_blank" rel="noreferrer" direction="row" alignItems="center" spacing={1}
              sx={{ p: 0.75, borderRadius: '3px', color: 'inherit', textDecoration: 'none', '&:hover': { bgcolor: 'background.default' } }}>
              <AccountPic account={{ id: pg.id, name: pg.name }} size={28} src={pg.avatar_v ? `/api/pages/${pg.id}/avatar?v=${pg.avatar_v}` : null} />
              <Box sx={{ minWidth: 0 }}>
                <Typography fontSize={13.5} fontWeight={650} noWrap>{pg.name}</Typography>
                <Typography fontSize={11.5} color="text.secondary" noWrap>{shortLink(pg.url)}</Typography>
              </Box>
            </Stack>
          ))}
        </Box>
      )}
    </Box>
  );
}

function AccountRow({ a, inApp, act }) {
  const [menu, setMenu] = useState(null);
  const l = LOGIN[a.login_state] || LOGIN.none;
  const close = () => setMenu(null);
  const item = (fn) => () => { close(); act(fn)(); };
  return (
    <Stack direction="row" alignItems="center" spacing={1.75} sx={{ py: 1.5 }}>
      <Avatar account={a} inApp={inApp && !a.page_of} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
          <Typography fontWeight={700} fontSize={15.5} noWrap>{a.name}</Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary" noWrap sx={{ fontSize: 13 }}>
          {a.page_of
            ? <Box component="span" sx={{ fontWeight: 650 }}>Page of {a.page_of.name} · no login needed</Box>
            : inApp && <Box component="span" sx={{ color: l.color, fontWeight: 650 }}>{l.label}</Box>}
          {(inApp || a.page_of) && ' · '}{shortLink(a.profile_url)}
        </Typography>
      </Box>
      {a.page_of ? (
        // A Page opens inside Autoposter with the account that manages it, where Facebook offers to switch into the Page.
        <Tooltip title={`Opens the Page with ${a.page_of.name}, which manages it`}>
          <Button size="small" variant="outlined" color="secondary" startIcon={<PanelTop size={15} />} sx={{ flex: 'none' }}
            component="a" href={appLink(a.profile_url, a.page_of.id)} target="_blank" rel="noreferrer">Open as admin</Button>
        </Tooltip>
      ) : inApp && (a.login_state === 'connected'
        ? <Button size="small" variant="outlined" color="secondary" startIcon={<PanelTop size={15} />} sx={{ flex: 'none' }}
            onClick={act(async () => { await api.openAccount(a.id); return api.accounts(); })}>Open</Button>
        : <Button size="small" variant="contained" startIcon={<LogIn size={15} />} sx={{ flex: 'none' }}
            onClick={act(async () => { await api.loginAccount(a.id); return api.accounts(); })}>
            {a.login_state === 'needs_login' ? 'Log in again' : 'Log in'}
          </Button>)}
      <IconButton size="small" onClick={(e) => setMenu(e.currentTarget)} aria-label="More"><MoreHorizontal size={18} /></IconButton>
      <Menu anchorEl={menu} open={Boolean(menu)} onClose={close} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}>
        <MenuItem component="a" href={appLink(a.profile_url, a.page_of?.id ?? a.id)} target="_blank" rel="noreferrer" onClick={close}>
          <ListItemIcon><ExternalLink size={16} /></ListItemIcon>Open profile
        </MenuItem>
        {inApp && a.platform === 'facebook' && a.login_state === 'connected' && !a.page_of && (
          <MenuItem onClick={item(() => api.refreshPages(a.id))}>
            <ListItemIcon><RefreshCw size={16} /></ListItemIcon>Refresh Pages
          </MenuItem>
        )}
        {inApp && a.login_state === 'connected' && (
          <MenuItem onClick={item(() => api.logoutAccount(a.id))}>
            <ListItemIcon><LogOut size={16} /></ListItemIcon>Log out
          </MenuItem>
        )}
        <MenuItem onClick={item(() => api.removeAccount(a.id))} sx={{ color: 'error.main' }}>
          <ListItemIcon sx={{ color: 'error.main' }}><Trash2 size={16} /></ListItemIcon>{a.page_of ? 'Remove from this list' : 'Remove account'}
        </MenuItem>
      </Menu>
    </Stack>
  );
}

/**
 * The person's own accounts, per platform. In the desktop app each account logs in once, in its own Autoposter
 * window with its own saved login, and they all stay logged in at the same time: Claude posts from that account's own
 * hidden window, with no switching. Compose picks which accounts post each post.
 */
export default function Accounts() {
  const [list, setList] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const [inApp, setInApp] = useState(false);

  const load = () => api.accounts().then(setList).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    api.accountsInApp().then((r) => setInApp(r.available)).catch(() => {});
    const t = setInterval(load, 3000); // a login finishing in the in-app pane turns the dot green
    return () => clearInterval(t);
  }, []);

  async function add(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const row = await api.addAccount(form);
      setNotice(row.page_of ? `Added "${row.name}" as a Page of ${row.page_of.name}. Pages need no login: ${row.page_of.name} switches into it to post.` : '');
      setForm({ ...EMPTY, platform: form.platform });
      await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const act = (fn) => async () => { setError(''); try { setList(await fn()); } catch (err) { setError(err.message); } };

  const platforms = Object.keys(PLATFORMS).filter((p) => (list || []).some((a) => a.platform === p));
  const pf = PLATFORMS[form.platform];

  return (
    <Box sx={{ display: 'grid', gap: 2.5, gridTemplateColumns: { xs: '1fr', lg: '1.5fr 1fr' }, alignItems: 'start' }}>
      <Stack spacing={2.5}>
        {error && <Alert severity="error">{error}</Alert>}
        {notice && <Alert severity="success" onClose={() => setNotice('')}>{notice}</Alert>}
        {list && !list.length && (
          <Paper>
            <EmptyState icon={CircleUserRound} title="No accounts added yet">
              <Typography variant="body2">
                Add each account you post from, like your two Facebook accounts. Then pick which one posts when you compose.
              </Typography>
            </EmptyState>
          </Paper>
        )}
        {platforms.map((p) => (
          <Panel key={p} title={<PlatformLabel platform={p} label={PLATFORMS[p].label} size={22} />}
            action={<Typography variant="caption" color="text.secondary">{list.filter((a) => a.platform === p).length} account{list.filter((a) => a.platform === p).length === 1 ? '' : 's'}</Typography>}>
            <Stack divider={<Box sx={{ borderTop: '1px solid', borderColor: 'divider' }} />}>
              {list.filter((a) => a.platform === p).map((a) => (
                <Box key={a.id}><AccountRow a={a} inApp={inApp} act={act} /><AccountPages a={a} /></Box>
              ))}
            </Stack>
          </Panel>
        ))}
      </Stack>

      <Panel title="Add an account" sx={{ position: { lg: 'sticky' }, top: { lg: 24 } }}>
        <Stack component="form" spacing={2} onSubmit={add}>
          <TextField select label="Platform" value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>
            {Object.entries(PLATFORMS).map(([k, v]) => <MenuItem key={k} value={k}><PlatformLabel platform={k} label={v.label} /></MenuItem>)}
          </TextField>
          <TextField label="Name" value={form.name} placeholder="e.g. Ruel (personal) or Shop account"
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <TextField label="Profile link" value={form.profile_url} placeholder={pf.example}
            helperText={pf.accountHint || `The link to this ${pf.label} account's own profile.`}
            onChange={(e) => setForm({ ...form, profile_url: e.target.value })} />
          <Button type="submit" variant="contained" startIcon={<Plus size={17} />} disabled={busy || !form.name.trim() || !form.profile_url.trim()}>
            Add account
          </Button>
        </Stack>
      </Panel>
    </Box>
  );
}
