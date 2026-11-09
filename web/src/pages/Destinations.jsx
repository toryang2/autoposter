import React, { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, MenuItem, Paper, Stack,
  Switch, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import { ExternalLink, Flag, Link, MapPin, Pencil, Plus, Trash2, UserRound, UsersRound } from 'lucide-react';
import { api, AUDIENCE_LABEL, PLATFORMS, typeLabel } from '../api.js';
import { EmptyState, Panel, PlatformLabel, TypeBadge } from '../components.jsx';

const EMPTY = { name: '', platform: 'facebook', type: 'group', url: '', audience: 'default', post_as: '' };
const TYPE_ICON = { profile: UserRound, page: Flag, group: UsersRound };
const HINT = {
  profile: 'https://www.facebook.com/me works for your own profile.',
  page: 'The Page link. Your login must be able to post as this Page.',
  group: 'e.g. https://www.facebook.com/groups/123456789 — you must be a member who can post.',
};
// Change a destination's name, link or kind (profile, Page, group).
function EditDestination({ d, onClose, onSaved }) {
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (d) { setForm({ name: d.name, url: d.url, type: d.type, audience: d.audience }); setError(''); } }, [d]);
  if (!d || !form) return null;
  const pf = PLATFORMS[d.platform];
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try { await api.updateDestination(d.id, form); onSaved(); onClose(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={() => !busy && onClose()} maxWidth="xs" fullWidth>
      <Box component="form" onSubmit={save}>
        <DialogTitle sx={{ fontFamily: '"Bricolage Grotesque Variable"', fontWeight: 700 }}>Edit {typeLabel(d.platform, d.type).toLowerCase()}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {pf.types.length > 1 && (
              <ToggleButtonGroup exclusive fullWidth value={form.type} onChange={(_, v) => v && setForm({ ...form, type: v })}
                sx={{ '& .MuiToggleButton-root': { textTransform: 'none', fontWeight: 650, gap: 0.75, borderColor: 'divider' },
                  '& .Mui-selected': { bgcolor: '#15171C !important', color: '#fff !important' } }}>
                {pf.types.map((k) => { const Icon = TYPE_ICON[k]; return <ToggleButton key={k} value={k}><Icon size={16} />{typeLabel(d.platform, k)}</ToggleButton>; })}
              </ToggleButtonGroup>
            )}
            <TextField label="Name (just for you)" value={form.name} required autoFocus onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <TextField label={`${pf.label} link`} value={form.url} required onChange={(e) => setForm({ ...form, url: e.target.value })}
              slotProps={{ input: { startAdornment: <Box sx={{ mr: 1, display: 'flex', color: 'text.secondary' }}><Link size={16} /></Box> } }} />
            {d.platform === 'facebook' && form.type === 'profile' && (
              <TextField select label="Audience" value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })}>
                {Object.entries(AUDIENCE_LABEL).map(([k, v]) => <MenuItem key={k} value={k}>{v}</MenuItem>)}
              </TextField>
            )}
            <Typography variant="caption" color="text.secondary">Posts already queued here go to the new link.</Typography>
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button color="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={busy || !form.name.trim() || !form.url.trim()}>{busy ? 'Saving…' : 'Save'}</Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

const pickPlatform = (form, platform) => ({ ...form, platform, type: PLATFORMS[platform].types.includes(form.type) ? form.type : PLATFORMS[platform].types[0] });

export default function Destinations() {
  const [list, setList] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(null);
  const [editing, setEditing] = useState(null);

  const load = () => api.destinations().then(setList).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function add(e) {
    e.preventDefault();
    setError('');
    try { await api.addDestination(form); setForm({ ...EMPTY, platform: form.platform, type: form.type }); load(); } catch (err) { setError(err.message); }
  }
  async function update(id, patch) {
    try { await api.updateDestination(id, patch); load(); } catch (err) { setError(err.message); }
  }
  async function confirmRemove() {
    try { await api.removeDestination(removing.id); setRemoving(null); load(); } catch (err) { setError(err.message); }
  }

  // Facebook keeps one panel per type; every other platform gets one panel.
  const grouped = [
    ...['group', 'page', 'profile'].map((t) => [`${typeLabel('facebook', t)}s`, list.filter((d) => d.platform === 'facebook' && d.type === t)]),
    ...Object.keys(PLATFORMS).filter((k) => k !== 'facebook').map((k) => [PLATFORMS[k].label, list.filter((d) => d.platform === k)]),
  ].filter(([, l]) => l.length);
  const pf = PLATFORMS[form.platform];

  return (
    <Box sx={{ display: 'grid', gap: 2.5, gridTemplateColumns: { xs: '1fr', lg: '380px 1fr' }, alignItems: 'start' }}>
      <Panel title="Add a destination" sx={{ position: { lg: 'sticky' }, top: { lg: 24 } }}>
        <Stack component="form" onSubmit={add} spacing={2}>
          <TextField select label="Platform" value={form.platform} onChange={(e) => setForm(pickPlatform(form, e.target.value))}>
            {Object.entries(PLATFORMS).map(([k, v]) => <MenuItem key={k} value={k}><PlatformLabel platform={k} label={v.label} /></MenuItem>)}
          </TextField>
          {pf.types.length > 1 && (
            <ToggleButtonGroup exclusive fullWidth value={form.type} onChange={(_, v) => v && setForm({ ...form, type: v })}
              sx={{ '& .MuiToggleButton-root': { textTransform: 'none', fontWeight: 650, gap: 0.75, borderColor: 'divider' },
                '& .Mui-selected': { bgcolor: '#15171C !important', color: '#fff !important' } }}>
              {pf.types.map((k) => {
                const Icon = TYPE_ICON[k];
                return <ToggleButton key={k} value={k}><Icon size={16} />{typeLabel(form.platform, k)}</ToggleButton>;
              })}
            </ToggleButtonGroup>
          )}
          <TextField label="Name (just for you)" value={form.name} required
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <TextField label={`${pf.label} link`} value={form.url} required placeholder={pf.example}
            helperText={form.platform === 'facebook' ? HINT[form.type] : `e.g. ${pf.example}`} onChange={(e) => setForm({ ...form, url: e.target.value })}
            slotProps={{ input: { startAdornment: <Box sx={{ mr: 1, display: 'flex', color: 'text.secondary' }}><Link size={16} /></Box> } }} />
          {form.platform === 'facebook' && form.type === 'profile' && (
            <TextField select label="Audience" value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })}>
              {Object.entries(AUDIENCE_LABEL).map(([k, v]) => <MenuItem key={k} value={k}>{v}</MenuItem>)}
            </TextField>
          )}
          {!pf.posting && <Alert severity="info">Saved for later — the scheduler can't post to {pf.label} yet.</Alert>}
          {error && <Alert severity="error">{error}</Alert>}
          <Button type="submit" variant="contained" size="large" startIcon={<Plus size={18} />}>
            Add {form.platform === 'facebook' ? '' : `${pf.label} `}{typeLabel(form.platform, form.type).toLowerCase()}
          </Button>
        </Stack>
      </Panel>

      <Stack spacing={2.5} sx={{ minWidth: 0 }}>
        {!list.length && (
          <Paper><EmptyState icon={MapPin} title="No destinations yet">
            <Typography variant="body2">Add as many profiles, Pages, groups and accounts as you like.</Typography>
          </EmptyState></Paper>
        )}
        {grouped.map(([title, items]) => (
          <Panel key={title} title={<PlatformLabel platform={items[0].platform} label={title} size={22} />} action={<Typography variant="caption" color="text.secondary">
            {PLATFORMS[items[0].platform].posting ? items.length : `Posting not available yet · ${items.length}`}</Typography>}>
            <Stack divider={<Box sx={{ borderTop: 1, borderColor: 'divider' }} />}>
              {items.map((d) => (
                <Stack key={d.id} direction="row" alignItems="center" columnGap={1.5} rowGap={1} flexWrap="wrap" useFlexGap
                  sx={{ py: 1.25, opacity: d.enabled ? 1 : 0.5, transition: 'opacity .2s' }}>
                  <TypeBadge type={d.type} withLabel={false} />
                  <Box sx={{ flex: '1 1 180px', minWidth: 0 }}>
                    <Typography fontWeight={700} fontSize={14} noWrap>{d.name}
                      {d.platform !== 'facebook' && d.type !== 'profile' && <Typography component="span" variant="caption" color="text.secondary"> · {typeLabel(d.platform, d.type)}</Typography>}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" noWrap component="div">{d.url.replace(/^https:\/\/(www\.)?/, '')}</Typography>
                  </Box>
                  {d.platform === 'facebook' && d.type === 'profile' && (
                    <TextField select size="small" value={d.audience} onChange={(e) => update(d.id, { audience: e.target.value })} sx={{ width: 150 }}>
                      {Object.entries(AUDIENCE_LABEL).map(([k, v]) => <MenuItem key={k} value={k}>{v}</MenuItem>)}
                    </TextField>
                  )}
                  <Tooltip title={!PLATFORMS[d.platform].posting ? 'Posting to this platform is not available yet'
                    : d.enabled ? 'On — can be picked in Compose' : 'Off — hidden from Compose, queued posts wait'}>
                    <Switch checked={!!d.enabled} onChange={(e) => update(d.id, { enabled: e.target.checked })} />
                  </Tooltip>
                  <Tooltip title={`Open on ${PLATFORMS[d.platform].label}`}>
                    <IconButton size="small" href={d.url} target="_blank" rel="noreferrer"><ExternalLink size={16} /></IconButton>
                  </Tooltip>
                  <Tooltip title="Edit">
                    <IconButton size="small" onClick={() => setEditing(d)}><Pencil size={16} /></IconButton>
                  </Tooltip>
                  <Tooltip title="Remove">
                    <IconButton size="small" onClick={() => setRemoving(d)} sx={{ '&:hover': { color: 'error.main' } }}><Trash2 size={16} /></IconButton>
                  </Tooltip>
                </Stack>
              ))}
            </Stack>
          </Panel>
        ))}
      </Stack>

      <EditDestination d={editing} onClose={() => setEditing(null)} onSaved={load} />
      <Dialog open={!!removing} onClose={() => setRemoving(null)}>
        <DialogTitle sx={{ fontFamily: '"Bricolage Grotesque Variable"', fontWeight: 700 }}>Remove “{removing?.name}”?</DialogTitle>
        <DialogContent><Typography color="text.secondary">Any posts still queued for it will be cancelled. Past results stay in the queue history.</Typography></DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button color="secondary" onClick={() => setRemoving(null)}>Keep it</Button>
          <Button variant="contained" color="error" onClick={confirmRemove}>Remove</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
