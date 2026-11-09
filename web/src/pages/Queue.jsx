import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Chip, Collapse, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Link, MenuItem, Paper, Stack, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import { Ban, ChevronDown, Eye, ImagePlus, Pencil, X, Send, Trash2, CircleCheck, Copy, ExternalLink, Link2, ListChecks, RotateCcw, UserRoundPlus } from 'lucide-react';
import { api, inApp, PLATFORMS, STATUS_LABEL, TYPE_LABEL, formatWhen } from '../api.js';
import { PostPreview } from '../preview.jsx';
import { AccountPic, delayText, EmptyState, JobStatusChip, TypeBadge } from '../components.jsx';

const FILTERS = ['', 'delayed', 'queued', 'awaiting_join', 'needs_login', 'needs_check', 'failed', 'submitted', 'pending_approval', 'cancelled'];
const HAS_POST = new Set(['submitted', 'pending_approval', 'needs_check']);

// Manual override: publishes one queued post right away, skipping its time, the group gap, the daily cap and any pause.
// The person picks who posts it: an account on the destination's platform, or (in a Facebook group) one of its Pages.
const shortUrl = (u) => u.replace(/^https:\/\/(www\.)?/, '').replace(/\/$/, '');
function PostNow({ job, onAction }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [pick, setPick] = useState('');
  const [error, setError] = useState('');
  const platform = job.destination_platform;
  const ownProfile = job.destination_type === 'profile' && accounts.find((a) => a.profile_url === job.destination_url);
  const logins = accounts.filter((a) => !a.page_of);
  const choices = (ownProfile ? [ownProfile] : logins).flatMap((a) => [
    { key: `a${a.id}`, account: a, name: a.name, link: a.profile_url, src: null },
    ...(job.destination_type === 'group' && !ownProfile ? (a.pages || []).map((pg) => ({
      key: `p${pg.id}`, page: pg, account: a, name: pg.name, link: pg.url, sub: `Page · through ${a.name}`,
      src: pg.avatar_v ? `/api/pages/${pg.id}/avatar?v=${pg.avatar_v}` : null })) : []),
  ]);
  useEffect(() => {
    if (!confirm) return;
    setError('');
    api.accounts().then((l) => {
      const mine = l.filter((a) => a.platform === platform);
      setAccounts(mine);
      // Start with whoever posts it now: one of the account's Pages, or the account itself.
      const page = job.post_as && mine.find((a) => a.id === job.account_ref)?.pages?.find((pg) => pg.name === job.post_as);
      setPick(page ? `p${page.id}` : job.account_ref ? `a${job.account_ref}` : '');
    }).catch((e) => setError(e.message));
  }, [confirm]); // eslint-disable-line react-hooks/exhaustive-deps
  if (job.force_now) return <Chip icon={<Send size={14} />} label="Posting next…" color="primary" variant="outlined" />;
  async function go() {
    setBusy(true);
    setError('');
    try {
      await api.postNow(job.id, pick);
      setConfirm(false);
      await onAction(job.id, null);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const label = PLATFORMS[platform]?.label ?? 'Facebook';
  const valid = choices.some((c) => c.key === pick);
  return (
    <>
      <Button variant="contained" startIcon={<Send size={16} />} onClick={() => setConfirm(true)}>Post now</Button>
      <Dialog open={confirm} onClose={() => !busy && setConfirm(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontFamily: '"Bricolage Grotesque Variable"', fontWeight: 700 }}>Post to {job.destination_name} now?</DialogTitle>
        <DialogContent>
          <Typography color="text.secondary">
            It goes out right away, ignoring its scheduled time, the gap between group posts,
            the daily cap and any usage pause. Other queued posts keep their schedule.
          </Typography>
          <TextField select fullWidth label={`Post from · ${label}`} value={valid ? pick : ''}
            onChange={(e) => setPick(e.target.value)} sx={{ mt: 2.5 }}
            helperText={!choices.length ? `Add a ${label} account on the Accounts page first.` : ownProfile ? 'Only this account can post on its own profile.'
              : pick.startsWith('p') ? 'Posts in the group as the Page. The group has to allow Pages.' : null}>
            {choices.map((c) => (
              // Picture, name and link, so similar names can be told apart. Pages sit under their account.
              <MenuItem key={c.key} value={c.key} sx={c.page ? { pl: 4 } : null}>
                <Stack direction="row" alignItems="center" spacing={1.25} sx={{ minWidth: 0 }}>
                  <AccountPic account={c.page ? { id: c.page.id, name: c.name } : c.account} size={c.page ? 28 : 32} {...(c.page ? { src: c.src } : {})} />
                  <Box sx={{ minWidth: 0 }}>
                    <Typography fontSize={c.page ? 14 : 14.5} fontWeight={650} noWrap>
                      {c.name}
                    </Typography>
                    <Typography fontSize={12} color={!c.page && c.account.login_state === 'needs_login' ? 'error' : 'text.secondary'} noWrap>
                      {c.page ? `${c.sub} · ` : c.account.login_state === 'needs_login' ? 'Needs login · ' : ''}{shortUrl(c.link)}
                    </Typography>
                  </Box>
                </Stack>
              </MenuItem>
            ))}
          </TextField>
          {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button color="secondary" disabled={busy} onClick={() => setConfirm(false)}>Not yet</Button>
          <Button variant="contained" disabled={busy || !valid} startIcon={<Send size={16} />} onClick={go}>{busy ? 'Starting…' : 'Post now'}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function PostLinkField({ job, onSaved, autoFocus }) {
  const [value, setValue] = useState(job.post_url || '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => { setValue(job.post_url || ''); }, [job.post_url]);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try { await api.setJobLink(job.id, value); await onSaved(); } catch (err) { setError(err.message); } finally { setSaving(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(job.post_url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  }

  return (
    <Box component="form" onSubmit={save} sx={{ mt: 2 }}>
      <Typography fontSize={13} fontWeight={700} mb={0.75}>Post link</Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        <TextField size="small" fullWidth autoFocus={autoFocus} value={value} onChange={(e) => setValue(e.target.value)}
          placeholder="Paste the post's link (… → Copy link)" error={!!error} helperText={error || undefined}
          slotProps={{ input: { startAdornment: <Box sx={{ mr: 1, display: 'flex', color: 'text.secondary' }}><Link2 size={16} /></Box> } }} />
        <Stack direction="row" spacing={1}>
          <Button type="submit" variant="outlined" color="secondary" disabled={saving || value === (job.post_url || '')}>Save</Button>
          {job.post_url && (
            <Tooltip title={copied ? 'Copied' : 'Copy link'}>
              <IconButton onClick={copy} aria-label="Copy link"><Copy size={16} /></IconButton>
            </Tooltip>
          )}
        </Stack>
      </Stack>
      {!job.post_url && (
        <Typography variant="caption" color="text.secondary" display="block" mt={0.75}>
          Claude couldn't read this post's link. Open the post's ⋯ or share menu → Copy link, then paste it here.
        </Typography>
      )}
    </Box>
  );
}

function RowLink({ job, onAddLink }) {
  if (job.post_url) {
    return (
      <Button size="small" href={inApp(job.post_url, job.account_ref)} target="_blank" rel="noreferrer" endIcon={<ExternalLink size={14} />}
        sx={{ whiteSpace: 'nowrap', fontWeight: 700 }}>
        View post
      </Button>
    );
  }
  if (!HAS_POST.has(job.status)) return <Box />;
  return (
    <Tooltip title="Claude couldn't read the link — add it yourself">
      <Button size="small" color="secondary" startIcon={<Link2 size={14} />} onClick={onAddLink}
        sx={{ whiteSpace: 'nowrap', color: 'text.secondary' }}>
        Add link
      </Button>
    </Tooltip>
  );
}

const EDITABLE = new Set(['queued', 'awaiting_join', 'needs_login', 'failed', 'cancelled']);
const localInput = (iso) => { const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };

// Change a post that hasn't gone out yet: text, first comment and time. Only this destination changes.
function EditPost({ job, open, onClose, onSaved, media }) {
  const [keep, setKeep] = useState(media.map((m) => m.id));
  const [added, setAdded] = useState([]);
  const previews = useMemo(() => added.map((f) => ({ f, url: URL.createObjectURL(f) })), [added]);
  useEffect(() => () => previews.forEach((x) => URL.revokeObjectURL(x.url)), [previews]);
  const [body, setBody] = useState(job.post_body || '');
  const [comment, setComment] = useState(job.first_comment || '');
  const [when, setWhen] = useState(localInput(job.scheduled_at));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setBody(job.post_body || ''); setComment(job.first_comment || ''); setWhen(localInput(job.scheduled_at)); setError('');
      setKeep(media.map((m) => m.id)); setAdded([]);
    }
  }, [open]); // only when it opens: the Queue refreshes every few seconds
  async function save() {
    setBusy(true); setError('');
    try {
      let updated;
      const changes = { body, first_comment: comment, scheduled_at: new Date(when).toISOString() };
      if (added.length || keep.length !== media.length) {
        // Photos changed: send a form with the ones to keep and the new files.
        const form = new FormData();
        Object.entries(changes).forEach(([k, v]) => form.append(k, v));
        form.append('keep_media', JSON.stringify(keep));
        added.forEach((f) => form.append('media', f));
        updated = await api.editJob(job.id, form);
      } else {
        updated = await api.editJob(job.id, changes);
      }
      await onSaved(updated);
      onClose();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onClose={() => !busy && onClose()} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontFamily: '"Bricolage Grotesque Variable"', fontWeight: 700 }}>Edit post · {job.destination_name}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} mt={0.5}>
          <TextField multiline minRows={6} fullWidth label="Post" value={body} onChange={(e) => setBody(e.target.value)} />
          <Box>
            <Typography variant="caption" color="text.secondary" fontWeight={650} display="block" mb={0.75}>Photos or video</Typography>
            <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
              {[...media.filter((m) => keep.includes(m.id)).map((m) => ({ key: `m${m.id}`, url: m.url, video: m.kind === 'video', remove: () => setKeep(keep.filter((id) => id !== m.id)) })),
                ...previews.map((x, i) => ({ key: `a${i}`, url: x.url, video: x.f.type.startsWith('video/'), remove: () => setAdded(added.filter((f) => f !== x.f)) }))]
                .map((t) => (
                  <Box key={t.key} sx={{ position: 'relative', width: 76, height: 76 }}>
                    {t.video
                      ? <video src={t.url} muted style={{ width: 76, height: 76, objectFit: 'cover', borderRadius: 10 }} />
                      : <img src={t.url} alt="" style={{ width: 76, height: 76, objectFit: 'cover', borderRadius: 10 }} />}
                    <IconButton size="small" onClick={t.remove} aria-label="Remove"
                      sx={{ position: 'absolute', top: -8, right: -8, bgcolor: '#15171C', color: '#fff', width: 24, height: 24, '&:hover': { bgcolor: '#000' } }}>
                      <X size={14} />
                    </IconButton>
                  </Box>
                ))}
              <Button component="label" variant="outlined" color="secondary" startIcon={<ImagePlus size={16} />} sx={{ height: 76 }}>
                Add
                <input hidden type="file" multiple accept="image/*,video/*"
                  onChange={(e) => { setAdded([...added, ...e.target.files]); e.target.value = ''; }} />
              </Button>
            </Stack>
          </Box>
          <TextField multiline minRows={2} fullWidth label="First comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
          <TextField type="datetime-local" fullWidth label="When" value={when} onChange={(e) => setWhen(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ p: 2 }}>
        <Button color="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={busy || !when}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}

function JobDetail({ job, onAction, onSaved, focusLink }) {
  const [editing, setEditing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const removed = Boolean(job.destination_archived);
  const [log, setLog] = useState(null);
  const [media, setMedia] = useState([]);
  useEffect(() => {
    api.jobLog(job.id).then(setLog).catch(() => {});
    api.postMedia(job.post_id).then(setMedia).catch(() => {});
  }, [job.id, job.post_id]);

  return (
    <Box sx={{ px: { xs: 2, md: 2.5 }, pb: 2.5, pt: 0.5 }}>
      <Box sx={{ p: 2, borderRadius: 2.5, bgcolor: 'background.default' }}>
        <Typography sx={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{job.post_body || '(no text)'}</Typography>
        {job.first_comment && (
          <Box sx={{ mt: 1.5, pt: 1.5, borderTop: 1, borderColor: 'divider' }}>
            <Typography variant="caption" color="text.secondary" fontWeight={700}>First comment</Typography>
            <Typography sx={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{job.first_comment}</Typography>
          </Box>
        )}
        {media.length > 0 && (
          <Stack direction="row" gap={1} mt={1.5} flexWrap="wrap">
            {media.map((m) => {
              const style = { width: 72, height: 72, objectFit: 'cover', borderRadius: 10 };
              return m.kind === 'video' ? <video key={m.id} src={m.url} muted style={style} /> : <img key={m.id} src={m.url} alt="" style={style} />;
            })}
          </Stack>
        )}
      </Box>
      {(job.account_name || (job.destination_platform === 'facebook' && job.destination_type === 'group')) && (
        <Typography variant="caption" color="text.secondary" display="block" mt={1}>
          {job.account_name && <>Account <strong>{job.account_name}</strong></>}
          {job.account_name && job.destination_platform === 'facebook' && job.destination_type === 'group' && ' · '}
          {job.destination_platform === 'facebook' && job.destination_type === 'group' && (
            <>Posts as <strong>{job.post_as === '@self' ? 'you' : job.post_as || job.destination_post_as || 'you'}</strong></>
          )}
        </Typography>
      )}
      {job.delay && <Alert severity="warning" sx={{ mt: 1.5 }}><b>Delayed.</b> {delayText(job.delay)}</Alert>}
      {job.last_error && <Alert severity={job.status === 'needs_login' ? 'warning' : 'error'} sx={{ mt: 1.5 }}>{job.last_error}</Alert>}
      {job.status === 'awaiting_join' && (
        <Alert severity="info" icon={<UserRoundPlus size={20} />} sx={{ mt: 1.5 }}>
          <strong>Asked to join {job.destination_name}{job.join_requested_at ? ` on ${formatWhen(job.join_requested_at)}` : ''}.</strong>{' '}
          The group's admin hasn't accepted the request yet, so nothing has been posted. The autoposter checks again
          at {formatWhen(job.scheduled_at)} and posts as soon as the account is in. If the admin never accepts, it stops
          after the wait set in Settings and marks the post Failed.
        </Alert>
      )}
      {job.status === 'pending_approval' && !job.last_error && (
        <Alert severity="info" sx={{ mt: 1.5 }}>
          The group's admins have to approve this post. {job.next_check_at
            ? <>Claude looks again at {formatWhen(job.next_check_at)} and marks it Posted once it's live{job.first_comment ? ', then adds the first comment' : ''}.</>
            : <>If it's live now, mark it below.</>}
        </Alert>
      )}
      {job.status === 'needs_check' && (
        <Alert severity="warning" sx={{ mt: 1.5 }}>
          Claude may or may not have posted this. Check the post's page first; retrying a post that already went out will duplicate it.
        </Alert>
      )}
      {log?.result && (
        <Box component="details" sx={{ mt: 1.5, '& summary': { cursor: 'pointer', fontWeight: 650, fontSize: 13, color: 'text.secondary' } }}>
          <summary>Claude's report{log.num_turns ? ` · ${log.num_turns} steps, ${Math.round(log.duration_ms / 1000)}s` : ''}</summary>
          <Box component="pre" sx={{ whiteSpace: 'pre-wrap', fontSize: 12, p: 1.5, mt: 1, borderRadius: 2, bgcolor: '#15171C', color: '#E8E6E1', maxHeight: 280, overflow: 'auto' }}>
            {log.result}
          </Box>
        </Box>
      )}
      {removed && (
        <Alert severity="info" sx={{ mt: 1.5 }}>
          You removed {job.destination_name} from Destinations, so this can't be posted again. Add the destination back to post there.
        </Alert>
      )}
      <Stack direction="row" spacing={1} mt={2} flexWrap="wrap" useFlexGap>
        {!removed && ['queued', 'awaiting_join'].includes(job.status) && <PostNow job={job} onAction={onAction} />}
        <Button variant="outlined" color="secondary" startIcon={<Eye size={16} />} onClick={() => setPreviewing(true)}>Preview</Button>
        {previewing && <PostPreview job={job} onClose={() => setPreviewing(false)} />}
        {!removed && EDITABLE.has(job.status) && (
          <Button variant="outlined" color="secondary" startIcon={<Pencil size={16} />} onClick={() => setEditing(true)}>Edit</Button>
        )}
        {editing && <EditPost job={job} media={media} open={editing} onClose={() => setEditing(false)} onSaved={async (updated) => { await onSaved(); if (updated) api.postMedia(updated.post_id).then(setMedia).catch(() => {}); }} />}
        {!removed && job.status === 'awaiting_join' && <Button variant="outlined" color="secondary" startIcon={<RotateCcw size={16} />} onClick={() => onAction(job.id, 'retry')}>Check now</Button>}
        {['queued', 'awaiting_join', 'needs_login'].includes(job.status) && <Button variant="outlined" color="secondary" startIcon={<Ban size={16} />} onClick={() => onAction(job.id, 'cancel')}>Cancel</Button>}
        {job.status === 'pending_approval' && <Button variant="contained" color="success" startIcon={<CircleCheck size={16} />} onClick={() => onAction(job.id, 'mark-posted')}>It's live</Button>}
        {!removed && job.status === 'pending_approval' && (
          <Button variant="outlined" color="secondary" startIcon={<RotateCcw size={16} />} onClick={() => onAction(job.id, 'check-approval')}>Check now</Button>
        )}
        {job.status === 'needs_check' && <Button variant="contained" color="success" startIcon={<CircleCheck size={16} />} onClick={() => onAction(job.id, 'mark-posted')}>It posted</Button>}
        {!removed && ['failed', 'needs_check', 'cancelled'].includes(job.status) && (
          <Button variant="outlined" color="secondary" startIcon={<RotateCcw size={16} />} onClick={() => onAction(job.id, 'retry')}>
            {job.status === 'needs_check' ? "It didn't post — retry now" : 'Retry now'}
          </Button>
        )}
        {['failed', 'cancelled'].includes(job.status) && (
          <Tooltip title="Clears this from the Queue, with Claude's report. Nothing changes on the social network.">
            <Button variant="outlined" color="error" startIcon={<Trash2 size={16} />} onClick={() => onAction(job.id, 'remove')}>Remove</Button>
          </Tooltip>
        )}
        {!job.post_url && HAS_POST.has(job.status) && (
            <Tooltip title="Claude couldn't read this post's own link, so this opens where it was posted">
              <Button href={inApp(job.destination_url, job.account_ref)} target="_blank" rel="noreferrer" color="secondary" endIcon={<ExternalLink size={15} />}>
                Open {TYPE_LABEL[job.destination_type].toLowerCase()}
              </Button>
            </Tooltip>
          )}
      </Stack>
      {HAS_POST.has(job.status) && <PostLinkField job={job} onSaved={onSaved} autoFocus={focusLink} />}
    </Box>
  );
}

// Still to post (running first, then soonest) on top; finished posts below, newest first.
const UPCOMING = { running: 0, queued: 1, awaiting_join: 1, needs_login: 1 };
function queueOrder(list) {
  return [...list].sort((a, b) => {
    const ua = UPCOMING[a.status], ub = UPCOMING[b.status];
    if ((ua ?? 2) !== (ub ?? 2)) return (ua ?? 2) - (ub ?? 2);
    return ua !== undefined ? a.scheduled_at.localeCompare(b.scheduled_at) : b.scheduled_at.localeCompare(a.scheduled_at);
  });
}

export default function Queue({ onChange, initialFilter = '' }) {
  const [jobs, setJobs] = useState([]);
  const [filter, setFilter] = useState(initialFilter);
  const [open, setOpen] = useState(null);
  const [focusLink, setFocusLink] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => api.jobs(filter).then((l) => setJobs(queueOrder(l))).catch((e) => setError(e.message)), [filter]);
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  async function onAction(id, action) {
    setError('');
    try {
      if (action === 'remove') { await api.removeJob(id); setOpen(null); } else if (action) await api.jobAction(id, action); // null: already done, just refresh
      await load();
      onChange();
    } catch (e) { setError(e.message); }
  }

  return (
    <Stack spacing={2}>
      <Box sx={{ overflowX: 'auto' }}>
        <ToggleButtonGroup exclusive size="small" value={filter} onChange={(_, v) => v !== null && setFilter(v)}
          sx={{ bgcolor: '#fff', '& .MuiToggleButton-root': { textTransform: 'none', fontWeight: 650, px: 1.75, borderColor: 'divider', whiteSpace: 'nowrap' },
            '& .Mui-selected': { bgcolor: '#15171C !important', color: '#fff !important' } }}>
          {FILTERS.map((f) => <ToggleButton key={f} value={f}>{f ? STATUS_LABEL[f] : 'All'}</ToggleButton>)}
        </ToggleButtonGroup>
      </Box>
      {error && <Alert severity="error">{error}</Alert>}

      <Paper sx={{ overflow: 'hidden' }}>
        {!jobs.length && <EmptyState icon={ListChecks} title="Nothing here yet" />}
        {jobs.map((j, i) => {
          const isOpen = open === j.id;
          return (
            <Box key={j.id} sx={{ borderTop: i ? 1 : 0, borderColor: 'divider', bgcolor: isOpen ? '#FCFBF8' : 'transparent' }}>
              <Stack direction="row" alignItems="center" sx={{ pr: { xs: 1.5, md: 2 }, '&:hover': { bgcolor: '#FCFBF8' } }}>
              <Box role="button" tabIndex={0} aria-expanded={isOpen}
                onClick={() => { setFocusLink(false); setOpen(isOpen ? null : j.id); }}
                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setFocusLink(false); setOpen(isOpen ? null : j.id); } }}
                sx={{ all: 'unset', boxSizing: 'border-box', flex: 1, minWidth: 0, cursor: 'pointer', display: 'grid', alignItems: 'center',
                  gap: { xs: 1, md: 2 }, pl: { xs: 2, md: 2.5 }, pr: 1, py: 1.75, '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
                  gridTemplateColumns: { xs: 'auto 1fr', md: '150px 190px minmax(0,1fr) minmax(0,1.4fr)' } }}>
                <Box><JobStatusChip job={j} /></Box>
                <Box sx={{ display: { xs: 'none', md: 'block' } }}>
                  <Typography fontSize={13} fontWeight={600}>{formatWhen(j.scheduled_at)}</Typography>
                  {Boolean(j.destination_archived) && <Chip size="small" label="Destination removed" sx={{ mt: 0.5, height: 20, fontSize: 11 }} />}
                </Box>
                <Stack direction="row" alignItems="center" spacing={1.25} sx={{ minWidth: 0 }}>
                  <TypeBadge type={j.destination_type} withLabel={false} />
                  <Tooltip title={`Open on ${PLATFORMS[j.destination_platform]?.label ?? 'Facebook'}`}>
                    <Link href={inApp(j.destination_url, j.account_ref)} target="_blank" rel="noreferrer" color="inherit" underline="hover" noWrap
                      onClick={(e) => e.stopPropagation()} sx={{ fontWeight: 700, fontSize: 14, minWidth: 0 }}>
                      {j.destination_name}
                    </Link>
                  </Tooltip>
                </Stack>
                <Box sx={{ display: { xs: 'none', md: 'block' }, minWidth: 0 }}>
                  <Typography fontSize={13} color="text.secondary" noWrap>{j.post_body}</Typography>
                  {j.delay && <Typography fontSize={12.5} fontWeight={600} color="#B54708" noWrap title={delayText(j.delay)}>{delayText(j.delay)}</Typography>}
                </Box>
              </Box>
              <Box sx={{ width: { xs: 'auto', md: 116 }, display: 'flex', justifyContent: 'flex-end', flex: 'none' }}>
                <RowLink job={j} onAddLink={() => { setFocusLink(true); setOpen(j.id); }} />
              </Box>
              <IconButton size="small" onClick={() => { setFocusLink(false); setOpen(isOpen ? null : j.id); }}
                aria-label={isOpen ? 'Collapse' : 'Expand'} sx={{ ml: 0.5, transition: 'transform .2s', transform: isOpen ? 'rotate(180deg)' : 'none' }}>
                <ChevronDown size={18} />
              </IconButton>
              </Stack>
              <Collapse in={isOpen} unmountOnExit>{isOpen && <JobDetail job={j} onAction={onAction} onSaved={load} focusLink={focusLink} />}</Collapse>
            </Box>
          );
        })}
      </Paper>
    </Stack>
  );
}
